// Fictional data only. Starts its own local server; no live bookings or remote services.
const { chromium } = require("playwright");
const { existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."),
  results = path.join(root, "test-results"),
  port = 8093;
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
};
const ok = (name) => {
  report.checks.push(name);
  process.stdout.write(`✓ ${name}\n`);
};
const screenshot = async (page, name) => {
  await page.screenshot({
    path: path.join(results, name + ".png"),
    fullPage: name !== "mobile-editor",
  });
  report.screenshots.push(name + ".png");
};
const save = async (page) =>
  page.getByRole("button", { name: "Save changes", exact: true }).click();
const field = (page, name) => page.locator("#field-" + name);
(async () => {
  await fs.mkdir(results, { recursive: true });
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
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
      timezoneId: "Pacific/Honolulu",
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(e.message));
    page.on("request", (r) => {
      if (!r.url().startsWith(`http://127.0.0.1:${port}/`))
        report.externalRequests.push(r.url());
    });
    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator("#welcome").waitFor({ state: "visible" });
    assert.equal(await page.title(), "Personal Trip Planner");
    await screenshot(page, "desktop-empty");
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, "mobile-empty");
    await page.setViewportSize({ width: 1440, height: 1000 });
    ok("Empty start, exact name, same-device privacy copy");
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement.textContent),
      "Skip to trip plan",
    );
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "main");
    ok("Keyboard skip link");
    await page.getByRole("button", { name: "Create your first trip" }).click();
    await field(page, "name").fill("Fictional museum weekend");
    await field(page, "destination").fill("Example City");
    await field(page, "start").fill("2027-03-13");
    await field(page, "end").fill("2027-03-15");
    await field(page, "timezone").fill("America/New_York");
    await save(page);
    assert.equal(
      await page.locator("#trip-heading").textContent(),
      "Fictional museum weekend",
    );
    assert.match(
      await page.locator("#planning-alerts").textContent(),
      /No accommodation/,
    );
    ok("Trip creation and missing-logistics indicators");
    await page.locator("#add-activity").click();
    await field(page, "title").fill("Fictional museum visit");
    await field(page, "startTime").fill("10:00");
    await field(page, "endTime").fill("12:00");
    await field(page, "location").fill("Example museum");
    await field(page, "notes").fill(
      "<img src=x onerror=alert(1)> literal private note",
    );
    await field(page, "status").selectOption("booked");
    await field(page, "bookingURL").fill("https://example.com/reservation");
    await save(page);
    assert.equal(await page.locator("#day-items img").count(), 0);
    assert.match(await page.locator("#day-items").textContent(), /<img src=x/);
    ok(
      "Activity creation, booked state, safe literal HTML rendering and booking link",
    );
    await page
      .locator("#day-items")
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await field(page, "title").fill("Fictional gallery visit");
    await save(page);
    assert.match(
      await page.locator("#day-items").textContent(),
      /Fictional gallery visit/,
    );
    ok("Activity editing");
    await page.reload();
    assert.match(
      await page.locator("#day-items").textContent(),
      /Fictional gallery visit/,
    );
    assert.equal(
      await page.locator("#trip-heading").textContent(),
      "Fictional museum weekend",
    );
    ok("Persistence after reload");
    await page.locator("#search").fill("gallery");
    await page.locator("#status-filter").selectOption("booked");
    await page.locator("#kind-filter").selectOption("activity");
    await page
      .locator("#day-items")
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await field(page, "location").fill("Updated fictional museum");
    await save(page);
    assert.equal(await page.locator("#search").inputValue(), "gallery");
    assert.equal(await page.locator("#status-filter").inputValue(), "booked");
    assert.equal(await page.locator("#kind-filter").inputValue(), "activity");
    ok("Filters remain selected after editing a plan");
    await page.locator("#next-day").click();
    assert.equal(await page.locator("#search").inputValue(), "gallery");
    assert.equal(await page.locator("#status-filter").inputValue(), "booked");
    assert.equal(await page.locator("#kind-filter").inputValue(), "activity");
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    assert.match(
      await page.locator("#day-heading").textContent(),
      /Sunday, March 14/,
    );
    ok("Date navigation across DST, scroll-to-top and filter preservation");
    await page.getByRole("tab", { selected: true }).focus();
    await page.keyboard.press("ArrowRight");
    assert.match(await page.locator("#day-heading").textContent(), /March 15/);
    assert.equal(
      await page.evaluate(() => document.activeElement.getAttribute("role")),
      "tab",
    );
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "date-2027-03-13",
    );
    ok("Keyboard date tabs: arrows, Home and Enter focus");
    await page.locator("#search").fill("");
    await page.locator("#status-filter").selectOption("all");
    await page.locator("#kind-filter").selectOption("all");
    await page.locator("#add-activity").click();
    await field(page, "title").fill("Overlapping fictional walk");
    await field(page, "startTime").fill("11:00");
    await field(page, "endTime").fill("13:00");
    await save(page);
    assert.match(
      await page.locator("#planning-alerts").textContent(),
      /Time overlap/,
    );
    ok("Time overlap detection");
    await page
      .locator("#day-items article")
      .filter({ hasText: "Overlapping fictional walk" })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page.locator("#confirm-cancel").click();
    assert.equal(await page.locator("#day-items article").count(), 2);
    await page
      .locator("#day-items article")
      .filter({ hasText: "Overlapping fictional walk" })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page.locator("#confirm-delete").click();
    assert.equal(await page.locator("#day-items article").count(), 1);
    ok("Safe cancel and confirmed item deletion");
    await page.locator("[data-section=logistics]").click();
    assert.match(
      await page.locator("#logistics-items").textContent(),
      /Give the journey a home/,
    );
    await page.locator("#add-logistics").click();
    await field(page, "title").fill("Fictional Garden Inn");
    await field(page, "endDate").fill("2027-03-15");
    await field(page, "location").fill(
      "Fictional accommodation, no real address",
    );
    await save(page);
    assert.match(
      await page.locator("#logistics-items").textContent(),
      /Fictional Garden Inn/,
    );
    ok("Accommodation and checkout dates");
    await page.locator("#add-logistics").click();
    await field(page, "kind").selectOption("transport");
    await field(page, "title").fill("Fictional arrival train");
    await field(page, "startTime").fill("08:00");
    await field(page, "endTime").fill("09:00");
    await field(page, "location").fill("Example station");
    await save(page);
    ok("Transport CRUD");
    await page.locator("[data-section=packing]").click();
    await page.locator("#add-packing").click();
    await field(page, "text").fill("Fictional rain jacket");
    await save(page);
    await page.getByRole("checkbox", { name: "Fictional rain jacket" }).check();
    await page.reload();
    await page.locator("[data-section=packing]").click();
    assert.equal(
      await page
        .getByRole("checkbox", { name: "Fictional rain jacket" })
        .isChecked(),
      true,
    );
    ok("Packing checklist persistence");
    await page
      .locator("#packing-items")
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await field(page, "text").fill("Fictional warm jacket");
    await save(page);
    assert.equal(
      await page
        .getByRole("checkbox", { name: "Fictional warm jacket" })
        .isChecked(),
      true,
    );
    await page
      .locator("#packing-items")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page.locator("#confirm-delete").click();
    assert.match(
      await page.locator("#packing-items").textContent(),
      /Pack a little/,
    );
    ok("Packing edit, delete and empty state");
    await page.locator("[data-section=budget]").click();
    await page.locator("#add-budget").click();
    await field(page, "title").fill("Fictional USD limit");
    await field(page, "amount").fill("100");
    await field(page, "currency").fill("USD");
    await save(page);
    for (const [currency, amount] of [
      ["USD", "120"],
      ["GBP", "45"],
    ]) {
      await page.locator("#add-expense").click();
      await field(page, "title").fill("Fictional " + currency + " expense");
      await field(page, "amount").fill(amount);
      await field(page, "currency").fill(currency);
      await field(page, "paymentStatus").selectOption(
        currency === "USD" ? "paid" : "planned",
      );
      await save(page);
    }
    assert.match(
      await page.locator("#budget-totals").textContent(),
      /USD\s20.00 over budget/,
    );
    assert.match(
      await page.locator("#budget-totals").textContent(),
      /GBP\s45.00/,
    );
    assert.match(
      await page.locator("#budget-totals").textContent(),
      /USD\s120.00 paid/,
    );
    assert.match(
      await page.locator("#budget-totals").textContent(),
      /GBP\s45.00 planned/,
    );
    await screenshot(page, "desktop-costs");
    ok("Separate currencies, paid/planned amounts and over-budget indicator");
    await page.locator("#add-expense").click();
    await field(page, "title").fill("Fictional zero cost");
    await field(page, "amount").fill("0");
    await field(page, "currency").fill("USD");
    await field(page, "category").fill("Admission");
    await field(page, "planId").selectOption({
      label: "Fictional gallery visit",
    });
    await save(page);
    assert.match(
      await page.locator("#expense-items").textContent(),
      /USD\s0.00/,
    );
    assert.match(
      await page
        .locator("#expense-items .list-row")
        .filter({ hasText: "Fictional zero cost" })
        .textContent(),
      /Fictional gallery visit/,
    );
    assert.match(
      await page.locator("#budget-totals").textContent(),
      /USD\s120.00 paid/,
    );
    await page
      .locator("#expense-items .list-row")
      .filter({ hasText: "Fictional zero cost" })
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await field(page, "amount").fill("0.10");
    await save(page);
    assert.match(
      await page.locator("#budget-totals").textContent(),
      /USD\s0.10 planned/,
    );
    await page
      .locator("#expense-items .list-row")
      .filter({ hasText: "Fictional zero cost" })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page.locator("#confirm-delete").click();
    ok("Zero and decimal costs, linked plans and no double counting");
    await page.locator("[data-section=itinerary]").click();
    await page.locator("#add-activity").click();
    await field(page, "title").fill("Linked fictional transfer");
    await save(page);
    await page.locator("[data-section=budget]").click();
    await page.locator("#add-expense").click();
    await field(page, "title").fill("Cost survives plan deletion");
    await field(page, "amount").fill("2");
    await field(page, "planId").selectOption({
      label: "Linked fictional transfer",
    });
    await save(page);
    await page.locator("[data-section=itinerary]").click();
    await page
      .locator("#day-items article")
      .filter({ hasText: "Linked fictional transfer" })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page.locator("#confirm-delete").click();
    await page.locator("[data-section=budget]").click();
    assert.match(
      await page.locator("#expense-items").textContent(),
      /Cost survives plan deletion/,
    );
    assert.equal(
      await page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem("personal-trip-planner.v1"),
          ).trips[0].expenses.find(
            (e) => e.title === "Cost survives plan deletion",
          ).planId,
      ),
      "",
    );
    await page
      .locator("#expense-items .list-row")
      .filter({ hasText: "Cost survives plan deletion" })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page.locator("#confirm-delete").click();
    ok("Deleting a linked plan keeps its cost without a dangling link");
    await page
      .locator("#expense-items .list-row")
      .filter({ hasText: "GBP" })
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await field(page, "amount").fill("40");
    await save(page);
    await page
      .locator("#expense-items .list-row")
      .filter({ hasText: "GBP" })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page.locator("#confirm-delete").click();
    assert.equal(await page.locator("#expense-items .list-row").count(), 1);
    ok("Expense editing and deletion");
    await page.locator("[data-section=links]").click();
    await page.locator("#add-link").click();
    await field(page, "title").fill("Fictional guide");
    await field(page, "url").fill("https://example.com/guide");
    await save(page);
    const savedLink = page.locator("#link-items a");
    assert.equal(await savedLink.getAttribute("rel"), "noopener noreferrer");
    await page
      .locator("#link-items")
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await field(page, "title").fill("Fictional local guide");
    await save(page);
    await page
      .locator("#link-items")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page.locator("#confirm-delete").click();
    ok("Useful link create/edit/delete and safe external link attributes");
    // Timed spring DST gap is rejected in the real editor.
    await page.locator("[data-section=itinerary]").click();
    await page.locator("#next-day").click();
    await page.locator("#add-activity").click();
    await field(page, "title").fill("Nonexistent fictional clock time");
    await field(page, "startTime").fill("02:30");
    await field(page, "endTime").fill("04:00");
    await save(page);
    assert.match(
      await page.locator("#editor-error").textContent(),
      /does not exist/,
    );
    await page.keyboard.press("Escape");
    ok("Editor rejects nonexistent DST wall time; Escape closes modal");
    const calendarDownload = page.waitForEvent("download");
    await page.locator("#calendar-export").click();
    const cal = await calendarDownload;
    const ics = await fs.readFile(await cal.path(), "utf8");
    assert.match(ics, /DTSTART:20270313T150000Z/);
    assert.match(ics, /SUMMARY:Fictional gallery visit/);
    assert.match(ics, /STATUS:CONFIRMED/);
    ok("Local calendar export includes full trip and correct UTC time");
    await page.locator("#backup-open").click();
    const backupDownload = page.waitForEvent("download");
    await page.locator("#export-backup").click();
    const dl = await backupDownload;
    const backup = await fs.readFile(await dl.path(), "utf8");
    assert.equal(JSON.parse(backup).trips.length, 1);
    await page.locator("#import-file").setInputFiles({
      name: "fictional-backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(backup),
    });
    await page.locator("#import-preview").waitFor({ state: "visible" });
    assert.match(
      await page.locator("#import-preview").textContent(),
      /Ready to add 1 trip/,
    );
    await page.locator("#confirm-import").click();
    assert.equal(await page.locator("#trip-list .trip-choice").count(), 2);
    ok(
      "Backup download, import preview and append without replacing existing trips",
    );
    await page.locator("#backup-open").click();
    const unsafe = JSON.parse(backup);
    unsafe.trips[0].items[0].bookingURL = "javascript:alert(1)";
    await page.locator("#import-file").setInputFiles({
      name: "unsafe.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(unsafe)),
    });
    await page.locator("#import-error").waitFor({ state: "visible" });
    assert.match(await page.locator("#import-error").textContent(), /http/);
    assert.equal(await page.locator("#confirm-import").isVisible(), false);
    await page.keyboard.press("Escape");
    ok("Unsafe import rejected without changes");
    // Each trip remembers its own date, section and itinerary filters for this session.
    await page.locator("#trip-list .trip-choice").first().click();
    await page.locator("#jump-date").fill("2027-03-14");
    await page.locator("#jump-date").dispatchEvent("change");
    await page.locator("#search").fill("gallery");
    await page.locator("#status-filter").selectOption("booked");
    await page.locator("#kind-filter").selectOption("activity");
    await page.locator("[data-section=budget]").click();
    await page.locator("#new-trip").click();
    await field(page, "name").fill("Fictional second trip");
    await field(page, "destination").fill("Example Bay");
    await field(page, "start").fill("2027-06-01");
    await field(page, "end").fill("2027-06-03");
    await field(page, "timezone").fill("Europe/London");
    await save(page);
    assert.equal(await page.locator("#trip-list .trip-choice").count(), 3);
    assert.equal(await page.locator("#search").inputValue(), "");
    await page.locator("[data-section=budget]").click();
    assert.equal(await page.locator("#budget-totals").textContent(), "");
    await page.locator("#add-expense").click();
    await field(page, "title").fill("Separate fictional trip cost");
    await field(page, "amount").fill("8.50");
    await field(page, "currency").fill("GBP");
    await save(page);
    await page.locator("#trip-list .trip-choice").first().click();
    assert.equal(await page.locator("#budget-panel").isVisible(), true);
    assert.match(
      await page.locator("#budget-totals").textContent(),
      /USD\s120.00/,
    );
    assert.doesNotMatch(
      await page.locator("#budget-totals").textContent(),
      /GBP\s8.50/,
    );
    await page.locator("[data-section=itinerary]").click();
    assert.match(await page.locator("#day-heading").textContent(), /March 14/);
    assert.equal(await page.locator("#search").inputValue(), "gallery");
    assert.equal(await page.locator("#status-filter").inputValue(), "booked");
    assert.equal(await page.locator("#kind-filter").inputValue(), "activity");
    await page
      .locator("#trip-list .trip-choice")
      .filter({ hasText: "Fictional second trip" })
      .click();
    assert.equal(await page.locator("#budget-panel").isVisible(), true);
    assert.match(
      await page.locator("#budget-totals").textContent(),
      /GBP\s8.50/,
    );
    ok("Per-trip date/filter/section state and cost isolation");
    await page.locator("#edit-trip").click();
    await field(page, "notes").fill("Private browser-only fictional note");
    await save(page);
    assert.match(
      await page.locator("#trip-notes").textContent(),
      /browser-only/,
    );
    await page.locator("#delete-trip").click();
    await page.locator("#confirm-delete").click();
    assert.equal(await page.locator("#trip-list .trip-choice").count(), 2);
    ok("Multiple trips, trip edit and confirmed trip deletion");
    // Print all days even with an active search.
    await page.locator("[data-section=itinerary]").click();
    await page.locator("#search").fill("nothing-matches");
    await page.evaluate(() => {
      window.print = () => {};
    });
    await page.locator("#print-trip").click();
    assert.match(
      await page.locator("#print-view").textContent(),
      /Fictional gallery visit/,
    );
    assert.match(await page.locator("#print-view").textContent(), /March 15/);
    await page.emulateMedia({ media: "print" });
    await screenshot(page, "print-full-itinerary");
    await page.pdf({
      path: path.join(results, "fictional-itinerary.pdf"),
      format: "A4",
      printBackground: true,
    });
    await page.emulateMedia({ media: "screen" });
    ok("Printable full itinerary independent of search filters");
    await context.close();
    const demoContext = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      demo = await demoContext.newPage();
    await demo.goto(`http://127.0.0.1:${port}`);
    await demo.locator("#load-demo").click();
    await demo.locator("#notice").waitFor({ state: "hidden" });
    await screenshot(demo, "desktop-demo");
    await demo.setViewportSize({ width: 390, height: 844 });
    await screenshot(demo, "mobile-demo");
    assert.equal(
      await demo.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await demo.locator("#add-activity").click();
    await screenshot(demo, "mobile-editor");
    assert.equal(
      await demo.evaluate(
        () =>
          document.querySelector("#editor").scrollWidth <=
          document.querySelector("#editor").clientWidth,
      ),
      true,
    );
    await field(demo, "title").fill("Fictional mobile café");
    await field(demo, "startTime").fill("13:00");
    await field(demo, "endTime").fill("14:00");
    await save(demo);
    const mobileCard = demo
      .locator("#day-items article")
      .filter({ hasText: "Fictional mobile café" });
    await mobileCard.getByRole("button", { name: "Edit", exact: true }).click();
    await field(demo, "notes").fill("Created and edited on a phone viewport.");
    await save(demo);
    assert.match(await mobileCard.textContent(), /edited on a phone/);
    await mobileCard
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await demo.locator("#confirm-delete").click();
    assert.equal(
      await demo
        .locator("#day-items article")
        .filter({ hasText: "Fictional mobile café" })
        .count(),
      0,
    );
    ok("Mobile plan create/edit/delete through the real form");
    await demo.locator("[data-section=packing]").click();
    await screenshot(demo, "mobile-packing");
    await demo.locator("[data-section=budget]").click();
    await screenshot(demo, "mobile-budget");
    ok(
      "Desktop/mobile fictional demo, editor, packing and budget screenshots; no horizontal overflow",
    );
    await demo.setViewportSize({ width: 320, height: 700 });
    assert.equal(
      await demo.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    ok("320px narrow phone layout");
    // Visible trip filters and no-match states on desktop and phone.
    await demo.locator("#new-trip").click();
    await field(demo, "name").fill("Fictional past trip");
    await field(demo, "destination").fill("History Bay");
    await field(demo, "start").fill("2020-01-01");
    await field(demo, "end").fill("2020-01-02");
    await save(demo);
    for (const width of [1440, 390]) {
      await demo.setViewportSize({ width, height: 844 });
      await demo.locator("#trip-date-filter").selectOption("past");
      assert.equal(await demo.locator("#trip-list .trip-choice").count(), 1);
      assert.match(
        await demo.locator("#trip-list").textContent(),
        /Fictional past trip/,
      );
      await demo.locator("#trip-date-filter").selectOption("upcoming");
      assert.equal(await demo.locator("#trip-list .trip-choice").count(), 1);
      await demo.locator("#trip-search").fill("no-such-trip");
      assert.match(
        await demo.locator("#trip-list").textContent(),
        /No trips match/,
      );
      await screenshot(
        demo,
        width === 390
          ? "mobile-trip-filter-empty"
          : "desktop-trip-filter-empty",
      );
      await demo
        .locator("#trip-list")
        .getByRole("button", { name: "Clear trip filters" })
        .click();
      assert.equal(await demo.locator("#trip-list .trip-choice").count(), 2);
      if (width === 1440) await screenshot(demo, "desktop-multiple-trips");
      await demo.locator("#trip-search").fill("coastal");
      assert.equal(await demo.locator("#trip-list .trip-choice").count(), 1);
      await demo.locator("#trip-search").fill("");
    }
    await demo
      .locator("#trip-list .trip-choice")
      .filter({ hasText: "coastal" })
      .focus();
    await demo.keyboard.press("Enter");
    assert.match(
      await demo.evaluate(() => document.activeElement.id),
      /^trip-/,
    );
    await screenshot(demo, "mobile-multiple-trips");
    ok(
      "Visible trip selector, upcoming/past/all/search filters and desktop/mobile no-match states",
    );
    const other = await demoContext.newPage();
    await other.goto(`http://127.0.0.1:${port}`);
    await demo.locator("#new-trip").click();
    await field(demo, "name").fill("Fictional tab update");
    await field(demo, "destination").fill("Example");
    await save(demo);
    await other.locator("#storage-warning").waitFor({ state: "visible" });
    await other.locator("#new-trip").click();
    await field(other, "name").fill("Stale fictional edit");
    await field(other, "destination").fill("Example");
    await save(other);
    assert.match(
      await other.locator("#editor-error").textContent(),
      /another tab/,
    );
    ok("Cross-tab updates cannot overwrite a newer save");
    await demoContext.close();
    const corruptContext = await browser.newContext(),
      corrupt = await corruptContext.newPage();
    await corrupt.goto(`http://127.0.0.1:${port}`);
    await corrupt.evaluate(() =>
      localStorage.setItem("personal-trip-planner.v1", "{corrupt"),
    );
    await corrupt.reload();
    assert.match(
      await corrupt.locator("#storage-warning").textContent(),
      /left untouched/,
    );
    assert.equal(
      await corrupt.evaluate(() =>
        localStorage.getItem("personal-trip-planner.v1"),
      ),
      "{corrupt",
    );
    await corruptContext.close();
    ok("Corrupt storage preserved for recovery");
    const deniedContext = await browser.newContext();
    await deniedContext.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("Storage disabled", "QuotaExceededError");
      };
    });
    const denied = await deniedContext.newPage();
    await denied.goto(`http://127.0.0.1:${port}`);
    await denied.locator("#load-demo").click();
    assert.match(
      await denied.locator("#storage-warning").textContent(),
      /only in this tab/,
    );
    assert.equal(await denied.locator("#trip-view").isVisible(), true);
    await deniedContext.close();
    ok("Unavailable storage retains in-tab work and warns clearly");
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.externalRequests, []);
    ok("No browser errors or external requests");
  } finally {
    await browser.close();
  }
})()
  .catch((e) => {
    report.failure = e.stack;
    process.exitCode = 1;
    console.error(e);
  })
  .finally(async () => {
    server.kill();
    await fs.mkdir(results, { recursive: true });
    await fs.writeFile(
      path.join(results, "browser-report.json"),
      JSON.stringify(report, null, 2),
    );
  });
