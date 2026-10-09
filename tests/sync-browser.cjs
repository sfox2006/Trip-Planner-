// Browser UI/IndexedDB/real planner-bridge tests with fictional in-memory Auth/cloud.
// Live Supabase ownership, confirmation delivery and real phones are separate gates.
const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."),
  port = 8100,
  origin = `http://127.0.0.1:${port}`,
  results = path.join(root, "test-results");
const server = spawn(
  "python3",
  ["-m", "http.server", String(port), "--bind", "127.0.0.1"],
  { cwd: root, stdio: "ignore" },
);
const report = {
  checks: [],
  screenshots: [],
  errors: [],
  externalRequests: [],
  axe: [],
};
const ok = (name) => {
  report.checks.push(name);
  console.log("✓ " + name);
};
async function mockUI(
  page,
  {
    cloud = null,
    signedIn = false,
    syncConfigured = true,
    callbackRecovery = false,
  } = {},
) {
  await page.evaluate(
    async ({ cloud, signedIn, syncConfigured, callbackRecovery }) => {
      const { initSyncUI } = await import("./sync-ui.js"),
        { emptyDocument, clone, checkDocument, sha256 } =
          await import("./sync-model.js"),
        { uid } = await import("./model.js");
      const owner = "11111111-1111-4111-8111-111111111111",
        other = "22222222-2222-4222-8222-222222222222",
        listeners = new Set(),
        objects = new Map(),
        reserved = new Map();
      const state = {
        cloud: cloud || emptyDocument(),
        signedIn,
        owner,
        online: true,
        calls: [],
        rememberOptions: [],
      };
      const provider = {
        async user() {
          if (!state.signedIn)
            throw Object.assign(Error("Fictional unsigned account"), {
              code: "42501",
            });
          return { id: state.owner, email: "fictional-owner@example.test" };
        },
        async assertOwner(expected) {
          const user = await this.user();
          if (expected !== user.id)
            throw Object.assign(Error("Fictional owner mismatch"), {
              code: "owner",
            });
        },
        onAuthChange(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        close() {
          listeners.clear();
        },
        async signIn() {
          state.signedIn = true;
          for (const fn of listeners) fn("SIGNED_IN");
          return this.user();
        },
        async signUp() {
          state.calls.push("signup");
        },
        async resend() {
          state.calls.push("resend");
        },
        async recover() {
          state.calls.push("recover");
        },
        async updatePassword() {
          state.calls.push("updatePassword");
          return this.user();
        },
        async callback() {
          state.calls.push("callback");
          state.signedIn = true;
          return { recovery: callbackRecovery, user: await this.user() };
        },
        async signOut() {
          state.signedIn = false;
          for (const fn of listeners) fn("SIGNED_OUT");
        },
        async read(expected) {
          await this.assertOwner(expected);
          state.calls.push("read");
          return clone(state.cloud);
        },
        async commit(expected, revision, document) {
          await this.assertOwner(expected);
          if (state.cloud.revision !== revision)
            throw Object.assign(Error("Fictional CAS conflict"), {
              code: "40001",
            });
          for (const f of document.files)
            if (!objects.has(f.objectId))
              throw Error("Fictional unuploaded file");
          const ids = (d) =>
              d.planner.trips
                .flatMap((t) => [
                  t.id,
                  ...[
                    "items",
                    "packing",
                    "expenses",
                    "budgets",
                    "links",
                  ].flatMap((k) => t[k].map((e) => e.id)),
                ])
                .concat(d.files.map((f) => f.id)),
            remaining = new Set(ids(document));
          state.cloud = checkDocument({
            ...state.cloud,
            planner: clone(document.planner),
            files: clone(document.files),
            revision: String(BigInt(revision) + 1n),
            deletedIds: [
              ...new Set([
                ...state.cloud.deletedIds,
                ...ids(state.cloud).filter((id) => !remaining.has(id)),
              ]),
            ],
          });
          state.calls.push("commit");
          return state.cloud.revision;
        },
        async reserve(expected, file) {
          await this.assertOwner(expected);
          reserved.set(file.objectId, clone(file));
          state.calls.push("reserve");
        },
        async upload(expected, file, blob) {
          await this.assertOwner(expected);
          if (objects.has(file.objectId))
            throw Object.assign(Error("Fictional duplicate"), { code: "409" });
          objects.set(file.objectId, blob);
          state.calls.push("upload");
        },
        async download(expected, file) {
          await this.assertOwner(expected);
          if (!objects.has(file.objectId))
            throw Object.assign(Error("Fictional missing file"), {
              code: "404",
            });
          return objects.get(file.objectId);
        },
        async listObjects() {
          return [...reserved].map(([objectId, f]) => ({
            objectId,
            size: f.size,
            type: f.type,
            createdAt: "2026-10-09T00:00:00Z",
          }));
        },
        async remove(expected, id) {
          await this.assertOwner(expected);
          objects.delete(id);
        },
        async release(expected, id) {
          await this.assertOwner(expected);
          reserved.delete(id);
        },
      };
      // Reload mock cloud bytes from healthy private local originals when available.
      const { files } = await import("./attachments.js");
      for (const f of state.cloud.files) {
        for (const r of await files.list())
          if (
            r.type === f.type &&
            r.size === f.size &&
            (await sha256(r.blob)) === f.sha256
          )
            objects.set(f.objectId, r.blob);
      }
      const ui = await initSyncUI({
        configured: true,
        syncConfigured,
        providerFactory: async (options) => {
          state.rememberOptions.push(options);
          return provider;
        },
        online: () => state.online,
      });
      const { plannerBridge } = await import("./app.js");
      window.fictionalSync = {
        state,
        provider,
        ui,
        objects,
        reserved,
        other,
        async editNotes(text) {
          const raw = await plannerBridge.snapshot(),
            next = clone(raw);
          next.planner.trips[0].notes = text;
          await plannerBridge.apply(next, raw.token);
        },
        cloudNotes(text) {
          state.cloud.planner.trips[0].notes = text;
          state.cloud.revision = String(BigInt(state.cloud.revision) + 1n);
        },
        switchAccount() {
          state.owner = other;
          state.signedIn = true;
          for (const fn of listeners) fn("SIGNED_IN");
        },
      };
    },
    { cloud, signedIn, syncConfigured, callbackRecovery },
  );
}
async function seed(page) {
  await page.evaluate(async () => {
    const { demoTrip } = await import("./model.js");
    localStorage.setItem(
      "personal-trip-planner.v1",
      JSON.stringify({ version: 1, trips: [demoTrip()] }),
    );
  });
  await page.reload();
  await page.locator("#trip-view").waitFor({ state: "visible" });
}
async function status(page, kind) {
  await page.waitForFunction(
    (kind) => window.fictionalSync.ui.engine.status.kind === kind,
    kind,
  );
}
async function screenshot(page, name) {
  await page.screenshot({
    path: path.join(results, name + ".png"),
    fullPage: false,
  });
  report.screenshots.push(name + ".png");
}
async function axe(page, name) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  report.axe.push({ name, violations });
  assert.deepEqual(violations, [], name);
}
let browser;
(async () => {
  await fs.mkdir(results, { recursive: true });
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      acceptDownloads: true,
    }),
    page = await context.newPage();
  context.on("page", (p) =>
    p.on("pageerror", (e) => report.errors.push(e.message)),
  );
  page.on("pageerror", (e) => report.errors.push(e.message));
  const requests = [];
  // This suite deliberately exercises the fully disabled release and fictional
  // cloud protocol, even when the public build is configured for Auth-only.
  await context.route("**/cloud-config.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: 'export const cloudConfig = Object.freeze({authEnabled:false,enabled:false,policiesVerified:false,projectUrl:"",publishableKey:""});',
    }),
  );
  context.on("request", (r) => {
    requests.push(r.url());
    if (!r.url().startsWith(origin + "/"))
      report.externalRequests.push(r.url());
  });
  await page.goto(
    origin + "/?code=fictional-test-code#access_token=fictional-test-token",
  );
  await page.locator("#welcome").waitFor({ state: "visible" });
  await page.waitForFunction(() => !location.search && !location.hash);
  assert(!requests.some((u) => u.includes("/vendor/supabase.mjs")));
  await page.locator("#sync-open").click();
  assert(await page.locator("#sync-auth").isHidden());
  assert.match(
    await page.locator("#sync-disabled").innerText(),
    /no trip data is sent/,
  );
  await axe(page, "disabled mobile sync dialog");
  await screenshot(page, "sync-disabled-mobile");
  await page.locator("#sync-close").focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "sync-close",
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "sync-open",
  );
  ok(
    "Disabled build makes no Auth/SDK calls, strips callback tokens, and has accessible keyboard/phone setup state",
  );
  await seed(page);
  const originalPlanner = await page.evaluate(() =>
    localStorage.getItem("personal-trip-planner.v1"),
  );
  await mockUI(page, { syncConfigured: false });
  await page.locator("#sync-open").click();
  await page.locator("#sync-email").fill("fictional-owner@example.test");
  await page.locator("#sync-password").fill("Fictional test password");
  await page.locator("#sync-auth button[value=signin]").click();
  await page.locator("#sync-account").waitFor({ state: "visible" });
  assert(await page.locator("#sync-join").isHidden());
  assert(await page.locator("#sync-connected").isHidden());
  assert.match(
    await page.locator("#sync-message").innerText(),
    /awaiting live access tests/,
  );
  await axe(page, "Auth-only signed-in gate");
  await page.evaluate(() => document.getElementById("sync-connect").click());
  await page.waitForFunction(
    () => document.getElementById("sync-close").disabled === false,
  );
  assert.deepEqual(await page.evaluate(() => fictionalSync.state.calls), []);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  assert.deepEqual(await page.evaluate(() => fictionalSync.state.calls), []);
  assert.equal(await page.evaluate(() => fictionalSync.ui.engine.owner), null);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("personal-trip-planner.v1")),
    originalPlanner,
  );
  await page.locator("#sync-signout").click();
  await page.locator("#sync-auth").waitFor({ state: "visible" });
  await page.evaluate(() => fictionalSync.ui.dispose());
  await page.reload();
  await page.locator("#trip-view").waitFor({ state: "visible" });
  ok(
    "Auth-only sign-in/signout hides and refuses cloud connect, preserves local plans, and never reads or writes cloud data on reconnection",
  );
  await page.evaluate(() =>
    history.replaceState(null, "", "?code=fictional-recovery-code"),
  );
  await mockUI(page, { syncConfigured: false, callbackRecovery: true });
  await page.locator("#sync-open").click();
  await page.locator("#sync-new-password").waitFor({ state: "visible" });
  await axe(page, "Auth-only password recovery");
  await page
    .locator("#sync-new-password-value")
    .fill("Fictional replacement password");
  await page.locator("#sync-new-password button").click();
  await page.locator("#sync-new-password").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#sync-new-password-value").inputValue(), "");
  assert.deepEqual(await page.evaluate(() => fictionalSync.state.calls), [
    "callback",
    "updatePassword",
  ]);
  assert.equal(await page.evaluate(() => fictionalSync.ui.engine.owner), null);
  assert.equal(await page.evaluate(() => location.search), "");
  assert(await page.locator("#sync-join").isHidden());
  await page.evaluate(() => fictionalSync.ui.dispose());
  await page.reload();
  await page.locator("#trip-view").waitFor({ state: "visible" });
  ok(
    "Auth-only fictional recovery callback clears URL/password, permits replacement, and never attaches or previews cloud data",
  );
  await mockUI(page);

  await page.locator("#sync-open").click();
  await axe(page, "mobile sign-in");
  await screenshot(page, "sync-signin-mobile");
  await page.locator("#sync-email").fill("fictional-owner@example.test");
  await page.locator("#sync-password").fill("Fictional test password");
  await page.locator("#sync-auth button[value=signup]").click();
  await page.waitForFunction(() =>
    fictionalSync.state.calls.includes("signup"),
  );
  assert.match(
    await page.locator("#sync-message").innerText(),
    /confirm the account/,
  );
  assert.equal(await page.locator("#sync-password").inputValue(), "");
  assert(await page.locator("#sync-account").isHidden());
  ok(
    "Account creation requires confirmation; passwords clear immediately and no automatic trip upload occurs",
  );
  await page.locator("#sync-password").fill("Fictional test password");
  await page.locator("#sync-auth button[value=signin]").click();
  await page.locator("#sync-connect").waitFor({ state: "visible" });
  assert.equal(
    await page.evaluate(() => fictionalSync.state.cloud.planner.trips.length),
    0,
  );
  assert.equal(
    await page.evaluate(() => fictionalSync.state.rememberOptions[0].remember),
    false,
  );
  await page.locator("#sync-connect").click();
  await status(page, "synced");
  await axe(page, "connected mobile");
  await screenshot(page, "sync-connected-mobile");
  assert.equal(
    await page.evaluate(() => fictionalSync.state.cloud.planner.trips.length),
    1,
  );
  assert.match(
    await page.locator("#pwa-state").innerText(),
    /Private sync connected/,
  );
  ok(
    "Explicit same-owner connect merges privately, persists the real IndexedDB journal and shows verified save status",
  );
  await page.evaluate(() => {
    fictionalSync.state.online = false;
    return fictionalSync.editNotes("Fictional offline queued note");
  });
  await page.locator("#sync-now").click();
  await status(page, "pending");
  const cloud = await page.evaluate(() => fictionalSync.state.cloud);
  assert.notEqual(
    cloud.planner.trips[0].notes,
    "Fictional offline queued note",
  );
  await page.reload();
  await mockUI(page, { cloud, signedIn: true });
  await status(page, "synced");
  assert.equal(
    await page.evaluate(() => fictionalSync.state.cloud.planner.trips[0].notes),
    "Fictional offline queued note",
  );
  ok(
    "Offline edits survive actual page reload and journal recovery, then sync after reconnection",
  );
  await page.locator("#sync-open").click();
  await page.evaluate(async () => {
    fictionalSync.state.online = false;
    await fictionalSync.editNotes("Fictional device version");
    fictionalSync.cloudNotes("Fictional competing cloud version");
    fictionalSync.state.online = true;
  });
  await page.locator("#sync-now").click();
  await status(page, "conflict");
  await axe(page, "conflict mobile");
  await screenshot(page, "sync-conflict-mobile");
  await page.locator("#sync-conflict-choices select").selectOption("copy");
  await page.locator("#sync-conflicts button").click();
  await status(page, "synced");
  assert.equal(
    await page.evaluate(() => fictionalSync.state.cloud.planner.trips.length),
    2,
  );
  ok(
    "Competing edits require an explicit accessible choice; both versions are preserved with fresh IDs",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await screenshot(page, "sync-connected-desktop");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const beforeAccountSwitch = await page.evaluate(
    () => fictionalSync.state.calls.filter((x) => x === "commit").length,
  );
  await page.locator("#sync-signout").click();
  await page.locator("#sync-auth").waitFor({ state: "visible" });
  assert.match(
    await page.locator("#sync-message").innerText(),
    /owner-bound queue are kept/,
  );
  assert.equal(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("personal-trip-planner.v1")).trips
          .length,
    ),
    2,
  );
  await page.evaluate(() => fictionalSync.switchAccount());
  await status(page, "permission");
  assert.match(
    await page.locator("#sync-message").innerText(),
    /another account/,
  );
  assert.equal(
    await page.evaluate(
      () => fictionalSync.state.calls.filter((x) => x === "commit").length,
    ),
    beforeAccountSwitch,
  );
  ok(
    "Signout preserves private device trips; signing into another account refuses owner rebinding/transmission",
  );
  await context.close();
  const privateContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      acceptDownloads: true,
    }),
    p = await privateContext.newPage();
  p.on("pageerror", (e) => report.errors.push(e.message));
  privateContext.on("request", (r) => {
    if (!r.url().startsWith(origin + "/"))
      report.externalRequests.push(r.url());
  });
  await p.route("**/tests/blank.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><title>Fictional migration test</title></html>",
    }),
  );
  await p.goto(origin + "/tests/blank.html");
  const fixtureHash = await p.evaluate(async () => {
    const { demoTrip, uid } = await import("/model.js"),
      { sha256 } = await import("/sync-model.js"),
      planner = { version: 1, trips: [demoTrip()] },
      canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    canvas.getContext("2d").fillRect(0, 0, 1, 1);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    const row = {
      id: uid(),
      tripId: planner.trips[0].id,
      planId: planner.trips[0].items[0].id,
      name: "fictional-sync.png",
      type: blob.type,
      size: blob.size,
      blob,
      pending: false,
    };
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("personal-trip-planner-files", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("attachments", { keyPath: "id" });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("attachments", "readwrite");
        tx.objectStore("attachments").put(row);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    localStorage.setItem("personal-trip-planner.v1", JSON.stringify(planner));
    localStorage.setItem("personal-trip-planner.files-revision", uid());
    return sha256(blob);
  });
  await p.goto(origin);
  await p.locator("#trip-view").waitFor({ state: "visible" });
  const migrated = await p.evaluate(async () => {
    const { files } = await import("./attachments.js"),
      { sha256 } = await import("./sync-model.js"),
      rows = await files.list();
    return { count: rows.length, hash: await sha256(rows[0].blob) };
  });
  assert.equal(migrated.count, 1);
  assert.equal(migrated.hash, fixtureHash);
  ok(
    "Real IndexedDB v1→v2 upgrade preserves existing fictional attachment bytes and ownership",
  );
  await mockUI(p, { signedIn: true });
  await p.locator("#sync-open").click();
  await p.locator("#sync-connect").click();
  await status(p, "synced");
  assert.equal(
    await p.evaluate(() => fictionalSync.state.cloud.files.length),
    1,
  );
  const fileCloud = await p.evaluate(() => fictionalSync.state.cloud);
  await p.evaluate(() => localStorage.removeItem("personal-trip-planner.v1"));
  await p.reload();
  await mockUI(p, { cloud: fileCloud, signedIn: true });
  await status(p, "recovery");
  assert.equal(
    await p.evaluate(() => fictionalSync.state.cloud.planner.trips.length),
    1,
  );
  assert.equal(
    await p.evaluate(() => fictionalSync.state.calls.includes("commit")),
    false,
  );
  await p.locator("#sync-open").click();
  await axe(p, "device recovery mobile");
  await screenshot(p, "sync-recovery-mobile");
  const download = p.waitForEvent("download");
  await p.locator("#sync-recovery-download").click();
  const saved = await download;
  const bytes = await fs.readFile(await saved.path(), "utf8"),
    backup = JSON.parse(bytes);
  assert.equal(backup.planner.trips.length, 1);
  assert.equal(backup.attachments.length, 1);
  assert(
    !/access_token|refresh_token|Fictional test password|publishableKey/.test(
      bytes,
    ),
  );
  await p.locator("#sync-recovery-restore").click();
  await status(p, "join");
  assert.equal(
    await p.evaluate(
      () =>
        JSON.parse(localStorage.getItem("personal-trip-planner.v1")).trips
          .length,
    ),
    1,
  );
  ok(
    "Lost planner text cannot delete cloud trips/files; complete local recovery export excludes Auth and restores privately",
  );
  await p.locator("#sync-connect").click();
  await status(p, "synced");
  await p.locator("#sync-close").click();
  const nextCloud = await p.evaluate(() => fictionalSync.state.cloud);
  await p.evaluate(async () => {
    const { files } = await import("./attachments.js");
    const rows = await files.list();
    await files.remove(rows.map((r) => r.id));
  });
  await p.reload();
  await mockUI(p, { cloud: nextCloud, signedIn: true });
  await status(p, "recovery");
  assert.equal(
    await p.evaluate(() => fictionalSync.state.cloud.files.length),
    1,
  );
  assert.equal(
    await p.evaluate(() => fictionalSync.state.calls.includes("commit")),
    false,
  );
  ok(
    "Unexplained attachment-store loss triggers durable recovery instead of remote manifest deletion",
  );
  await p.locator("#sync-open").click();
  await p.locator("#sync-recovery-restore").click();
  await status(p, "join");
  await p.locator("#sync-connect").click();
  await status(p, "synced");
  await p.locator("#sync-close").click();
  const healthyCloud = await p.evaluate(() => fictionalSync.state.cloud);
  await p.evaluate(() =>
    localStorage.setItem(
      "personal-trip-planner.v1",
      "{fictional corrupt storage",
    ),
  );
  await p.reload();
  await mockUI(p, { cloud: healthyCloud, signedIn: true });
  assert.equal(
    await p.evaluate(() => fictionalSync.state.calls.includes("commit")),
    false,
  );
  await p.locator("#backup-open").click();
  await p
    .getByRole("button", { name: "Reset planner storage", exact: true })
    .click();
  await p.locator("#confirm-delete").click();
  await status(p, "recovery");
  assert.equal(
    await p.evaluate(() => fictionalSync.state.calls.includes("commit")),
    false,
  );
  assert.equal(
    await p.evaluate(() => fictionalSync.state.cloud.planner.trips.length),
    1,
  );
  ok(
    "Real corrupt-storage reset pauses connected sync and preserves account data/journal originals",
  );
  await p.locator("#sync-open").click();
  await p.locator("#sync-recovery-restore").click();
  await status(p, "join");
  await p.locator("#sync-connect").click();
  await status(p, "synced");
  await p.locator("#sync-close").click();
  const retainedCloud = await p.evaluate(() => fictionalSync.state.cloud);
  await p.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.deleteDatabase("personal-trip-planner-files");
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      }),
  );
  await p.reload();
  await mockUI(p, { cloud: retainedCloud, signedIn: true });
  await status(p, "recovery");
  assert.equal(
    await p.evaluate(() => fictionalSync.state.calls.includes("commit")),
    false,
  );
  ok(
    "Whole attachment database loss is detected by its independent projection marker",
  );
  await p.locator("#sync-open").click();
  await p.locator("#sync-recovery-restore").click();
  await status(p, "join");
  const beforeProjection = await p.evaluate(async () => {
    const { files } = await import("./attachments.js"),
      { sha256 } = await import("./sync-model.js"),
      rows = await files.list();
    return {
      raw: localStorage.getItem("personal-trip-planner.v1"),
      hash: await sha256(rows[0].blob),
    };
  });
  await p.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "personal-trip-planner.v1")
        throw new DOMException(
          "Fictional projection quota failure",
          "QuotaExceededError",
        );
      return setItem.call(this, key, value);
    };
  });
  await p.locator("#sync-connect").click();
  await status(p, "recovery");
  const afterProjection = await p.evaluate(async () => {
    const { files } = await import("./attachments.js"),
      { sha256 } = await import("./sync-model.js"),
      rows = await files.list();
    return {
      raw: localStorage.getItem("personal-trip-planner.v1"),
      hash: await sha256(rows[0].blob),
    };
  });
  assert.deepEqual(afterProjection, beforeProjection);
  assert.equal(
    await p.evaluate(() => fictionalSync.state.calls.includes("commit")),
    false,
  );
  ok(
    "Cross-store projection quota failure rolls back attachment bytes and preserves complete journal recovery",
  );
  await privateContext.close();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.externalRequests, []);
  ok(
    "No browser errors, real Auth, backend traffic or personal-data transmission",
  );
})()
  .catch((e) => {
    report.failure = e.stack;
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close();
    server.kill();
    await fs.writeFile(
      path.join(results, "sync-browser-report.json"),
      JSON.stringify(report, null, 2),
    );
  });
