// Fictional data and an in-memory protocol simulator. No live Auth or backend.
import test from "node:test";
import assert from "node:assert/strict";
import { blank, demoTrip, uid, mergeBackup, validate } from "../model.js";
import { portableBackup, readPortableBackup } from "../attachments.js";
import { SyncEngine } from "../sync-engine.js";
import {
  clone,
  emptyDocument,
  checkDocument,
  checkManifests,
  mergeDocuments,
  mergeFirstJoin,
  sameContents,
  sha256,
  PROJECT_URL,
} from "../sync-model.js";
import {
  authConfigurationReady,
  configurationReady,
  takeAuthCallback,
  appScope,
} from "../sync-provider.js";
import { cloudCSP } from "../scripts/build-site.js";
const OWNER = "11111111-1111-4111-8111-111111111111",
  OTHER = "22222222-2222-4222-8222-222222222222";
export const fictionalPlanner = () => ({ version: 1, trips: [demoTrip()] });
const png = () =>
  new Blob(
    [
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      ),
    ],
    { type: "image/png" },
  );
const ids = (d) =>
  d.planner.trips
    .flatMap((t) => [
      t.id,
      ...["items", "packing", "expenses", "budgets", "links"].flatMap((k) =>
        t[k].map((e) => e.id),
      ),
    ])
    .concat(d.files.map((f) => f.id));
const fail = (code) =>
  Object.assign(Error("Simulated private operation failure."), { code });
class MemoryStore {
  bound = null;
  saved = null;
  failSave = false;
  async binding() {
    return this.bound ? { ownerId: this.bound } : null;
  }
  async bind(owner) {
    if (this.bound && this.bound !== owner) throw fail("owner");
    this.bound = owner;
  }
  async load(owner) {
    return this.saved?.ownerId === owner ? clone(this.saved) : null;
  }
  async save(state, generation) {
    if (this.failSave) throw Error("Simulated quota failure.");
    if ((this.saved?.generation || 0) !== generation) throw fail("another-tab");
    this.saved = clone({ ...state, generation: generation + 1 });
    return clone(this.saved);
  }
}
class Bridge {
  constructor(planner = blank(), records = []) {
    this.planner = clone(planner);
    this.records = clone(records);
    this.version = 0;
    this.failApply = false;
  }
  async snapshot() {
    return {
      planner: clone(this.planner),
      records: clone(this.records),
      token: this.version,
    };
  }
  async apply(local, token) {
    if (this.failApply) throw Error("Simulated local projection failure.");
    assert.equal(token, this.version, "Stale bridge projection");
    this.planner = clone(local.planner);
    this.records = clone(local.records);
    this.version++;
  }
  edit(fn) {
    fn(this.planner);
    validate(this.planner);
    this.version++;
  }
}
class Backend {
  document = emptyDocument();
  objects = new Map();
  reserved = new Map();
  calls = [];
  commitHook = null;
  uploadFailAck = false;
  downloadHook = null;
  external(fn) {
    const before = ids(this.document),
      next = clone(this.document);
    fn(next);
    const remaining = new Set(ids(next));
    next.deletedIds = [
      ...new Set([
        ...next.deletedIds,
        ...before.filter((id) => !remaining.has(id)),
      ]),
    ];
    next.revision = String(BigInt(next.revision) + 1n);
    this.document = checkDocument(next);
  }
  provider(owner = OWNER) {
    const backend = this;
    return {
      identity: owner,
      async assertOwner(expected) {
        backend.calls.push("identity");
        if (this.identity !== expected) throw fail("owner");
      },
      async read(expected) {
        await this.assertOwner(expected);
        backend.calls.push("read");
        return clone(backend.document);
      },
      async commit(expected, revision, document) {
        await this.assertOwner(expected);
        backend.calls.push("commit");
        if (backend.commitHook) {
          const hook = backend.commitHook;
          backend.commitHook = null;
          await hook();
        }
        if (revision !== backend.document.revision) throw fail("40001");
        for (const f of document.files) {
          if (!backend.objects.has(f.objectId))
            throw Error("Unuploaded reference");
        }
        backend.external((d) => {
          d.planner = clone(document.planner);
          d.files = clone(document.files);
        });
        return backend.document.revision;
      },
      async reserve(expected, file) {
        await this.assertOwner(expected);
        backend.calls.push("reserve");
        const old = backend.reserved.get(file.objectId);
        if (old) assert.equal(old.sha256, file.sha256);
        else backend.reserved.set(file.objectId, clone(file));
      },
      async upload(expected, file, blob) {
        await this.assertOwner(expected);
        backend.calls.push("upload");
        if (backend.objects.has(file.objectId)) throw fail("409");
        backend.objects.set(file.objectId, blob);
        if (backend.uploadFailAck) {
          backend.uploadFailAck = false;
          throw fail("network");
        }
      },
      async download(expected, file) {
        await this.assertOwner(expected);
        backend.calls.push("download");
        if (backend.downloadHook) await backend.downloadHook();
        const bytes = backend.objects.get(file.objectId);
        if (!bytes) throw fail("404");
        return bytes;
      },
      async listObjects(expected) {
        await this.assertOwner(expected);
        return [...backend.reserved].map(([objectId, f]) => ({
          objectId,
          size: f.size,
          type: f.type,
          createdAt: "2026-10-09T00:00:00Z",
        }));
      },
      async remove(expected, id) {
        await this.assertOwner(expected);
        if (backend.document.files.some((f) => f.objectId === id))
          throw fail("42501");
        backend.calls.push("remove");
        backend.objects.delete(id);
      },
      async release(expected, id) {
        await this.assertOwner(expected);
        if (
          backend.objects.has(id) ||
          backend.document.files.some((f) => f.objectId === id)
        )
          throw fail("42501");
        backend.calls.push("release");
        backend.reserved.delete(id);
      },
    };
  }
}
function device(
  backend,
  planner = blank(),
  records = [],
  store = new MemoryStore(),
) {
  const bridge = new Bridge(planner, records),
    provider = backend.provider(),
    network = { online: true };
  const engine = new SyncEngine({
    provider,
    store,
    bridge,
    online: () => network.online,
  });
  return { engine, bridge, provider, store, network };
}
async function joined(
  backend = new Backend(),
  planner = fictionalPlanner(),
  records = [],
) {
  const d = device(backend, planner, records);
  await d.engine.connect(OWNER);
  await d.engine.syncNow();
  return { ...d, backend };
}
async function attachment(planner) {
  const blob = png();
  return {
    id: uid(),
    tripId: planner.trips[0].id,
    planId: planner.trips[0].items[0].id,
    name: "fictional.png",
    type: blob.type,
    size: blob.size,
    blob,
  };
}

