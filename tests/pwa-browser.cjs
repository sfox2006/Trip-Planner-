const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;
const { existsSync } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."),
  port = 8097;
const report = { checks: [], errors: [], externalRequests: [] };
const ok = (name) => {
  report.checks.push(name);
  console.log("✓ " + name);
};
function fictionalPDF() {
  const stream = "0.1 0.3 0.2 rg 10 10 100 50 re f\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const start = Buffer.byteLength(pdf);
  pdf +=
    "xref\n0 5\n0000000000 65535 f \n" +
    offsets.map((n) => String(n).padStart(10, "0") + " 00000 n \n").join("") +
    `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}
let server, browser, directory;
(async () => {
  await fs.mkdir(path.join(root, "test-results"), { recursive: true });
  const { buildSite, PUBLIC_ASSETS } = await import("../scripts/build-site.js");
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "trip-planner-pwa-"));
  const site = path.join(directory, "Trip-Planner-");
  const built = await buildSite(site);
  assert.deepEqual((await fs.readdir(site)).sort(), [
    ".nojekyll",
    "app.js",
    "assets",
    "attachments.js",
    "index.html",
    "manifest.webmanifest",
    "model.js",
    "pwa.js",
    "styles.css",
    "sw.js",
    "vendor",
  ]);
  assert.equal(built.files.length, PUBLIC_ASSETS.length + 2);
  assert(
    !built.files.some((x) =>
      /tests|backup|private|node_modules|README/.test(x),
    ),
  );
  ok("Publication allowlist excludes private data, backups and tooling");
  server = spawn(
    "python3",
    [
      "-m",
      "http.server",
      String(port),
      "--bind",
      "127.0.0.1",
      "--directory",
      directory,
    ],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/Trip-Planner-/`)).ok) break;
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
  });
  let page = await context.newPage();
  const watch = (p) => {
    p.on("pageerror", (e) => report.errors.push(e.message));
    p.on("request", (r) => {
      if (
        !r.url().startsWith(`http://127.0.0.1:${port}/`) &&
        !r.url().startsWith(`blob:http://127.0.0.1:${port}/`)
      )
        report.externalRequests.push(r.url());
    });
  };
  watch(page);
  const url = `http://127.0.0.1:${port}/Trip-Planner-/`;
  await page.goto(url);
  await page.waitForFunction(() =>
    document
      .getElementById("pwa-state")
      .textContent.includes("Offline copy ready"),
  );
  const manifest = JSON.parse(
    await fs.readFile(path.join(site, "manifest.webmanifest"), "utf8"),
  );
  assert.equal(
    await page.locator("link[rel=manifest]").getAttribute("href"),
    "manifest.webmanifest",
  );
  assert.equal(manifest.name, "Personal Trip Planner");
  assert.equal(manifest.display, "standalone");
  assert.equal(new URL(manifest.scope, url).pathname, "/Trip-Planner-/");
  assert.equal(new URL(manifest.start_url, url).href, url);
  assert.equal(
    await page.locator("link[rel=apple-touch-icon]").getAttribute("href"),
    "assets/icon-180.png",
  );
  const swScope = await page.evaluate(
    async () => (await navigator.serviceWorker.getRegistration()).scope,
  );
  assert.equal(swScope, url);
  for (const icon of manifest.icons) {
    const bytes = await fs.readFile(path.join(site, icon.src));
    assert.equal(bytes.readUInt32BE(16), Number(icon.sizes.split("x")[0]));
  }
  ok(
    "Project-specific manifest, standalone icons, iOS metadata and worker scope",
  );
  await page.locator("#install-open").click();
  assert.match(
    await page.locator("#install-dialog").textContent(),
    /Safari.*Share.*Add to Home Screen/s,
  );
  assert.match(
    await page.locator("#install-dialog").textContent(),
    /separate storage/,
  );
  assert.deepEqual(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
    [],
  );
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    assert(
      await page.evaluate(() =>
        document
          .getElementById("install-dialog")
          .contains(document.activeElement),
      ),
    );
  }
  await page.screenshot({
    path: path.join(root, "test-results/mobile-install.png"),
  });
  await page.keyboard.press("Escape");
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "install-open",
  );
  ok(
    "Accessible install instructions, keyboard focus and iOS storage/backup disclosure",
  );
  await page.evaluate(() => {
    const e = new Event("beforeinstallprompt", { cancelable: true });
    e.prompt = async () => {
      window.fakePromptCalled = true;
    };
    e.userChoice = Promise.resolve({ outcome: "dismissed" });
    window.dispatchEvent(e);
  });
  await page.locator("#install-open").click();
  await page.locator("#install-native").click();
  assert(await page.evaluate(() => window.fakePromptCalled));
  assert.match(
    await page.locator("#install-message").textContent(),
    /install later/,
  );
  await page.keyboard.press("Escape");
  ok("Supported install prompt uses a user action and handles dismissal");
  await page.locator("#load-demo").click();
  const input = page.locator("#day-items input[type=file]").first();
  await input.waitFor();
  const png = Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = c.height = 24;
      const x = c.getContext("2d");
      x.fillStyle = "#23483d";
      x.fillRect(0, 0, 24, 24);
      return c.toDataURL().split(",")[1];
    }),
    "base64",
  );
  await input.setInputFiles([
    { name: "fictional-offline-photo.png", mimeType: "image/png", buffer: png },
    {
      name: "fictional-offline-ticket.pdf",
      mimeType: "application/pdf",
      buffer: fictionalPDF(),
    },
  ]);
  await page.locator("#day-items .attachment-row").first().waitFor();
  const initial = await page.evaluate(() =>
    localStorage.getItem("personal-trip-planner.v1"),
  );
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const name = names.find((x) =>
      x.startsWith("personal-trip-planner-shell:"),
    );
    return {
      names,
      urls: (await (await caches.open(name)).keys()).map((r) => r.url),
    };
  });
  assert.equal(cached.urls.length, PUBLIC_ASSETS.length);
  assert(cached.urls.every((x) => x.startsWith(url) && !x.includes("blob:")));
  assert(
    !cached.urls.some((x) => /fictional-offline|backup|private\.json/.test(x)),
  );
  await page.evaluate(async () => {
    await caches.open("other-project-shell:keep");
  });
  ok(
    "Only public shell files are cached; attachment bytes remain solely in IndexedDB",
  );
  await context.setOffline(true);
  await page.reload();
  await page.locator("#day-items .attachment-row").first().waitFor();
  // Chromium's network emulator can leave navigator.onLine unchanged. Exercise
  // the browser offline event separately while the actual network is disabled.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    window.dispatchEvent(new Event("offline"));
  });
  assert.match(
    await page.locator("#pwa-state").textContent(),
    /Device offline/,
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("personal-trip-planner.v1")),
    initial,
  );
  await page
    .locator("#day-items .attachment-row")
    .filter({ hasText: "fictional-offline-photo" })
    .getByRole("button", { name: "Preview", exact: true })
    .click();
  assert.equal(await page.locator("#attachment-preview img").count(), 1);
  await page.keyboard.press("Escape");
  await page
    .locator("#day-items .attachment-row")
    .filter({ hasText: "fictional-offline-ticket" })
    .getByRole("button", { name: "Preview", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .getElementById("attachment-preview-status")
      .textContent.startsWith("Page 1 of"),
  );
  assert.equal(await page.locator("#attachment-preview canvas").count(), 1);
  await page.keyboard.press("Escape");
  ok(
    "PDF first-page preview uses the cached local renderer/worker while offline",
  );
  await page.locator("[data-section=packing]").click();
  const check = page.locator("#packing-items input[type=checkbox]").first();
  await check.click();
  const edited = await page.evaluate(() =>
    localStorage.getItem("personal-trip-planner.v1"),
  );
  assert.notEqual(edited, initial);
  await page.reload();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("personal-trip-planner.v1")),
    edited,
  );
  ok(
    "Offline reopening, private attachment preview and offline edits persist without sync claims",
  );
  await context.setOffline(false);
  await page.locator("[data-section=itinerary]").click();
  // Evicted public cache entry is restored only when bytes match this release.
  await page.evaluate(async () => {
    const name = (await caches.keys()).find((x) =>
      x.startsWith("personal-trip-planner-shell:"),
    );
    await (
      await caches.open(name)
    ).delete(new URL("styles.css", location.href));
  });
  await page.reload();
  await page.locator("#day-items .attachment-row").first().waitFor();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("personal-trip-planner.v1")),
    edited,
  );
  ok(
    "Evicted public asset is safely restored without clearing local user data",
  );
  // Install a coherent new release. Native waiting protects active forms/tabs.
  const originalIndex = await fs.readFile(site + "/index.html", "utf8");
  const nextIndex = originalIndex.replace(
    "Less juggling. More exploring.",
    "More room for your next adventure.",
  );
  await fs.writeFile(site + "/index.html", nextIndex);
  const { createHash } = require("node:crypto");
  const originalWorker = await fs.readFile(site + "/sw.js", "utf8");
  const payload = JSON.parse(
    originalWorker
      .split("\n")[0]
      .replace("self.__PLANNER_SHELL__ = ", "")
      .replace(/;$/, ""),
  );
  payload.version = createHash("sha256")
    .update(built.version + "next")
    .digest("hex");
  payload.assets.find((a) => a.path === "index.html").sha256 = createHash(
    "sha256",
  )
    .update(nextIndex)
    .digest("hex");
  const newWorker = originalWorker.replace(
    originalWorker.split("\n")[0],
    `self.__PLANNER_SHELL__ = ${JSON.stringify(payload)};`,
  );
  await fs.writeFile(site + "/sw.js", newWorker);
  await page.locator("#add-activity").click();
  await page.locator("#field-title").fill("Fictional unsaved draft");
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration()).update();
  });
  await page.waitForFunction(
    async () => !!(await navigator.serviceWorker.getRegistration()).waiting,
  );
  assert.equal(
    await page.locator("#field-title").inputValue(),
    "Fictional unsaved draft",
  );
  assert(
    !(await page
      .locator("footer")
      .textContent()
      .then((s) => s.includes("More room"))),
  );
  await page.waitForFunction(() =>
    document.getElementById("pwa-state").textContent.includes("Update ready"),
  );
  ok(
    "New release waits without force-reloading open forms or mixing asset versions",
  );
  await page.close();
  page = await context.newPage();
  watch(page);
  await page.goto(url);
  await page.waitForFunction(() =>
    document.querySelector("footer").textContent.includes("More room"),
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("personal-trip-planner.v1")),
    edited,
  );
  await page.locator("#day-items .attachment-row").first().waitFor();
  const names = await page.evaluate(() => caches.keys());
  assert(names.includes("other-project-shell:keep"));
  assert.equal(
    names.filter((n) => n.startsWith("personal-trip-planner-shell:")).length,
    1,
  );
  ok(
    "Update activates after all planner windows close, preserving trips/files and other projects caches",
  );
  // Inconsistent deployment must not replace the working release.
  const badPayload = {
    ...payload,
    version: createHash("sha256").update("bad release").digest("hex"),
  };
  await fs.writeFile(
    site + "/sw.js",
    newWorker.replace(
      newWorker.split("\n")[0],
      `self.__PLANNER_SHELL__ = ${JSON.stringify(badPayload)};`,
    ),
  );
  await fs.writeFile(
    site + "/styles.css",
    (await fs.readFile(site + "/styles.css", "utf8")) +
      "\n/* inconsistent release */",
  );
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg.update();
    await new Promise((resolve) => {
      const worker = reg.installing;
      if (!worker) return resolve();
      worker.addEventListener("statechange", () => {
        if (["redundant", "installed"].includes(worker.state)) resolve();
      });
    });
  });
  assert.equal(
    await page.evaluate(
      async () => (await navigator.serviceWorker.getRegistration()).waiting,
    ),
    null,
  );
  await context.setOffline(true);
  await page.reload();
  await page.locator("#day-items .attachment-row").first().waitFor();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("personal-trip-planner.v1")),
    edited,
  );
  ok(
    "Hash mismatch rejects inconsistent update while prior offline copy/data remain usable",
  );
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.externalRequests, []);
  ok("No page errors, remote calls or private data uploads");
  await context.close();
})()
  .catch((e) => {
    report.failure = e.stack;
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    server?.kill();
    await browser?.close();
    await fs.mkdir(path.join(root, "test-results"), { recursive: true });
    await fs.writeFile(
      path.join(root, "test-results/pwa-report.json"),
      JSON.stringify(report, null, 2),
    );
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });
