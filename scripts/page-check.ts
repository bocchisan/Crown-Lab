// Loads the page in a real browser and reports what it did: console errors,
// failed requests, and whether the panels actually rendered. The dev server
// forwards client errors to its own log, but only a real load proves the page
// boots — "загрузка…" forever looks exactly like a slow network otherwise.
//
// With SEED=1 it also seeds the e2e keypairs as burners and reads the
// participants table back, which exercises the whole read path in the browser:
// balances from devnet and reputation from crown-index on the live replica.
//
// Usage: npx tsx scripts/page-check.ts [url]
//        SEED=1 npx tsx scripts/page-check.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:5173/";
const seed = process.env.SEED === "1";

function burner(path: string, label: string): { label: string; secret: string } {
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
  return { label, secret: bs58.encode(Keypair.fromSecretKey(secret).secretKey) };
}

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

if (seed) {
  const burners = [
    burner(`${homedir()}/.cache/crown-e2e/donor.json`, "донор"),
    burner(`${homedir()}/.cache/crown-e2e/streamer.json`, "получатель"),
  ];
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key as string, value as string),
    ["crown-lab:burners", JSON.stringify(burners)] as const,
  );
}

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

let seeded = true;
if (seed) {
  // Reputation is local to a recipient, so point the book column at one.
  // The second participant is the recipient the e2e keys donate to.
  await page.locator('label:has-text("книга получателя") select').selectOption({ index: 1 });
  await page.waitForTimeout(6000);
  const rows = await page.locator("tbody tr").allTextContents();
  console.log("\nтаблица участников:");
  for (const row of rows) console.log(`  ${row.replace(/\s+/g, " ").trim()}`);
  const donorRow = rows.find((row) => row.includes("донор")) ?? "";
  seeded = /\d/.test(donorRow) && !donorRow.includes("— —");
  if (!seeded) console.log("✗ у донора не заполнились балансы/репутация");
}

if (stillLoading) console.log("✗ страница застряла на «загрузка…»");
if (errors.length > 0) {
  console.log("\nошибки браузера:");
  for (const error of errors) console.log(`  ✗ ${error}`);
}
await browser.close();

const ok = !stillLoading && errors.length === 0 && panels.length >= 5 && seeded;
console.log(ok ? "\n✓ страница загрузилась чисто" : "\n✗ страница не в порядке");
process.exit(ok ? 0 : 1);