test("release gate is disabled by default; rejects partial setup and secret/JWT keys", () => {
  const ready = {
    authEnabled: true,
    enabled: true,
    policiesVerified: true,
    projectUrl: PROJECT_URL,
    publishableKey: "sb_publishable_fictional_local_only",
  };
  assert(configurationReady(ready));
  assert.equal(cloudCSP(ready), "connect-src " + PROJECT_URL);
  const authOnly = { ...ready, enabled: false, policiesVerified: false };
  assert(authConfigurationReady(authOnly));
  assert(!configurationReady(authOnly));
  assert.equal(cloudCSP(authOnly), "connect-src " + PROJECT_URL);
  for (const config of [
    { ...ready, policiesVerified: false },
    { ...ready, authEnabled: false },
    { ...authOnly, policiesVerified: true },
    { ...authOnly, publishableKey: "sb_secret_fictional" },
    { ...ready, publishableKey: "sb_secret_fictional" },
    { ...ready, projectUrl: "https://other.example" },
    { ...ready, secret: "fictional must be rejected" },
  ]) {
    assert(!configurationReady(config));
    assert.throws(() => cloudCSP(config));
  }
  assert.equal(
    cloudCSP({
      authEnabled: false,
      enabled: false,
      policiesVerified: false,
      projectUrl: "",
      publishableKey: "",
    }),
    "connect-src 'none'",
  );
});
test("Auth callback parameters are removed before exchange; implicit tokens are never accepted", () => {
  assert.equal(
    appScope("https://fictional.example/Trip-Planner-/index.html"),
    appScope("https://fictional.example/Trip-Planner-/"),
  );
  let replaced;
  const out = takeAuthCallback(
    {
      href:
        "https://fictional.example/Trip-Planner-/?code=fictional&sb_flow_id=" +
        OWNER +
        "&keep=ok#access_token=fictional&refresh_token=fictional",
    },
    { replaceState: (_a, _b, url) => (replaced = url) },
  );
  assert.deepEqual(out, { code: "fictional", flowId: OWNER, failed: false });
  assert.equal(replaced, "/Trip-Planner-/?keep=ok");
  assert.equal(
    takeAuthCallback(
      { href: "https://fictional.example/?code=" + "x".repeat(2049) },
      { replaceState() {} },
    ).code,
    null,
  );
});
test("cloud snapshots reject invalid manifests, unsafe URLs, oversized revisions and live tombstones", async () => {
  const p = fictionalPlanner(),
    r = await attachment(p),
    manifest = {
      version: 1,
      ...r,
      sha256: await sha256(r.blob),
      objectId: uid(),
    };
  delete manifest.blob;
  const d = { ...emptyDocument(), planner: p, files: [manifest] };
  checkDocument(d);
  for (const mutate of [
    (x) => (x.revision = "9223372036854775808"),
    (x) => (x.files[0].objectId = "../../other"),
    (x) => (x.files[0].name = "../unsafe.png"),
    (x) => (x.planner.trips[0].items[0].bookingURL = "javascript:alert(1)"),
    (x) => (x.deletedIds = [p.trips[0].id]),
    (x) => (x.files[0].owner = OTHER),
  ]) {
    const bad = clone(d);
    mutate(bad);
    assert.throws(() => checkDocument(bad));
  }
  d.revision = "9223372036854775807";
  checkDocument(d);
});
test("independent fields and additions merge; scalar conflicts preserve versions with fresh-copy resolution", () => {
  const base = { ...emptyDocument(), planner: fictionalPlanner() },
    local = clone(base),
    remote = clone(base),
    id = base.planner.trips[0].id;
  local.planner.trips[0].notes = "Fictional device edit";
  remote.planner.trips[0].name = "Fictional cloud edit";
  let m = mergeDocuments(base, local, remote);
  assert.equal(m.conflicts.length, 0);
  assert.equal(m.planner.trips[0].notes, "Fictional device edit");
  assert.equal(m.planner.trips[0].name, "Fictional cloud edit");
  remote.planner.trips[0].notes = "Competing fictional edit";
  m = mergeDocuments(base, local, remote);
  assert.equal(m.conflicts.length, 1);
  m = mergeDocuments(base, local, remote, { [id]: "copy" });
  assert.equal(m.conflicts.length, 0);
  assert.equal(m.planner.trips.length, 2);
  assert.notEqual(m.planner.trips[1].id, id);
  assert.equal(m.planner.trips[1].notes, "Fictional device edit");
});
test("global ID collisions across parallel trip additions require fresh-copy choice", () => {
  const base = emptyDocument(),
    local = { ...emptyDocument(), planner: fictionalPlanner() },
    remote = { ...emptyDocument(), planner: fictionalPlanner() };
  const old = local.planner.trips[0].items[0].id;
  local.planner.trips[0].items[0].id = remote.planner.trips[0].items[0].id;
  for (const e of local.planner.trips[0].expenses)
    if (e.planId === old) e.planId = local.planner.trips[0].items[0].id;
  assert.equal(mergeDocuments(base, local, remote).conflicts.length, 1);
  assert.equal(
    mergeDocuments(base, local, remote, { [local.planner.trips[0].id]: "copy" })
      .planner.trips.length,
    2,
  );
});
test("first join deduplicates fresh-ID imported copies including byte hashes; edited copies survive", async () => {
  const p = fictionalPlanner(),
    r = await attachment(p),
    d = {
      ...emptyDocument(),
      planner: p,
      files: [
        { version: 1, ...r, sha256: await sha256(r.blob), objectId: uid() },
      ],
    };
  delete d.files[0].blob;
  const { planner, attachments } = await readPortableBackup(
    await portableBackup(p, [r]),
  );
  const local = {
    planner,
    files: attachments.map((f) => {
      const x = {
        version: 1,
        ...f,
        sha256: d.files[0].sha256,
        objectId: uid(),
      };
      delete x.blob;
      return x;
    }),
  };
  const imported = mergeBackup(blank(), local.planner);
  local.planner = imported;
  local.files[0].tripId = imported.trips[0].id;
  local.files[0].planId = imported.trips[0].items[0].id;
  assert.equal(mergeFirstJoin(local, d).duplicates, 1);
  local.planner.trips[0].notes += " Edited";
  assert.equal(mergeFirstJoin(local, d).planner.trips.length, 2);
});
test("two same-owner devices converge through join, push, pull and explicit offline queue", async () => {
  const a = await joined(),
    b = device(a.backend);
  await b.engine.connect(OWNER);
  await b.engine.syncNow();
  assert.deepEqual(b.bridge.planner, a.bridge.planner);
  a.network.online = false;
  a.bridge.edit((p) => (p.trips[0].notes = "Fictional offline note"));
  const writes = a.backend.calls.filter((c) => c === "commit").length;
  await a.engine.syncNow();
  assert.equal(a.engine.status.kind, "pending");
  assert.equal(a.backend.calls.filter((c) => c === "commit").length, writes);
  b.bridge.edit((p) => (p.trips[0].name = "Fictional other device"));
  await b.engine.syncNow();
  a.network.online = true;
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.deepEqual(b.bridge.planner, a.bridge.planner);
  assert.equal(a.bridge.planner.trips[0].notes, "Fictional offline note");
  assert.equal(a.bridge.planner.trips[0].name, "Fictional other device");
});
test("CAS conflicts keep durable pending edits; lost commit acknowledgement retries without duplicates", async () => {
  const d = await joined();
  d.bridge.edit((p) => (p.trips[0].notes = "Fictional edit"));
  d.backend.commitHook = () =>
    d.backend.external((s) => (s.planner.trips[0].name = "Concurrent cloud"));
  await assert.rejects(d.engine.syncNow(), (e) => e.code === "40001");
  assert.equal(d.engine.status.kind, "pending");
  assert.equal(d.store.saved.local.planner.trips[0].notes, "Fictional edit");
  await d.engine.syncNow();
  assert.equal(d.bridge.planner.trips[0].name, "Concurrent cloud");
  const commit = d.provider.commit;
  d.provider.commit = async (...args) => {
    await commit.apply(d.provider, args);
    throw fail("network");
  };
  d.bridge.edit((p) => (p.trips[0].notes = "Lost acknowledgement"));
  await assert.rejects(d.engine.syncNow());
  d.provider.commit = commit;
  await d.engine.syncNow();
  assert.equal(d.backend.document.planner.trips.length, 1);
  assert.equal(d.engine.status.kind, "synced");
});
test("competing edits survive journal reload; stale choices never overwrite a changed cloud revision", async () => {
  const d = await joined(),
    id = d.bridge.planner.trips[0].id;
  d.bridge.edit((p) => (p.trips[0].notes = "Device version"));
  d.backend.external((s) => (s.planner.trips[0].notes = "Cloud version"));
  await d.engine.syncNow();
  assert.equal(d.engine.status.kind, "conflict");
  const recovery = await readPortableBackup(await d.engine.recoveryBackup());
  assert.equal(recovery.planner.trips[0].notes, "Device version");
  const resumed = new SyncEngine({
    provider: d.provider,
    store: d.store,
    bridge: d.bridge,
  });
  await resumed.attach(OWNER);
  assert.equal(resumed.status.kind, "conflict");
  d.backend.external((s) => (s.planner.trips[0].notes = "New cloud version"));
  await resumed.resolve({ [id]: "cloud" });
  assert.equal(resumed.status.kind, "conflict");
  assert.equal(d.bridge.planner.trips[0].notes, "Device version");
  await resumed.resolve({ [id]: "copy" });
  assert.equal(
    d.bridge.planner.trips.length,
    2,
    "resolved device should have both copies",
  );
  await resumed.syncNow();
  assert.equal(d.backend.document.planner.trips.length, 2);
  assert.equal(
    d.backend.document.planner.trips.find((t) => t.id === id).notes,
    "New cloud version",
  );
});
test("cloud deletion versus offline edit restores only with fresh IDs and never resurrects tombstones", async () => {
  const d = await joined(),
    id = d.bridge.planner.trips[0].id;
  d.bridge.edit((p) => (p.trips[0].notes = "Offline after deletion"));
  d.backend.external((s) => (s.planner.trips = []));
  await d.engine.syncNow();
  assert.equal(d.engine.status.kind, "conflict");
  await d.engine.resolve({ [id]: "copy" });
  await d.engine.syncNow();
  assert.equal(d.backend.document.planner.trips.length, 1);
  assert.notEqual(d.backend.document.planner.trips[0].id, id);
  assert(d.backend.document.deletedIds.includes(id));
});
test("verified-owner mismatch and account switching never transmit local plans to another account", async () => {
  const d = await joined();
  d.provider.identity = OTHER;
  const before = d.backend.calls.filter((c) => c === "commit").length;
  await assert.rejects(d.engine.syncNow(), (e) => e.code === "owner");
  assert.equal(d.engine.status.kind, "permission");
  await assert.rejects(d.engine.connect(OTHER), (e) => e.code === "owner");
  assert.equal(d.backend.calls.filter((c) => c === "commit").length, before);
  assert.equal(d.bridge.planner.trips.length, 1);
});
test("signout during a request pauses commit and preserves the owner-bound offline journal", async () => {
  const d = await joined();
  d.bridge.edit((p) => (p.trips[0].notes = "Queued before signout"));
  const read = d.provider.read;
  d.provider.read = async (...args) => {
    const value = await read.apply(d.provider, args);
    d.engine.pause();
    return value;
  };
  const before = d.backend.calls.filter((c) => c === "commit").length;
  await d.engine.syncNow();
  assert.equal(d.backend.calls.filter((c) => c === "commit").length, before);
  assert.equal(
    d.store.saved.local.planner.trips[0].notes,
    "Queued before signout",
  );
  assert.equal(d.engine.owner, null);
  assert.equal(
    (await readPortableBackup(await d.engine.recoveryBackup())).planner.trips[0]
      .notes,
    "Queued before signout",
  );
});
test("verified file upload handles a lost acknowledgement, restores on another device and repairs missing bytes", async () => {
  const p = fictionalPlanner(),
    r = await attachment(p),
    backend = new Backend();
  backend.uploadFailAck = true;
  const d = await joined(backend, p, [r]);
  assert.equal(backend.document.files.length, 1);
  assert.equal(backend.calls.filter((c) => c === "upload").length, 1);
  const old = backend.document.files[0].objectId;
  const b = device(backend);
  await b.engine.connect(OWNER);
  await b.engine.syncNow();
  assert.equal(await sha256(b.bridge.records[0].blob), await sha256(r.blob));
  backend.objects.delete(old);
  await assert.rejects(
    d.engine.syncNow({ verifyFiles: true }),
    (e) => e.code === "file-recovery",
  );
  assert.equal(d.engine.status.kind, "file-recovery");
  assert.equal(await d.engine.repairFiles(), 1);
  assert.notEqual(backend.document.files[0].objectId, old);
  assert.equal(backend.document.files[0].id, d.bridge.records[0].id);
  assert.equal(await sha256(d.bridge.records[0].blob), await sha256(r.blob));
});
test("corrupt cloud signatures are repairable; healthy byte checks never falsely claim pending text synced", async () => {
  const p = fictionalPlanner(),
    r = await attachment(p),
    d = await joined(new Backend(), p, [r]);
  d.backend.objects.set(
    d.backend.document.files[0].objectId,
    new Blob(["bad"], { type: "image/png" }),
  );
  await assert.rejects(
    d.engine.syncNow({ verifyFiles: true }),
    (e) => e.code === "file-recovery",
  );
  assert.equal(await d.engine.repairFiles(), 1);
  d.bridge.edit((x) => (x.trips[0].notes = "Unsynced device edit"));
  assert.equal(await d.engine.repairFiles(), 0);
  assert.equal(d.engine.status.kind, "pending");
});
test("journal failure prevents upload; failed device projection retains original bytes in recovery", async () => {
  const p = fictionalPlanner(),
    r = await attachment(p),
    backend = new Backend(),
    d = device(backend, p, [r]);
  d.store.failSave = true;
  await assert.rejects(d.engine.connect(OWNER));
  assert(!backend.calls.includes("reserve"));
  assert(!backend.calls.includes("commit"));
  assert.deepEqual(d.bridge.planner, p);
  d.store.failSave = false;
  d.bridge.failApply = true;
  await assert.rejects(d.engine.connect(OWNER));
  assert.equal(d.engine.status.kind, "recovery");
  const backup = await readPortableBackup(await d.engine.recoveryBackup());
  assert.deepEqual(backup.planner, p);
  assert.equal(await sha256(backup.attachments[0].blob), await sha256(r.blob));
  d.bridge.failApply = false;
  await d.engine.restoreRecovery();
  assert.equal(d.engine.state.joined, false);
  assert.deepEqual(d.bridge.planner, p);
});
test("edits made during a successful commit preserve both queued work and cloud additions", async () => {
  const d = await joined();
  d.backend.external((s) =>
    s.planner.trips[0].links.push({
      id: uid(),
      title: "Fictional info",
      url: "https://example.com/",
    }),
  );
  d.bridge.edit((p) => (p.trips[0].name = "Device name"));
  d.backend.commitHook = () =>
    d.bridge.edit((p) => (p.trips[0].notes = "Edited while saving"));
  await d.engine.syncNow();
  assert.equal(d.engine.status.kind, "pending");
  assert.equal(
    d.bridge.planner.trips[0].links.length,
    d.backend.document.planner.trips[0].links.length,
  );
  assert.equal(d.bridge.planner.trips[0].notes, "Edited while saving");
  await d.engine.syncNow();
  assert.equal(d.engine.status.kind, "synced");
});
test("unused-file cleanup refuses live/pending/foreign IDs and releases only explicit abandoned uploads", async () => {
  const p = fictionalPlanner(),
    r = await attachment(p),
    d = await joined(new Backend(), p, [r]);
  const live = d.backend.document.files[0].objectId;
  await assert.rejects(d.engine.cleanup([live]));
  await assert.rejects(d.engine.cleanup([uid()]));
  const orphan = { ...d.backend.document.files[0], objectId: uid() };
  d.backend.reserved.set(orphan.objectId, orphan);
  d.backend.objects.set(orphan.objectId, r.blob);
  assert.equal(await d.engine.cleanup([orphan.objectId]), 1);
  assert(!d.backend.reserved.has(orphan.objectId));
  assert(d.backend.objects.has(live));
});
test("missing-file repair preserves offline text, independent cloud additions, and pending deletion/file edits", async () => {
  const p = fictionalPlanner(),
    r = await attachment(p),
    d = await joined(new Backend(), p, [r]);
  d.bridge.edit((x) => {
    x.trips[0].notes = "Fictional pending device change";
    x.trips[0].packing.pop();
  });
  d.backend.external((x) =>
    x.planner.trips[0].links.push({
      id: uid(),
      title: "Other-device fictional link",
      url: "https://example.com/",
    }),
  );
  const added = await attachment(d.bridge.planner);
  added.name = "another-fictional.png";
  d.bridge.records.push(added);
  d.bridge.version++;
  d.backend.objects.delete(d.backend.document.files[0].objectId);
  assert.equal(await d.engine.repairFiles(), 1);
  assert.equal(
    d.bridge.planner.trips[0].notes,
    "Fictional pending device change",
  );
  assert.equal(d.bridge.records.length, 2);
  assert.equal(
    d.bridge.planner.trips[0].packing.length,
    p.trips[0].packing.length - 1,
  );
  assert.equal(
    d.bridge.planner.trips[0].links.length,
    p.trips[0].links.length + 1,
  );
  assert.equal(d.engine.status.kind, "pending");
  await d.engine.syncNow();
  assert.equal(d.engine.status.kind, "synced");
  assert.equal(d.backend.document.files.length, 2);
});
test("missing-file repair retains competing notes as a conflict instead of overwriting either version", async () => {
  const p = fictionalPlanner(),
    r = await attachment(p),
    d = await joined(new Backend(), p, [r]);
  d.bridge.edit((x) => (x.trips[0].notes = "Fictional pending device change"));
  d.backend.external(
    (x) => (x.planner.trips[0].notes = "Fictional competing cloud change"),
  );
  d.backend.objects.delete(d.backend.document.files[0].objectId);
  await d.engine.repairFiles();
  assert.equal(d.engine.status.kind, "conflict");
  assert.equal(
    d.bridge.planner.trips[0].notes,
    "Fictional pending device change",
  );
  assert.equal(
    d.backend.document.planner.trips[0].notes,
    "Fictional competing cloud change",
  );
});
test("stale-tab cleanup protects latest durable pending files; acknowledged missing upload is restored from retained bytes", async () => {
  const a = await joined(),
    b = device(a.backend, a.bridge.planner, [], a.store);
  await b.engine.attach(OWNER);
  const added = await attachment(b.bridge.planner);
  b.bridge.records.push(added);
  b.bridge.version++;
  a.backend.commitHook = () =>
    a.backend.external(
      (s) => (s.planner.trips[0].name = "Fictional concurrent change"),
    );
  await assert.rejects(b.engine.syncNow(), (e) => e.code === "40001");
  const staged = b.store.saved.staging.find((s) => s.uploaded);
  assert(staged);
  assert.equal(a.engine.state.candidate, null);
  await assert.rejects(a.engine.cleanup([staged.file.objectId]));
  assert(a.backend.objects.has(staged.file.objectId));
  a.backend.objects.delete(staged.file.objectId);
  await b.engine.syncNow();
  assert.equal(b.engine.status.kind, "synced");
  assert(a.backend.objects.has(staged.file.objectId));
  assert.equal(a.backend.calls.filter((c) => c === "upload").length, 2);
});
test("destructive orphan cleanup is unavailable without an exclusive browser lock", async () => {
  const d = await joined();
  d.engine.cleanupAllowed = () => false;
  await assert.rejects(d.engine.cleanup([]), /Web Locks/);
  assert(!d.backend.calls.includes("remove"));
});
class ProvenanceBridge extends Bridge {
  marker = null;
  fileMarker = null;
  reset = null;
  revision = null;
  present = true;
  async snapshot() {
    const raw = await super.snapshot();
    raw.token = {
      version: this.version,
      raw: this.present ? JSON.stringify(this.planner) : null,
      revision: this.revision,
      fingerprint: JSON.stringify(this.records.map((r) => r.id).sort()),
      projectionMarker: this.marker,
      fileMarker: this.fileMarker,
      resetMarker: this.reset,
    };
    return raw;
  }
  async apply(local, token) {
    await super.apply(local, token.version);
    this.present = true;
    this.marker = this.marker || uid();
    this.fileMarker = this.marker;
    this.revision = uid();
  }
}
async function provenanceDevice() {
  const backend = new Backend(),
    p = fictionalPlanner(),
    r = await attachment(p),
    d = device(backend);
  d.bridge = new ProvenanceBridge(p, [r]);
  d.engine.bridge = d.bridge;
  await d.engine.connect(OWNER);
  await d.engine.syncNow();
  return { ...d, backend };
}
test("missing/reset text or file storage pauses before journal overwrite/cloud deletion and preserves complete recovery", async () => {
  for (const loss of [
    "text",
    "reset",
    "database",
    "file-store-clear",
    "projection-marker",
  ]) {
    const d = await provenanceDevice(),
      before = clone(d.backend.document),
      originalHash = await sha256(d.bridge.records[0].blob);
    if (loss === "text") {
      d.bridge.present = false;
      d.bridge.planner = blank();
    }
    if (loss === "reset") {
      d.bridge.reset = uid();
      d.bridge.planner = blank();
    }
    if (loss === "database") {
      d.bridge.fileMarker = null;
      d.bridge.records = [];
    }
    if (loss === "file-store-clear") d.bridge.records = [];
    if (loss === "projection-marker") d.bridge.marker = null;
    await assert.rejects(
      d.engine.syncNow(),
      (e) => e.code === "projection-recovery",
    );
    assert.equal(d.engine.status.kind, "recovery", loss);
    assert.deepEqual(
      d.backend.document,
      before,
      loss + " must not delete cloud trips/files",
    );
    const restored = await readPortableBackup(await d.engine.recoveryBackup());
    assert.equal(restored.planner.trips.length, 1);
    assert.equal(await sha256(restored.attachments[0].blob), originalHash);
    await d.engine.restoreRecovery();
    assert.equal(d.bridge.planner.trips.length, 1);
    assert.equal(d.bridge.records.length, 1);
    assert.equal(d.engine.state.joined, false);
  }
});
test("intentional in-app trip/file deletion still syncs when projection markers and file revision remain valid", async () => {
  const d = await provenanceDevice(),
    id = d.bridge.planner.trips[0].id;
  d.bridge.edit((p) => (p.trips = []));
  d.bridge.records = [];
  d.bridge.revision = uid();
  await d.engine.syncNow();
  assert.equal(d.engine.status.kind, "synced");
  assert.equal(d.backend.document.planner.trips.length, 0);
  assert.equal(d.backend.document.files.length, 0);
  assert(d.backend.document.deletedIds.includes(id));
});
