// Built Auth-only release with the real pinned SDK and intercepted fictional Auth.
// Never sends credentials, emails, planner data or files to an actual backend.
const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;
const { existsSync } = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."),
  port = 8101;
const backend = "https://psdfjframcinoryyklxf.supabase.co";
const owner = "11111111-1111-4111-8111-111111111111";
const user = {
  id: owner,
  email: "fictional-owner@example.test",
  email_confirmed_at: "2026-10-09T00:00:00Z",
  is_anonymous: false,
};
const report = { checks: [], errors: [], requests: [], axe: [] };
const ok = (text) => {
  report.checks.push(text);
  console.log("✓ " + text);
};
let server, browser, directory;
(async () => {
  const { buildSite, cloudCSP } = await import("../scripts/build-site.js");
  const { cloudConfig } = await import("../cloud-config.js");
  const { authConfigurationReady, configurationReady } =
    await import("../sync-provider.js");
  assert(authConfigurationReady(cloudConfig));
  assert(!configurationReady(cloudConfig));
  assert.equal(cloudConfig.enabled, false);
  assert.equal(cloudConfig.policiesVerified, false);
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "trip-planner-auth-"));
  const site = path.join(directory, "Trip-Planner-");
  await buildSite(site);
  const html = await fs.readFile(path.join(site, "index.html"), "utf8");
  assert.equal(cloudCSP(cloudConfig), "connect-src " + backend);
  assert(html.includes(cloudCSP(cloudConfig)));
  ok(
    "Exact built public config permits Auth with both data gates false and project-only CSP",
  );
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
  const origin = `http://127.0.0.1:${port}`,
    url = origin + "/Trip-Planner-/";
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
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
    serviceWorkers: "block",
  });
  // This handler is installed before any app code. Every backend request stays
  // in this test: only fictional getUser/logout are allowed, never email APIs.
  await context.route(backend + "/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    report.requests.push(pathname);
    if (pathname === "/auth/v1/user" && route.request().method() === "GET")
      return route.fulfill({ json: user });
    if (pathname === "/auth/v1/logout") return route.fulfill({ status: 204 });
    report.errors.push("Unexpected backend request: " + pathname);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.goto(url);
  await page.locator("#sync-open").click();
  await page.locator("#sync-auth").waitFor({ state: "visible" });
  await page.waitForFunction(() =>
    document
      .getElementById("sync-message")
      .textContent.includes("awaiting live access tests"),
  );
  assert.match(
    await page.locator("#sync-disabled").innerText(),
    /no trips or files are sent/,
  );
  assert.deepEqual(report.requests, []);
  const audit = async (name) => {
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    report.axe.push({ name, violations });
    assert.deepEqual(violations, []);
  };
  await audit("built Auth-only mobile sign-in");
  await fs.mkdir(path.join(root, "test-results"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "test-results", "auth-only-mobile.png"),
    fullPage: true,
  });
  ok(
    "Built Auth-only page clearly exposes sign-in and closed-sync notice without backend requests",
  );
  const codes = await page.evaluate(async (owner) => {
    const { cloudConfig } = await import("./cloud-config.js");
    const { createProvider } = await import("./sync-provider.js");
    const provider = await createProvider(cloudConfig);
    const file = {
      objectId: "33333333-3333-4333-8333-333333333333",
      type: "image/png",
      size: 8,
    };
    try {
      const out = [];
      for (const operation of [
        () => provider.assertOwner(owner),
        () => provider.read(owner),
        () => provider.commit(owner, "0", {}),
        () => provider.reserve(owner, file),
        () => provider.upload(owner, file, new Blob(["fictional"])),
        () => provider.download(owner, file),
        () => provider.listObjects(owner),
        () => provider.remove(owner, file.objectId),
        () => provider.release(owner, file.objectId),
      ]) {
        try {
          await operation();
          out.push("UNEXPECTED_SUCCESS");
        } catch (e) {
          out.push(e.code);
        }
      }
      return out;
    } finally {
      provider.close();
    }
  }, owner);
  assert.deepEqual(codes, Array(9).fill("release-gate"));
  assert.deepEqual(report.requests, []);
  ok(
    "Real SDK provider in the built release refuses all nine data operations before any HTTP",
  );
  await page.evaluate(
    async ({ user, owner }) => {
      const { demoTrip } = await import("./model.js");
      localStorage.setItem(
        "personal-trip-planner.v1",
        JSON.stringify({ version: 1, trips: [demoTrip()] }),
      );
      const encode = (text) =>
        btoa(text).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
      const expires_at = Math.floor(Date.now() / 1000) + 3600;
      const token =
        encode(JSON.stringify({ alg: "none" })) +
        "." +
        encode(JSON.stringify({ sub: owner, exp: expires_at })) +
        ".fictional_invalid_signature";
      sessionStorage.setItem(
        "personal-trip-planner.auth." + encodeURIComponent("/Trip-Planner-/"),
        JSON.stringify({
          access_token: token,
          refresh_token: "fictional_invalid_refresh",
          expires_at,
          expires_in: 3600,
          token_type: "bearer",
          user,
        }),
      );
    },
    { user, owner },
  );
  const before = await page.evaluate(() =>
    localStorage.getItem("personal-trip-planner.v1"),
  );
  await page.reload();
  await page.locator("#sync-open").click();
  await page.locator("#sync-account").waitFor({ state: "visible" });
  assert.match(
    await page.locator("#sync-identity").innerText(),
    /fictional-owner@example.test/,
  );
  assert(await page.locator("#sync-join").isHidden());
  assert(await page.locator("#sync-connected").isHidden());
  await page.evaluate(() => document.getElementById("sync-connect").click());
  await page.waitForFunction(
    () => !document.getElementById("sync-close").disabled,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  assert(report.requests.every((x) => x === "/auth/v1/user"));
  assert.equal(
    await page.evaluate(() => localStorage.getItem("personal-trip-planner.v1")),
    before,
  );
  await audit("built Auth-only fictional signed-in account");
  ok(
    "Restored fictional Auth session never previews, connects or sends local plans on reload/reconnection",
  );
  await page.locator("#sync-signout").click();
  await page.locator("#sync-auth").waitFor({ state: "visible" });
  assert.equal(
    await page.evaluate(() =>
      sessionStorage.getItem(
        "personal-trip-planner.auth." + encodeURIComponent("/Trip-Planner-/"),
      ),
    ),
    null,
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("personal-trip-planner.v1")),
    before,
  );
  assert.deepEqual(report.errors, []);
  ok(
    "Real SDK fictional signout clears the session while preserving local plans; no real Auth/email/data requests",
  );
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close();
    server?.kill();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    await fs.mkdir(path.join(root, "test-results"), { recursive: true });
    await fs.writeFile(
      path.join(root, "test-results", "auth-only-report.json"),
      JSON.stringify(report, null, 2),
    );
  });
