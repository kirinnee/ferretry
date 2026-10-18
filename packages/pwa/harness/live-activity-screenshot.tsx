/**
 * The live activity row and every busy mark, on a phone: the working line (`Pontificating… 42s · ↓
 * 3.1k · ↑ 48k`), a running tool, Send while a message leaves, the Reconnecting pill and a harness
 * install — in Studio, Neo-Brutalism and Phosphor, light and dark, as a strip of frames a quarter
 * second apart so the clock ticking and the counts counting up are visible without a video.
 *
 *   bun harness/live-activity-screenshot.tsx      # writes harness/out/live-activity-*.png
 *
 * It renders the REAL `LiveActivityLine`, `ToolGroup` and `ConnectionHealthNoticeView` (Send and the
 * install row are their markup around the real `Spinner`), fed fake usage samples on a timer the way
 * the daemon's `live` frames arrive. Then it SWEEPS EVERY THEME FAMILY in both schemes and fails if a
 * spinner's arc is below the 3:1 contrast WCAG asks of a graphic against the surface it sits on — at
 * full strength and at the reduced-motion pulse's faintest — or if its track is not visible.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { THEME_FAMILIES } from '../src/lib/theme-preferences.ts';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');

/** The reduced-motion pulse's faintest opacity (`fy-spinner-pulse` in spinner.css). */
const PULSE_FLOOR = 0.72;
/** A track a reader can see: well short of the arc, well clear of the surface. */
const TRACK_MIN = 1.4;

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const PAGE_ENTRY = `
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveActivityLine } from '../../src/components/live-activity.tsx';
import { Spinner } from '../../src/components/spinner.tsx';
import { ToolGroup } from '../../src/components/tool-group.tsx';
import { ConnectionHealthNoticeView } from '../../src/features/connection/connection-health-notice.tsx';

const started = new Date(Date.now() - 41_600).toISOString();
const toolStarted = new Date(Date.now() - 6_600).toISOString();

function Live() {
  // Fake usage samples, four a second, the way the daemon's live frames arrive.
  const [sample, setSample] = useState({ out: 3_100, in: 48_200 });
  useEffect(() => {
    const timer = setInterval(() => setSample(current => ({ out: current.out + 140, in: current.in })), 250);
    return () => clearInterval(timer);
  }, []);
  return (
    <LiveActivityLine
      activity={{ harness: 'claude', verb: 'Pontificating…' }}
      live={{ sessionId: 's1', at: new Date().toISOString(), turnStartedAt: started, outputTokens: sample.out, inputTokens: sample.in, outputSource: 'transcript' }}
      turnStartedAt={started}
    />
  );
}

const call = { key: 'c1', ts: toolStarted, use: { name: 'Bash', input: { command: 'bun test --coverage', description: 'Run the unit suite' } } };
const reconnecting = { kind: 'reconnecting', since: Date.now() - 9_000, attempt: 3, nextAttemptAt: null, failures: [], cause: 'unknown', stalled: false } as const;

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main data-fixture="" style={{ margin: '0 auto', maxWidth: 560, padding: '12px 16px', display: 'grid', gap: 14 }}>
    <section className="fy-transcript-shell" data-case="live" style={{ height: 'auto', overflow: 'visible' }}>
      <div className="fy-transcript-content"><Live /></div>
    </section>
    <section data-case="tool"><ToolGroup calls={[call]} isLast live /></section>
    <section data-case="send" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <button aria-label="Sending…" className="fy-composer-send" data-sending="" disabled type="submit">
        <Spinner className="fy-spinner--on-accent" size={18} />
      </button>
      <span className="text-meta text-muted">Send, while a message leaves</span>
    </section>
    <section data-case="pill">
      <ConnectionHealthNoticeView machineName="kirin-box" now={Date.now()} onRetryNow={() => undefined} state={reconnecting} />
    </section>
    <section data-case="install" className="rounded-lg border border-border bg-surface p-3">
      <span className="flex items-center gap-2 text-fg"><Spinner size={16} />Installing Claude Code on kirin-box…</span>
    </section>
  </main>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/live-activity-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'live-activity-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'live-activity-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(outDir, 'app.css'),
]);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    if (url.pathname === '/strip') return new Response(Bun.file(join(outDir, 'live-activity-strip.html')));
    return new Response(Bun.file(join(outDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

interface SpinnerReading {
  readonly where: string;
  readonly arc: [number, number, number, number];
  readonly track: [number, number, number, number];
  readonly surface: [number, number, number];
}

/** Every spinner on the page: its arc and track as sRGB, and the opaque surface under it. */
const readSpinners = async (page: Page): Promise<SpinnerReading[]> =>
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('no 2d context');
    // The canvas resolves any CSS colour — oklch, color-mix, color(srgb) — to sRGB bytes.
    const rgba = (css: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000';
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r ?? 0, g ?? 0, b ?? 0, (a ?? 0) / 255];
    };
    const over = (top: [number, number, number, number], under: [number, number, number]): [number, number, number] => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
    ];
    const surfaceOf = (element: Element): [number, number, number] => {
      const layers: [number, number, number, number][] = [];
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        const layer = rgba(getComputedStyle(node).backgroundColor);
        if (layer[3] > 0) layers.push(layer);
        if (layer[3] >= 1) break;
      }
      let base: [number, number, number] = [255, 255, 255];
      for (const layer of layers.reverse()) base = over(layer, base);
      return base;
    };
    return [...document.querySelectorAll('.fy-spinner')].map(spinner => {
      const arc = spinner.querySelector('.fy-spinner-arc');
      const track = spinner.querySelector('.fy-spinner-track');
      if (arc === null || track === null) throw new Error('a spinner without an arc or a track');
      return {
        where: spinner.closest('[data-case]')?.getAttribute('data-case') ?? 'unknown',
        arc: rgba(getComputedStyle(arc).stroke),
        track: rgba(getComputedStyle(track).stroke),
        surface: surfaceOf(spinner),
      };
    });
  });

const luminance = ([r, g, b]: readonly number[]): number => {
  const [lr, lg, lb] = [r, g, b].map(value => {
    const unit = (value ?? 0) / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
};
const contrast = (a: readonly number[], b: readonly number[]): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};
/** A colour at `alpha` over a surface. */
const blend = (color: readonly number[], alpha: number, surface: readonly number[]): number[] =>
  [0, 1, 2].map(index => (color[index] ?? 0) * alpha + (surface[index] ?? 0) * (1 - alpha));

const FRAMES = 6;
const FRAME_GAP_MS = 250;
const SHOWN = ['studio', 'neo', 'phosphor'] as const;

try {
  // ---- the frame strips: three families × two schemes, phone, real motion -----------------------
  for (const family of SHOWN) {
    for (const scheme of ['light', 'dark'] as const) {
      const theme = `${family}-${scheme}`;
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        colorScheme: scheme,
      });
      try {
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
        );
        const page = await context.newPage();
        await page.goto(`${server.url}?theme=${theme}`);
        await page.locator('[data-fixture]').waitFor({ state: 'visible' });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${theme} scrolls sideways by ${overflow}px`);
        await page.screenshot({ path: join(outDir, `live-activity-phone-${theme}.png`), fullPage: true });
        const frames: string[] = [];
        for (let frame = 0; frame < FRAMES; frame += 1) {
          const shot = await page.locator('[data-case="live"]').screenshot();
          frames.push(`data:image/png;base64,${shot.toString('base64')}`);
          await page.waitForTimeout(FRAME_GAP_MS);
        }
        await Bun.write(
          join(outDir, 'live-activity-strip.html'),
          `<!doctype html><body style="margin:0;background:#888;display:inline-grid;gap:2px;padding:2px">${frames
            .map(
              (src, index) =>
                `<div style="display:flex;align-items:center;gap:6px;font:12px monospace;color:#fff"><span style="width:44px">+${index * FRAME_GAP_MS}ms</span><img src="${src}" style="width:390px"></div>`,
            )
            .join('')}</body>`,
        );
        const strip = await context.newPage();
        await strip.setViewportSize({ width: 450, height: 400 });
        await strip.goto(`${server.url}strip`);
        await strip.locator('body').screenshot({ path: join(outDir, `live-activity-strip-${theme}.png`) });
        process.stdout.write(`📸 live-activity-phone-${theme}.png, live-activity-strip-${theme}.png\n`);
      } finally {
        await context.close();
      }
    }
  }

  // ---- desktop, two themes ---------------------------------------------------------------------
  for (const theme of ['studio-dark', 'neo-light'] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      await context.route('**/*', async route =>
        new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
      );
      const page = await context.newPage();
      await page.goto(`${server.url}?theme=${theme}`);
      await page.locator('[data-fixture]').waitFor({ state: 'visible' });
      await page.screenshot({ path: join(outDir, `live-activity-desktop-${theme}.png`) });
      process.stdout.write(`📸 live-activity-desktop-${theme}.png\n`);
    } finally {
      await context.close();
    }
  }

  // ---- the contrast sweep: every family, both schemes, both motion settings ---------------------
  const failures: string[] = [];
  const table: string[] = [];
  for (const motion of ['no-preference', 'reduce'] as const) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: motion });
    try {
      await context.route('**/*', async route =>
        new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
      );
      const page = await context.newPage();
      for (const family of THEME_FAMILIES) {
        for (const scheme of ['light', 'dark'] as const) {
          const theme = `${family.id}-${scheme}`;
          await page.goto(`${server.url}?theme=${theme}`);
          await page.locator('[data-fixture]').waitFor({ state: 'visible' });
          const spinners = await readSpinners(page);
          if (spinners.length < 5) failures.push(`${theme}: only ${spinners.length} spinners rendered`);
          for (const spinner of spinners) {
            const arc = blend(spinner.arc, spinner.arc[3], spinner.surface);
            const faint = blend(spinner.arc, spinner.arc[3] * (motion === 'reduce' ? PULSE_FLOOR : 1), spinner.surface);
            const track = blend(spinner.track, spinner.track[3], spinner.surface);
            const arcRatio = contrast(motion === 'reduce' ? faint : arc, spinner.surface);
            const trackRatio = contrast(track, spinner.surface);
            if (motion === 'no-preference')
              table.push(
                `${theme.padEnd(18)} ${spinner.where.padEnd(8)} arc ${arcRatio.toFixed(2)}  track ${trackRatio.toFixed(2)}`,
              );
            if (arcRatio < 3)
              failures.push(`${theme} (${motion}) ${spinner.where}: arc is ${arcRatio.toFixed(2)}:1 on its surface`);
            if (trackRatio < TRACK_MIN)
              failures.push(`${theme} ${spinner.where}: track is ${trackRatio.toFixed(2)}:1 — not visible`);
          }
          if (motion === 'no-preference')
            await page.locator('[data-fixture]').screenshot({ path: join(outDir, `live-activity-theme-${theme}.png`) });
        }
      }
    } finally {
      await context.close();
    }
  }
  process.stdout.write(`${table.join('\n')}\n`);
  if (failures.length > 0) fail(`spinner contrast:\n${failures.join('\n')}`);
  process.stdout.write('✅ every theme family keeps every spinner arc at 3:1 or better, in both motion settings\n');
} finally {
  await browser.close();
  server.stop();
}
