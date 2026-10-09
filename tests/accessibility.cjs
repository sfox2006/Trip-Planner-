const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;
const { existsSync } = require("node:fs");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const path = require("node:path");
const root = path.resolve(__dirname, ".."),
  port = 8094;
const server = spawn(
  "python3",
  ["-m", "http.server", String(port), "--bind", "127.0.0.1"],
  { cwd: root, stdio: "ignore" },
);
(async () => {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    headless: true,
    args: ["--no-sandbox"],
  });
  const checks = [];
  try {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}`);
    const audit = async (name) => {
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      checks.push({ name, violations: result.violations });
      if (result.violations.length) {
        console.error(
          name,
          JSON.stringify(
            result.violations.map((v) => ({
              id: v.id,
              nodes: v.nodes.map((n) => ({
                html: n.html,
                summary: n.failureSummary,
              })),
            })),
            null,
            2,
          ),
        );
        process.exitCode = 1;
      } else console.log(`✓ ${name}: no WCAG A/AA axe violations`);
    };
    await audit("desktop-empty");
    await page.locator("#load-demo").click();
    await page.locator("#notice").waitFor({ state: "hidden" });
    await audit("desktop-itinerary");
    await page.setViewportSize({ width: 390, height: 844 });
    await audit("mobile-itinerary");
    for (const section of ["packing", "budget", "links", "logistics"]) {
      await page.locator(`[data-section=${section}]`).click();
      await audit("mobile-" + section);
    }
    await page.locator("#add-logistics").click();
    await audit("mobile-editor");
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Tab");
      if (
        !(await page.evaluate(() =>
          document.querySelector("#editor").contains(document.activeElement),
        ))
      )
        throw Error("Modal focus escaped the native dialog.");
    }
    console.log("✓ Native editor dialog traps keyboard focus");
    await page.keyboard.press("Escape");
    await page.locator("#backup-open").click();
    await audit("mobile-backup-dialog");
  } finally {
    await fs.mkdir(path.join(root, "test-results"), { recursive: true });
    await fs.writeFile(
      path.join(root, "test-results/accessibility-report.json"),
      JSON.stringify(checks, null, 2),
    );
    await browser.close();
  }
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => server.kill());
