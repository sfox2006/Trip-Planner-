import { blank, validate, uid } from "./model.js";
import { checkFile, ownedFiles, portableBackup } from "./attachments.js";
import {
  UUID,
  clone,
  stable,
  recordMetadata,
  sha256,
  checkDocument,
  checkManifests,
  emptyDocument,
  sameContents,
  mergeDocuments,
  mergeFirstJoin,
} from "./sync-model.js";
export class SyncEngine {
  constructor({
    provider,
    store,
    bridge,
    onStatus = () => {},
    online = () =>
      typeof navigator === "undefined" || navigator.onLine !== false,
    lock = async (fn) => fn(),
    cleanupAllowed = () => true,
  }) {
    Object.assign(this, {
      provider,
      store,
      bridge,
      onStatus,
      online,
      lock,
      cleanupAllowed,
    });
    this.owner = null;
    this.state = null;
    this.epoch = 0;
    this.tail = Promise.resolve();
    this.status = {
      kind: "signed-out",
      text: "Plans stay on this device. Sign in to connect private sync.",
    };
  }
  setStatus(kind, text, extra = {}) {
    this.status = { kind, text, ...extra };
    this.onStatus(this.status);
  }
  current(epoch = this.epoch) {
    if (!this.owner || epoch !== this.epoch) {
      const e = Error("Sync paused; device data is kept.");
      e.code = "paused";
      throw e;
    }
  }
  run(action) {
    const result = this.tail.then(() => this.lock(action));
    this.tail = result.catch(() => {});
    return result;
  }
  async save() {
    this.current();
    this.state = await this.store.save(this.state, this.state.generation);
    return this.state;
  }
  async load() {
    const state = await this.store.load(this.owner);
    if (state) {
      if (
        state.version !== 1 ||
        state.ownerId !== this.owner ||
        !Number.isSafeInteger(state.generation) ||
        !Array.isArray(state.staging)
      )
        throw Error(
          "Invalid owner journal. Download a recovery backup; do not overwrite it.",
        );
      checkDocument(state.base);
      validate(state.local.planner);
      checkManifests(state.local.planner, state.local.files);
      this.state = state;
    }
    if (!state) this.state = null;
    return state;
  }
  async identity(owner) {
    const epoch = this.epoch;
    if (!UUID.test(owner)) throw Error("Invalid confirmed account identity.");
    await this.provider.assertOwner(owner);
    const binding = await this.store.binding();
    if (epoch !== this.epoch) {
      const e = Error("Sign-in changed; device data is kept.");
      e.code = "paused";
      throw e;
    }
    if (binding && binding.ownerId !== owner) {
      const e = Error(
        "This device copy belongs to another account. Sign back into that account; keep a backup before clearing or changing ownership.",
      );
      e.code = "owner";
      throw e;
    }
    return binding;
  }
  async attach(owner) {
    return this.run(async () => {
      await this.identity(owner);
      this.owner = owner;
      this.epoch++;
      await this.load();
      if (!this.state?.joined) {
        this.setStatus(
          "join",
          "Choose Connect to merge this device’s trips with your account.",
        );
        return false;
      }
      if (this.state.recovery) {
        this.setStatus(
          "recovery",
          "A previous device refresh failed. Your original recovery copy is saved; restore or download it before continuing.",
        );
        return true;
      }
      if (this.state.conflict) {
        this.setStatus(
          "conflict",
          "Changes need a choice. Both versions are kept.",
          { conflicts: this.state.conflict.items },
        );
        return true;
      }
      this.setStatus(
        "pending",
        "Signed in. Device edits are queued for private sync.",
      );
      return true;
    });
  }
  provenance(raw) {
    if (
      !raw.token ||
      typeof raw.token !== "object" ||
      !Object.hasOwn(raw.token, "raw")
    )
      return null;
    return {
      present: raw.token.raw !== null,
      revision: raw.token.revision,
      fingerprint: raw.token.fingerprint,
      marker: raw.token.projectionMarker || null,
      fileMarker: raw.token.fileMarker || null,
      reset: raw.token.resetMarker || null,
    };
  }
  async guardProjection(raw) {
    const old = this.state?.local?.projection,
      next = this.provenance(raw);
    if (!this.state?.joined || this.state.recovery || !old || !next) return;
    if (
      (old.present && !next.present) ||
      old.marker !== next.marker ||
      old.fileMarker !== next.fileMarker ||
      old.reset !== next.reset ||
      (old.fingerprint !== next.fingerprint && old.revision === next.revision)
    ) {
      this.state.recovery = clone(this.state.local);
      await this.save();
      const e = Error(
        "Saved device text/files were reset or disappeared. Your owner-bound recovery copy and cloud data are kept. Restore/download recovery before reconnecting.",
      );
      e.code = "projection-recovery";
      this.setStatus("recovery", e.message);
      throw e;
    }
  }
  async snapshot(raw) {
    await this.guardProjection(raw);
    validate(raw.planner);
    const records = ownedFiles(raw.planner, raw.records || []),
      manifests = [];
    for (const r of records) {
      await checkFile(r.blob);
      if (r.blob.size !== r.size || r.blob.type !== r.type)
        throw Error(
          "Local file metadata does not match its bytes. Keep a backup.",
        );
      const hash = await sha256(r.blob),
        old = [
          ...(this.state?.base.files || []),
          ...(this.state?.local.files || []),
          ...(this.state?.staging || []).map((s) => s.file),
        ].find(
          (f) =>
            f.id === r.id &&
            f.sha256 === hash &&
            f.type === r.type &&
            f.size === r.size,
        );
      manifests.push({
        version: 1,
        ...recordMetadata(r),
        sha256: hash,
        objectId: old?.objectId || uid(),
      });
    }
    checkManifests(raw.planner, manifests);
    return {
      planner: clone(raw.planner),
      files: manifests,
      records: clone(records),
      token: raw.token,
      projection: this.provenance(raw),
    };
  }
  async materialize(document, sources = []) {
    checkManifests(document.planner, document.files);
    const records = [],
      hashed = new Map();
    for (const r of sources) {
      if (!(r.blob instanceof Blob)) continue;
      const hash = await sha256(r.blob);
      hashed.set(r.type + ":" + r.size + ":" + hash, r.blob);
    }
    const epoch = this.epoch;
    for (const f of document.files) {
      this.current(epoch);
      let blob = hashed.get(f.type + ":" + f.size + ":" + f.sha256);
      if (!blob) {
        let downloaded;
        try {
          downloaded = await this.provider.download(this.owner, f);
        } catch (error) {
          if (
            ["404", "not_found", "NoSuchKey", "ObjectNotFound"].includes(
              error.code,
            )
          ) {
            const e = Error(
              "A private file is missing. Device originals are kept; repair from this device or restore a backup.",
            );
            e.code = "file-recovery";
            throw e;
          }
          throw error;
        }
        this.current(epoch);
        blob = new Blob([downloaded], { type: f.type });
      }
      try {
        await checkFile(blob);
      } catch {
        const e = Error(
          "Private file bytes failed validation. Healthy device originals are kept.",
        );
        e.code = "file-recovery";
        throw e;
      }
      if (blob.size !== f.size || (await sha256(blob)) !== f.sha256) {
        const e = Error(
          "Private file is missing or corrupt. Healthy device originals are kept; retry or restore a local backup.",
        );
        e.code = "file-recovery";
        throw e;
      }
      records.push({ ...recordMetadata(f), blob });
    }
    return records;
  }
  async preview(owner) {
    return this.run(async () => {
      await this.identity(owner);
      const remote = checkDocument(await this.provider.read(owner)),
        raw = await this.bridge.snapshot();
      return {
        deviceTrips: raw.planner.trips.length,
        cloudTrips: remote.planner.trips.length,
        cloudFiles: remote.files.length,
      };
    });
  }
  async connect(owner) {
    return this.run(async () => {
      await this.identity(owner);
      this.owner = owner;
      this.epoch++;
      await this.store.bind(owner);
      await this.load();
      if (this.state?.joined)
        throw Error("This account is already connected. Use Sync now.");
      const epoch = this.epoch,
        raw = await this.bridge.snapshot(),
        local = await this.snapshot(raw),
        remote = checkDocument(await this.provider.read(owner));
      this.current(epoch);
      const merged = mergeFirstJoin(local, remote),
        records = await this.materialize(merged, local.records);
      this.current(epoch);
      this.state = {
        version: 1,
        ownerId: owner,
        generation: this.state?.generation || 0,
        joined: true,
        base: remote,
        local: { planner: merged.planner, files: merged.files, records },
        staging: [],
        conflict: null,
        recovery: local,
        rebaseFrom: null,
        ackRecords: [],
      };
      await this.save();
      try {
        await this.bridge.apply(this.state.local, raw.token);
        this.current(epoch);
        this.state.local.projection = this.provenance(
          await this.bridge.snapshot(),
        );
        this.state.recovery = null;
        await this.save();
      } catch (e) {
        this.setStatus(
          "recovery",
          "Device merge could not finish. The original and merged copies are saved; download or restore recovery.",
        );
        throw e;
      }
      this.setStatus(
        "pending",
        `Connected. ${merged.duplicates ? `${merged.duplicates} exact duplicate trip(s) kept once. ` : ""}Trips/files are queued; no save is claimed until verified.`,
      );
      return merged.duplicates;
    });
  }
  async capture() {
    return this.run(async () => {
      if (
        !this.owner ||
        !this.state?.joined ||
        this.state.recovery ||
        this.state.conflict ||
        this.state.rebaseFrom
      )
        return;
      const local = await this.snapshot(await this.bridge.snapshot());
      this.current();
      if (
        !sameContents(local, this.state.local) ||
        stable(local.projection) !== stable(this.state.local.projection)
      ) {
        this.state.local = {
          planner: local.planner,
          files: local.files,
          records: local.records,
          projection: local.projection,
        };
        await this.save();
        this.setStatus(
          "pending",
          this.online()
            ? "Device changes queued for private sync."
            : "Offline. Device changes are queued and kept here.",
        );
      }
    });
  }
  async ensureFile(file, records) {
    let staged = this.state.staging.find(
      (s) => s.file.objectId === file.objectId,
    );
    if (!staged) {
      staged = { file: clone(file), uploaded: false };
      this.state.staging.push(staged);
      await this.save();
    }
    const blob = records.find((r) => r.id === file.id)?.blob;
    if (!blob)
      throw Error(
        "Pending file original is unavailable. Restore a local backup.",
      );
    const epoch = this.epoch;
    await this.provider.reserve(this.owner, file);
    this.current(epoch);
    let uploadError;
    if (!staged.uploaded) {
      try {
        await this.provider.upload(this.owner, file, blob);
      } catch (e) {
        uploadError = e;
      }
      this.current(epoch);
    }
    // A previously acknowledged upload may later be missing; use the durable
    // original to recreate its immutable path before retrying the document CAS.
    if (staged.uploaded) {
      try {
        await this.provider.download(this.owner, file);
        this.current(epoch);
      } catch (error) {
        if (
          !["404", "not_found", "NoSuchKey", "ObjectNotFound"].includes(
            error.code,
          )
        )
          throw error;
        this.current(epoch);
        staged = this.state.staging.find(
          (s) => s.file.objectId === file.objectId,
        );
        staged.uploaded = false;
        await this.save();
        try {
          await this.provider.upload(this.owner, file, blob);
        } catch (e) {
          uploadError = e;
        }
        this.current(epoch);
      }
    }
    // Covers a lost upload acknowledgement / duplicate immutable object retry.
    try {
      const bytes = await this.provider.download(this.owner, file);
      this.current(epoch);
      await checkFile(new Blob([bytes], { type: file.type }));
      if (bytes.size !== file.size || (await sha256(bytes)) !== file.sha256)
        throw Error("Uploaded file verification failed.");
    } catch (e) {
      throw uploadError || e;
    }
    staged = this.state.staging.find((s) => s.file.objectId === file.objectId);
    staged.uploaded = true;
    await this.save();
  }
  async finishRebase() {
    const raw = await this.bridge.snapshot(),
      later = await this.snapshot(raw),
      base = this.state.rebaseFrom;
    const merged = mergeDocuments(base, later, this.state.base);
    if (merged.conflicts.length) {
      this.state.conflict = {
        base,
        local: later,
        remote: this.state.base,
        items: merged.conflicts,
      };
      this.state.rebaseFrom = null;
      this.state.ackRecords = [];
      this.state.local = later;
      await this.save();
      this.setStatus(
        "conflict",
        "An edit made during sync needs a choice. Both copies are kept.",
        { conflicts: merged.conflicts },
      );
      return;
    }
    const records = await this.materialize(merged, [
        ...later.records,
        ...this.state.ackRecords,
      ]),
      local = {
        planner: merged.planner,
        files: merged.files,
        records,
        projection: later.projection,
      };
    this.state.local = local;
    this.state.recovery = later;
    await this.save();
    if (!sameContents(merged, later)) await this.bridge.apply(local, raw.token);
    this.state.local.projection = this.provenance(await this.bridge.snapshot());
    this.state.rebaseFrom = null;
    this.state.ackRecords = [];
    this.state.recovery = null;
    await this.save();
    this.setStatus(
      sameContents(local, this.state.base) ? "synced" : "pending",
      sameContents(local, this.state.base)
        ? "Trips synced to your account. Check cloud files to verify earlier uploads."
        : "New device edits are queued; other-device changes were preserved.",
    );
  }
  async syncNow({ verifyFiles = false } = {}) {
    return this.run(async () => {
      const epoch = this.epoch;
      try {
        this.current();
        await this.load();
        if (!this.state?.joined) throw Error("Connect this device first.");
        if (this.state.recovery) {
          this.setStatus(
            "recovery",
            "A saved device recovery copy needs attention before sync can continue.",
          );
          return;
        }
        if (!this.online()) {
          await this.captureWithoutQueue();
          this.setStatus(
            "pending",
            "Offline. Saved device edits stay queued here.",
          );
          return;
        }
        await this.provider.assertOwner(this.owner);
        this.current(epoch);
        if (this.state.rebaseFrom) {
          await this.finishRebase();
          return;
        }
        if (this.state.conflict) {
          this.setStatus(
            "conflict",
            "Changes need a choice. Both versions are saved.",
            { conflicts: this.state.conflict.items },
          );
          return;
        }
        const raw = await this.bridge.snapshot(),
          local = await this.snapshot(raw);
        this.state.local = {
          planner: local.planner,
          files: local.files,
          records: local.records,
          projection: local.projection,
        };
        await this.save();
        this.setStatus("syncing", "Checking your account and private files…");
        const remote = checkDocument(await this.provider.read(this.owner));
        this.current(epoch);
        if (verifyFiles) await this.materialize(remote, []);
        const merged = mergeDocuments(this.state.base, local, remote);
        if (merged.conflicts.length) {
          this.state.conflict = {
            base: this.state.base,
            local,
            remote,
            items: merged.conflicts,
          };
          await this.save();
          this.setStatus(
            "conflict",
            "Competing edits need a choice. Both versions are kept.",
            { conflicts: merged.conflicts },
          );
          return;
        }
        const records = await this.materialize(merged, local.records);
        this.current(epoch);
        // Candidate and byte originals are durable before any upload/commit.
        this.state.candidate = {
          planner: merged.planner,
          files: merged.files,
          records,
        };
        await this.save();
        for (const f of merged.files)
          if (
            !remote.files.some(
              (r) => r.objectId === f.objectId && r.sha256 === f.sha256,
            )
          )
            await this.ensureFile(f, records);
        this.current(epoch);
        let ack = remote;
        if (!sameContents(merged, remote)) {
          const revision = await this.provider.commit(
            this.owner,
            remote.revision,
            merged,
          );
          this.current(epoch);
          if (BigInt(revision) !== BigInt(remote.revision) + 1n)
            throw Error(
              "Unexpected save revision. Keep your device copy and retry.",
            );
          const ids = (d) =>
            d.planner.trips
              .flatMap((t) => [
                t.id,
                ...["items", "packing", "expenses", "budgets", "links"].flatMap(
                  (k) => t[k].map((e) => e.id),
                ),
              ])
              .concat(d.files.map((f) => f.id));
          const remaining = new Set(ids(merged));
          ack = {
            ...remote,
            planner: merged.planner,
            files: merged.files,
            revision,
            deletedIds: [
              ...new Set([
                ...remote.deletedIds,
                ...ids(remote).filter((id) => !remaining.has(id)),
              ]),
            ],
            updatedAt: null,
          };
        }
        this.state.base = checkDocument(ack);
        this.state.rebaseFrom = local;
        this.state.ackRecords = records;
        this.state.candidate = null;
        await this.save();
        await this.finishRebase();
      } catch (e) {
        if (e.code === "paused") return;
        const kind =
          e.code === "40001"
            ? "pending"
            : e.code === "projection-recovery"
              ? "recovery"
              : e.code === "file-recovery"
                ? "file-recovery"
                : ["42501", "401", "403", "owner"].includes(e.code)
                  ? "permission"
                  : "error";
        this.setStatus(
          kind,
          e.code === "40001"
            ? "Cloud changed during saving. Device edits are kept; retry to merge the new revision."
            : e.message || "Sync could not finish. Device data is kept.",
        );
        throw e;
      }
    });
  }
  async captureWithoutQueue() {
    if (this.state.conflict || this.state.rebaseFrom) return;
    const local = await this.snapshot(await this.bridge.snapshot());
    this.state.local = {
      planner: local.planner,
      files: local.files,
      records: local.records,
      projection: local.projection,
    };
    await this.save();
  }
  async resolve(choices) {
    return this.run(async () => {
      this.current();
      await this.load();
      if (!this.state?.conflict) throw Error("No saved conflict to resolve.");
      const raw = await this.bridge.snapshot(),
        now = await this.snapshot(raw);
      if (!sameContents(now, this.state.conflict.local))
        throw Error(
          "Device plans changed while choosing. Keep a backup and retry sync before resolving.",
        );
      const remote = checkDocument(await this.provider.read(this.owner));
      if (remote.revision !== this.state.conflict.remote.revision) {
        const fresh = mergeDocuments(
          this.state.conflict.base,
          this.state.conflict.local,
          remote,
        );
        if (fresh.conflicts.length) {
          this.state.conflict.remote = remote;
          this.state.conflict.items = fresh.conflicts;
          await this.save();
          this.setStatus(
            "conflict",
            "Cloud changed again. Review the latest versions before choosing.",
            { conflicts: fresh.conflicts },
          );
          return;
        }
        choices = {};
      }
      const merged = mergeDocuments(
        this.state.conflict.base,
        this.state.conflict.local,
        remote,
        choices,
      );
      if (merged.conflicts.length) {
        this.state.conflict.remote = remote;
        this.state.conflict.items = merged.conflicts;
        await this.save();
        this.setStatus(
          "conflict",
          "Cloud changed again. Review all current choices.",
          { conflicts: merged.conflicts },
        );
        return;
      }
      const records = await this.materialize(
        merged,
        this.state.conflict.local.records,
      );
      this.state.base = remote;
      this.state.local = {
        planner: merged.planner,
        files: merged.files,
        records,
      };
      this.state.conflict = null;
      this.state.recovery = now;
      await this.save();
      await this.bridge.apply(this.state.local, raw.token);
      this.state.local.projection = this.provenance(
        await this.bridge.snapshot(),
      );
      this.state.recovery = null;
      await this.save();
      this.setStatus(
        "pending",
        "Choices saved on this device. Sync now to publish the resolved copy.",
      );
    });
  }
  async repairFiles() {
    return this.run(async () => {
      this.current();
      await this.load();
      if (
        this.state?.conflict ||
        this.state?.recovery ||
        this.state?.rebaseFrom
      )
        throw Error(
          "Resolve pending device/conflict recovery before repairing cloud files.",
        );
      const epoch = this.epoch,
        raw = await this.bridge.snapshot(),
        local = await this.snapshot(raw),
        remote = checkDocument(await this.provider.read(this.owner)),
        priorBase = clone(this.state.base);
      const candidate = {
        planner: clone(remote.planner),
        files: clone(remote.files),
      };
      let repairs = 0;
      for (const f of candidate.files) {
        let bad = false;
        try {
          await this.materialize({ planner: remote.planner, files: [f] }, []);
        } catch (e) {
          if (e.code === "file-recovery") bad = true;
          else throw e;
        }
        if (!bad) continue;
        const original = local.files.find(
          (r) =>
            r.sha256 === f.sha256 && r.size === f.size && r.type === f.type,
        );
        if (!original)
          throw Error(
            "This device has no healthy original for a missing/corrupt file. Restore a complete local backup first.",
          );
        f.objectId = uid();
        repairs++;
      }
      if (!repairs) {
        const current = sameContents(local, remote);
        this.setStatus(
          current ? "synced" : "pending",
          current
            ? "Cloud file byte checks passed; trips match your account."
            : "Cloud file byte checks passed. Device or account edits still need sync.",
        );
        return 0;
      }
      const records = await this.materialize(candidate, local.records);
      this.current(epoch);
      this.state.candidate = { ...candidate, records };
      await this.save();
      for (const f of candidate.files)
        if (!remote.files.some((r) => r.objectId === f.objectId))
          await this.ensureFile(f, records);
      const revision = await this.provider.commit(
        this.owner,
        remote.revision,
        candidate,
      );
      this.current(epoch);
      if (BigInt(revision) !== BigInt(remote.revision) + 1n)
        throw Error("Invalid repair acknowledgement. Device originals kept.");
      this.state.base = checkDocument({
        ...remote,
        ...candidate,
        revision,
        updatedAt: null,
      });
      this.state.rebaseFrom = priorBase;
      this.state.ackRecords = records;
      this.state.candidate = null;
      await this.save();
      await this.finishRebase();
      return repairs;
    });
  }
  async reservations() {
    return this.run(async () => {
      this.current();
      await this.load();
      return this.provider.listObjects(this.owner);
    });
  }
  async cleanup(objects) {
    return this.run(async () => {
      this.current();
      if (!this.cleanupAllowed())
        throw Error(
          "This browser cannot lock cleanup across planner windows. Keep unfinished uploads; use a browser with Web Locks to review/remove them safely.",
        );
      await this.load();
      if (!this.state?.joined) throw Error("Connect this device first.");
      const epoch = this.epoch,
        remote = checkDocument(await this.provider.read(this.owner));
      this.current(epoch);
      const live = new Set(remote.files.map((f) => f.objectId));
      const pending = new Set(
        [
          this.state.base,
          this.state.local,
          this.state.candidate,
          this.state.recovery,
          this.state.conflict?.base,
          this.state.conflict?.local,
          this.state.conflict?.remote,
          this.state.rebaseFrom,
        ]
          .flatMap((d) => d?.files || [])
          .map((f) => f.objectId),
      );
      const listed = await this.provider.listObjects(this.owner);
      this.current(epoch);
      const allowed = new Set(listed.map((r) => r.objectId));
      if (
        !Array.isArray(objects) ||
        new Set(objects).size !== objects.length ||
        objects.some(
          (id) => !allowed.has(id) || live.has(id) || pending.has(id),
        )
      )
        throw Error(
          "A selected object is still used by saved, pending or recovery trips. It was kept.",
        );
      for (const id of objects) {
        // Defense for another journal writer even when a custom lock is used.
        const latest = await this.store.load(this.owner);
        this.current(epoch);
        if (latest?.generation !== this.state.generation)
          throw Error(
            "The owner queue changed in another tab. Review uploads again before removing anything.",
          );
        await this.provider.remove(this.owner, id);
        this.current(epoch);
        await this.provider.release(this.owner, id);
        this.current(epoch);
      }
      this.state.staging = this.state.staging.filter(
        (s) => !objects.includes(s.file.objectId),
      );
      await this.save();
      return objects.length;
    });
  }
  async recoveryBackup() {
    const local =
      this.state?.recovery || this.state?.conflict?.local || this.state?.local;
    if (!local)
      throw Error("No saved sync recovery copy. Use Backup & privacy.");
    return portableBackup(local.planner, local.records);
  }
  async restoreRecovery() {
    return this.run(async () => {
      this.current();
      if (!this.state?.recovery)
        throw Error("No device-refresh recovery copy to restore.");
      const raw = await this.bridge.snapshot();
      await this.bridge.apply(this.state.recovery, raw.token);
      this.state.local = this.state.recovery;
      this.state.recovery = null;
      this.state.rebaseFrom = null;
      this.state.ackRecords = [];
      this.state.conflict = null;
      this.state.joined = false;
      await this.save();
      this.setStatus(
        "join",
        "Original device copy restored. Reconnect explicitly to merge it safely.",
      );
    });
  }
  pause() {
    this.epoch++;
    this.owner = null;
    this.setStatus(
      "signed-out",
      "Signed out on this device. Saved plans/files and the owner-bound queue are kept.",
    );
  }
}
