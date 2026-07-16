// Loads the page in a real browser and reports what it did: console errors,
// failed requests, and whether the panels actually rendered. The dev server
// forwards client errors to its own log, but only a real load proves the page
// boots — "загрузка…" forever looks exactly like a slow network otherwise.
//
// Usage: npx tsx scripts/page-check.ts [url]
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:5173/";

const browser = await chromium.launch();
const page = await browser.newPage();

const errors: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("requestfailed", (request) => {
  errors.push(`request failed: ${request.url()} — ${request.failure()?.errorText ?? "?"}`);
});

await page.goto(url, { waitUntil: "networkidle" });
// The wallet extension is absent here, so the panels render without one; that
// is exactly what we want to see — the page must boot regardless.
await page.waitForTimeout(1500);

const body = (await page.textContent("#app")) ?? "";
const stillLoading = body.trim() === "загрузка…";
const panels = await page.locator("section h2").allTextContents();
const buttons = await page.locator("button").count();

console.log(`URL: ${url}`);
console.log(`панели: ${panels.join(" | ") || "(нет)"}`);
console.log(`кнопок на странице: ${buttons}`);
if (stillLoading) console.log("✗ страница застряла на «загрузка…»");
if (errors.length > 0) {
  console.log("\nошибки браузера:");
  for (const error of errors) console.log(`  ✗ ${error}`);
}
await browser.close();

const ok = !stillLoading && errors.length === 0 && panels.length >= 5;
console.log(ok ? "\n✓ страница загрузилась чисто" : "\n✗ страница не в порядке");
process.exit(ok ? 0 : 1);
