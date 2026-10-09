const { chromium } = require("playwright");
const { existsSync } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const AxeBuilder = require("@axe-core/playwright").default;
const root = path.resolve(__dirname, ".."),
  port = 8095,
  report = { checks: [], errors: [], externalRequests: [] };
const server = spawn(
  "python3",
  ["-m", "http.server", String(port), "--bind", "127.0.0.1"],
  { cwd: root, stdio: "ignore" },
);
const ok = (name) => {
  report.checks.push(name);
  console.log("✓ " + name);
};
function fictionalPDF() {
  const stream = "0.1 0.3 0.2 rg 10 10 100 50 re f\n",
    objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> /Contents 4 0 R >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    ];
  let pdf = "%PDF-1.4\n",
    offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const start = Buffer.byteLength(pdf);
  pdf +=
    "xref\n0 5\n0000000000 65535 f \n" +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}
const state = (page) =>
  page.evaluate(async () => {
    const m = await import("./attachments.js");
    return (await m.files.list()).map((r) => ({
      id: r.id,
      tripId: r.tripId,
      planId: r.planId,
      name: r.name,
      size: r.size,
    }));
  });
(async () => {
  await fs.mkdir(path.join(root, "test-results"), { recursive: true });
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        acceptDownloads: true,
      }),
      page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(e.message));
    page.on("request", (r) => {
      if (
        !r.url().startsWith(`http://127.0.0.1:${port}/`) &&
        !r.url().startsWith(`blob:http://127.0.0.1:${port}/`)
      )
        report.externalRequests.push(r.url());
    });
    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator("#load-demo").click();
    const card = () =>
      page
        .locator("#day-items article")
        .filter({ hasText: "Train to the coast" });
    await page.waitForFunction(() =>
      [...document.querySelectorAll("#day-items input[type=file]")].some(
        (i) => !i.disabled,
      ),
    );
    const png = Buffer.from(
        await page.evaluate(() => {
          const c = document.createElement("canvas");
          c.width = c.height = 30;
          const x = c.getContext("2d");
          x.fillStyle = "#23483d";
          x.fillRect(0, 0, 30, 30);
          return c.toDataURL("image/png").split(",")[1];
        }),
        "base64",
      ),
      pdf = fictionalPDF();
    await card()
      .locator("input[type=file]")
      .setInputFiles([
        { name: "fictional-photo.png", mimeType: "image/png", buffer: png },
        {
          name: "fictional-ticket.pdf",
          mimeType: "application/pdf",
          buffer: pdf,
        },
      ]);
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#day-items .attachment-row").length === 2,
    );
    assert.equal((await state(page)).length, 2);
    await page.reload();
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#day-items .attachment-row").length === 2,
    );
    ok("Mobile PDF/photo upload and IndexedDB persistence after reload");
    await card()
      .locator(".attachment-row")
      .filter({ hasText: "fictional-photo" })
      .getByRole("button", { name: "Preview", exact: true })
      .click();
    assert.equal(await page.locator("#attachment-preview img").count(), 1);
    await page.keyboard.press("Escape");
    await card()
      .locator(".attachment-row")
      .filter({ hasText: "fictional-ticket" })
      .getByRole("button", { name: "Preview", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        !document
          .getElementById("attachment-preview-status")
          .textContent.startsWith("Loading"),
    );
    assert.match(
      await page.locator("#attachment-preview-status").textContent(),
      /Page 1 of 1/,
    );
    assert.equal(await page.locator("#attachment-preview canvas").count(), 1);
    assert.deepEqual(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze()
      ).violations,
      [],
    );
    await page.screenshot({
      path: path.join(root, "test-results/mobile-pdf-preview.png"),
    });
    await page.keyboard.press("Escape");
    ok("Safe photo preview and locally rasterized PDF first-page preview");
    await card()
      .locator(".attachment-row")
      .filter({ hasText: "fictional-photo" })
      .getByRole("button", { name: "Rename", exact: true })
      .click();
    await page.locator("#field-name").fill("Renamed <photo>.png");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector("#day-items")
        .textContent.includes("Renamed _photo_.png"),
    );
    assert.equal(await page.locator("#day-items script").count(), 0);
    ok("Untrusted filenames sanitized on rename");
    const fileDownload = page.waitForEvent("download");
    await card()
      .locator(".attachment-row")
      .filter({ hasText: "Renamed _photo_" })
      .getByRole("button", { name: "Download", exact: true })
      .click();
    const original = await fileDownload;
    assert.deepEqual(await fs.readFile(await original.path()), png);
    ok("Original attachment download preserves bytes");
    await card()
      .locator("input[type=file]")
      .setInputFiles({
        name: "unsafe.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from('<svg onload="alert(1)"/>'),
      });
    await page.locator("#attachment-warning").waitFor({ state: "visible" });
    assert.match(
      await page.locator("#attachment-warning").textContent(),
      /not accepted/,
    );
    assert.equal((await state(page)).length, 2);
    ok("SVG/executable file rejected without altering existing attachments");
    await page.locator("#backup-open").click();
    const backupDownload = page.waitForEvent("download");
    await page.locator("#export-backup").click();
    const dl = await backupDownload,
      backup = await fs.readFile(await dl.path(), "utf8");
    assert.equal(JSON.parse(backup).attachments.length, 2);
    await page.locator("#import-file").setInputFiles({
      name: "fictional-files-backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(backup),
    });
    await page.locator("#import-preview").waitFor({ state: "visible" });
    assert.match(
      await page.locator("#import-preview").textContent(),
      /2 files/,
    );
    await page.locator("#confirm-import").click();
    await page.waitForFunction(
      () => document.querySelectorAll("#trip-list .trip-choice").length === 2,
    );
    assert.equal((await state(page)).length, 4);
    const ids = (await state(page)).map((r) => r.id);
    assert.equal(new Set(ids).size, 4);
    assert.equal(await card().locator(".attachment-row").count(), 2);
    ok(
      "Full backup/import preserves binary files with independent trip/plan ownership",
    );
    const importedDownload = page.waitForEvent("download");
    await card()
      .locator(".attachment-row")
      .filter({ hasText: "Renamed _photo_" })
      .getByRole("button", { name: "Download", exact: true })
      .click();
    assert.deepEqual(
      await fs.readFile(await (await importedDownload).path()),
      png,
    );
    ok("Imported attachment bytes match the original");
    await page.locator("#trip-list .trip-choice").first().click();
    await card()
      .locator(".attachment-row")
      .filter({ hasText: "fictional-ticket" })
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await page.locator("#confirm-delete").click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#day-items .attachment-row").length === 1,
    );
    assert.equal((await state(page)).length, 3);
    await page.locator("#trip-list .trip-choice").last().click();
    assert.equal(await card().locator(".attachment-row").count(), 2);
    ok("Attachment deletion is isolated to its own trip");
    await page.locator("#trip-list .trip-choice").first().click();
    await page.locator("#delete-trip").click();
    await page.locator("#confirm-delete").click();
    await page.waitForFunction(
      () => document.querySelectorAll("#trip-list .trip-choice").length === 1,
    );
    await page.waitForFunction(async () => {
      const m = await import("./attachments.js");
      return (await m.files.list()).length === 2;
    });
    ok("Deleting a trip removes only its own stored files");
    await card().getByRole("button", { name: "Delete", exact: true }).click();
    await page.locator("#confirm-delete").click();
    await page.waitForFunction(async () => {
      const m = await import("./attachments.js");
      return (await m.files.list()).length === 0;
    });
    ok("Deleting an owning plan removes its attachments");
    // Stays/places have the same accessible attachment workflow.
    await page.locator("[data-section=logistics]").click();
    const stay = page
      .locator("#logistics-items article")
      .filter({ hasText: "Sea Glass Guesthouse" });
    await stay.locator("input[type=file]").setInputFiles({
      name: "fictional-place.png",
      mimeType: "image/png",
      buffer: png,
    });
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#logistics-items .attachment-row").length ===
        1,
    );
    ok("Accommodation/place attachments use the same private workflow");
    await page.locator("#notice").waitFor({ state: "hidden" });
    assert.deepEqual(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze()
      ).violations,
      [],
    );
    await page.screenshot({
      path: path.join(root, "test-results/mobile-attachments.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: path.join(root, "test-results/desktop-attachments.png"),
      fullPage: true,
    });
    ok("Attachment controls and PDF preview pass WCAG A/AA checks");
    await context.close();
    // A view refresh failure after durable import must never roll back its files.
    const failureContext = await browser.newContext(),
      failure = await failureContext.newPage();
    await failure.goto(`http://127.0.0.1:${port}`);
    await failure.locator("#load-demo").click();
    await failure.locator("#backup-open").click();
    await failure.locator("#import-file").setInputFiles({
      name: "fictional-backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(backup),
    });
    await failure.locator("#import-preview").waitFor({ state: "visible" });
    await failure.evaluate(async () => {
      const { files } = await import("./attachments.js"),
        finalize = files.finalize,
        list = files.list;
      files.finalize = async (ids) => {
        await finalize(ids);
        files.list = async () => {
          files.list = list;
          throw Error("Simulated view refresh failure");
        };
      };
    });
    await failure.locator("#confirm-import").click();
    await failure.locator("#attachment-warning").waitFor({ state: "visible" });
    assert.match(
      await failure.locator("#attachment-warning").textContent(),
      /Import was saved/,
    );
    assert.equal(
      await failure.evaluate(
        () =>
          JSON.parse(localStorage.getItem("personal-trip-planner.v1")).trips
            .length,
      ),
      2,
    );
    assert.equal((await state(failure)).length, 2);
    await failure.reload();
    await failure.waitForFunction(
      async () =>
        (await (await import("./attachments.js")).files.list()).length === 2,
    );
    assert.equal((await state(failure)).length, 2);
    ok(
      "Post-commit import refresh failure preserves durable trips and binary files",
    );
    await failureContext.close();
    // Staged files from an in-flight import are protected from startup cleanup.
    const stageContext = await browser.newContext(),
      stage = await stageContext.newPage();
    await stage.goto(`http://127.0.0.1:${port}`);
    await stage.evaluate(
      async (bytes) => {
        const { files, makeRecords } = await import("./attachments.js");
        const rows = await makeRecords(
          [
            new File([Uint8Array.from(bytes)], "fictional.png", {
              type: "image/png",
            }),
          ],
          "pending-trip",
          "pending-plan",
        );
        await files.add(rows);
      },
      [...png],
    );
    await stage.reload();
    await stage.waitForFunction(
      async () =>
        (await (await import("./attachments.js")).files.list()).length === 1,
    );
    assert.equal((await state(stage)).length, 1);
    ok("Startup cleanup protects pending import files before planner commit");
    await stageContext.close();
    const deniedContext = await browser.newContext();
    await deniedContext.addInitScript(() => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
        if (mode === "readwrite" && stores === "attachments")
          throw new DOMException("File quota exceeded", "QuotaExceededError");
        return original.call(this, stores, mode, ...rest);
      };
    });
    const denied = await deniedContext.newPage();
    await denied.goto(`http://127.0.0.1:${port}`);
    await denied.locator("#load-demo").click();
    await denied.waitForFunction(() =>
      [...document.querySelectorAll("#day-items input[type=file]")].some(
        (i) => !i.disabled,
      ),
    );
    await denied.locator("#day-items input[type=file]").first().setInputFiles({
      name: "fictional.png",
      mimeType: "image/png",
      buffer: png,
    });
    await denied.locator("#attachment-warning").waitFor({ state: "visible" });
    assert.match(
      await denied.locator("#attachment-warning").textContent(),
      /quota exceeded/,
    );
    assert.equal((await state(denied)).length, 0);
    ok("IndexedDB quota failure preserves planner and existing files");
    await deniedContext.close();
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.externalRequests, []);
    ok("No browser errors or external attachment/PDF requests");
  } finally {
    await browser.close();
  }
})()
  .catch((e) => {
    report.failure = e.stack;
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    server.kill();
    await fs.writeFile(
      path.join(root, "test-results/attachments-report.json"),
      JSON.stringify(report, null, 2),
    );
  });
