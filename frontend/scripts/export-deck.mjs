// Prints the /deck route to a 16:9 PDF (one slide per page).
// Usage: npm run build && npm run preview   (in another terminal)
//        npm run export:deck [-- http://localhost:4173/deck] [-- ../docs/TwinOps_Deck.pdf]
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:4173/deck';
const out = process.argv[3] ?? '../docs/TwinOps_Deck.pdf';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.emulateMedia({ media: 'print', reducedMotion: 'reduce' });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: out, preferCSSPageSize: true, printBackground: true });
  console.log(`Deck written to ${out}`);
} finally {
  await browser.close();
}
