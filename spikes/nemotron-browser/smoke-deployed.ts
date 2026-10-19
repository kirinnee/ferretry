// SPIKE: prove the deployed page works against REAL Hugging Face downloads, and take screenshots.
//   BENCH_URL=https://ferretry-asr-bench.pages.dev bun spikes/nemotron-browser/smoke-deployed.ts
import { chromium, devices } from '../../packages/pwa/node_modules/playwright-core/index.mjs';

const url = process.env.BENCH_URL ?? 'https://ferretry-asr-bench.pages.dev';
const out = process.env.SHOTS_DIR ?? '/tmp/claude-1000/nemo/shots';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'google-chrome', headless: true });
try {
  for (const [name, options] of [
    ['phone-390-light', { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, colorScheme: 'light' }],
    ['phone-390-dark', { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, colorScheme: 'dark' }],
    ['desktop-1440-light', { viewport: { width: 1440, height: 1000 }, colorScheme: 'light' }],
    ['desktop-1440-dark', { viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' }],
  ] as const) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.on('pageerror', e => console.error(`[page error] ${e.message}`));
    await page.goto(url);
    await page.waitForFunction(() => 'results' in ((globalThis as any).__bench ?? {}));
    if (name === 'phone-390-light') {
      await page.selectOption('#model', 'fastconformer-480');
      const load = await page.evaluate(async () => await (globalThis as any).__bench.load('fastconformer-480'));
      const run = await page.evaluate(async () => await (globalThis as any).__bench.clips('fast'));
      console.log(JSON.stringify({ load, rtf: run.rtf, wer: run.wer }));
    }
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
    await context.close();
  }
} finally {
  await browser.close();
}
