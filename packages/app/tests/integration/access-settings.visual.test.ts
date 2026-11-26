/**
 * ACCESS SETTINGS in the REAL Settings shell (`fixtures/access-settings-register.ts` over `fixtures/settings-shell-scene.tsx`: the real `App`, the real nav, the real
 * panel width) over one fake machine. Checked at 768 (where the settings list stands above a panel of at least 480px), 1280 and 390, light and dark:
 *  - the layout answers to the SETTINGS PANEL's width, never the window: `.fy-acc` is a size container, and the pairing code's
 *    QR sits beside its facts only when the panel is wide enough (so at a 768px window it is stacked);
 *  - one level of surface: no bordered box inside another bordered box;
 *  - nothing is clipped or scrolls sideways; every control keeps the 44px floor;
 *  - the capability switches of one device line up in two columns, a switch's box never above its words.
 * Set `FY_ACCESS_SETTINGS_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';
import type { BrowserContext, Page } from 'playwright-core';

setDefaultTimeout(90_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_ACCESS_SETTINGS_SHOTS_DIR ?? '';

let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-access-settings-'));
  // The entry is generated: the register module puts Access's fake answers on the shell scene, THEN the scene is imported (it reads
  // the registration once; a plain side-effect import would be dropped by `sideEffects: false`).
  const entry = join(directory, 'entry.tsx');
  await Bun.write(
    entry,
    `import { registerAccessSettings } from ${JSON.stringify(resolve(packageRoot, 'fixtures/access-settings-register.ts'))};\nregisterAccessSettings();\nawait import(${JSON.stringify(resolve(packageRoot, 'fixtures/settings-shell-scene.tsx'))});\n`,
  );
  const child = Bun.spawn([process.execPath, sceneBuilder, '--out', directory, '--entry', entry], {
    cwd: packageRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the Access settings scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, self) => {
      const path = new URL(request.url).pathname;
      // A socket that echoes: it exists so the leak watch can be shown to read frames, and the app never opens one here.
      if (path === '/echo' && self.upgrade(request, { data: undefined })) return undefined;
      return path === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } });
    },
    websocket: {
      message: (socket, message) => {
        socket.send(message);
      },
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 300_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '768', width: 768, height: 1_000, phone: false },
  { name: '1280', width: 1_280, height: 1_000, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
const THEMES = ['studio-light', 'studio-dark'] as const;
const TABS = ['devices', 'grants', 'security', 'audit'] as const;
type Tab = (typeof TABS)[number];
const READY: Record<Tab, string> = {
  devices: '[data-add-device-surface]',
  grants: '[data-grant-surface]',
  security: '[data-security-settings]',
  audit: '[data-security-log-panel]',
};

/** The fixed fake pairing code of `fixtures/access-settings-data.ts`: two groups of it are enough to know it. */
const holdsCode = (text: string): boolean => /7F3K|Q2ND/i.test(text);

/**
 * Everything a pairing code must be in NONE of, however the page could have said it outside its own screen: a page error, a
 * console line and every object it was given, each request's URL, headers and body, each WebSocket frame either way. `inPage`
 * reads what the page keeps: its title, its address and history state, every attribute value, and what it stored. A real
 * browser reads each; nothing is inferred.
 */
const watchLeaks = (page: Page, context: BrowserContext) => {
  const said: string[] = [];
  const pending: Promise<void>[] = [];
  page.on('pageerror', error => said.push(`pageerror ${error.message} ${error.stack ?? ''}`));
  page.on('console', message => {
    said.push(`console ${message.text()}`);
    for (const argument of message.args())
      pending.push(
        argument
          .jsonValue()
          .then(value => void said.push(`console-arg ${JSON.stringify(value)}`))
          .catch(() => undefined),
      );
  });
  page.on('request', request => {
    said.push(`request ${request.url()} ${JSON.stringify(request.headers())} ${request.postData() ?? ''}`);
  });
  page.on('websocket', socket => {
    said.push(`websocket ${socket.url()}`);
    socket.on('framesent', frame => said.push(`frame-sent ${String(frame.payload)}`));
    socket.on('framereceived', frame => said.push(`frame-received ${String(frame.payload)}`));
  });
  return {
    /** Every line the page said outside itself so far, once the reads still in flight have landed. */
    leaked: async (): Promise<string[]> => {
      await Promise.all(pending);
      return said.filter(holdsCode);
    },
    /** What the page keeps, other than the words on its screen. */
    inPage: async (): Promise<string[]> => {
      const kept = await page.evaluate(() => {
        const out: string[] = [`title ${document.title}`, `location ${location.href}`];
        out.push(`history ${JSON.stringify(history.state)}`);
        for (const element of document.querySelectorAll('*'))
          for (const attribute of element.attributes)
            out.push(`attribute ${element.tagName}[${attribute.name}] ${attribute.value}`);
        for (const store of [localStorage, sessionStorage])
          for (let at = 0; at < store.length; at += 1) {
            const key = store.key(at) ?? '';
            out.push(`storage ${key} ${store.getItem(key) ?? ''}`);
          }
        return out;
      });
      const cookies = (await context.cookies()).map(cookie => `cookie ${cookie.name} ${cookie.value}`);
      return [...kept, ...cookies].filter(holdsCode);
    },
  };
};

const open = async (viewport: (typeof VIEWPORTS)[number], theme: string, tab: Tab, state = 'default') => {
  const ready = state === 'refused' ? '[data-security-log-refused]' : READY[tab];
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
    colorScheme: theme.endsWith('dark') ? 'dark' : 'light',
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  const leaks = watchLeaks(page, context);
  await page.goto(`${origin}/d/ws/settings/access/${tab}?theme=${theme}&state=${state}`);
  try {
    // A phone opens the list first; a tab link opens the page.
    await page.waitForSelector(`${ready}, .fy-settings-page`, { timeout: 15_000 });
    await page.waitForSelector(ready, { timeout: 15_000 });
  } catch (error) {
    const seen = (
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(0, 600);
    throw new Error(`the scene did not draw ${ready}: ${String(error)}\n${problems.join('\n')}\nON SCREEN: ${seen}`);
  }
  return { page, context, problems, leaks };
};

/** The page measures that must hold on every tab at every width. */
const measure = async (page: Page) =>
  await page.evaluate(() => {
    const tab = document.querySelector<HTMLElement>('.fy-acc');
    const visible = (el: Element) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const fullBox = (el: Element) => {
      const style = getComputedStyle(el);
      const sides = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
      const colour = style.borderTopColor;
      return (
        sides.every(width => parseFloat(width) > 0) && !/rgba?\([^)]*,\s*0\)$/.test(colour) && colour !== 'transparent'
      );
    };
    const nested: string[] = [];
    for (const el of tab?.querySelectorAll('*') ?? []) {
      // A segmented control is ONE component (its chosen option is marked by a border inside its own track).
      if (
        !visible(el) ||
        !fullBox(el) ||
        el.closest('[data-pair-qr]') === el ||
        el.closest('[role=radiogroup]') !== null
      )
        continue;
      let parent = el.parentElement;
      while (parent !== null && parent !== tab) {
        // A control or a chip is never a box a box can sit in; the QR plate is the one deliberate white box.
        if (fullBox(parent) && visible(parent) && !parent.hasAttribute('data-pair-qr')) {
          nested.push(`${(el as HTMLElement).className} in ${parent.className}`);
          break;
        }
        parent = parent.parentElement;
      }
    }
    const clipped: string[] = [];
    for (const el of tab?.querySelectorAll<HTMLElement>('*') ?? []) {
      if (!visible(el) || el.closest('.sr-only') !== null) continue;
      const style = getComputedStyle(el);
      if (style.overflowX === 'hidden' || style.overflowX === 'auto' || style.overflowX === 'scroll') continue;
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && style.display !== 'inline')
        clipped.push(`${el.tagName}.${String(el.className).slice(0, 40)} ${el.scrollWidth}>${el.clientWidth}`);
    }
    const small: string[] = [];
    for (const el of tab?.querySelectorAll<HTMLElement>(
      'button, [role=switch], input:not(.sr-only):not([type=radio])',
    ) ?? []) {
      if (!visible(el)) continue;
      const box = el.getBoundingClientRect();
      if (box.height < 43.5)
        small.push(
          `${el.tagName} ${el.getAttribute('aria-label') ?? el.textContent?.slice(0, 20) ?? ''} h=${box.height}`,
        );
    }
    const wide: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.fy-acc *')) {
      const right = el.getBoundingClientRect().right;
      if (el.getBoundingClientRect().width === 0 && el.getBoundingClientRect().height === 0) continue;
      if (right > (tab?.getBoundingClientRect().right ?? window.innerWidth) + 1)
        wide.push(
          `${el.tagName}.${String(el.className).slice(0, 50)}[${el.getAttribute('role') ?? ''}] right=${Math.round(right)}`,
        );
    }
    return {
      wide: wide.slice(0, 8),
      panel: Math.round(tab?.getBoundingClientRect().width ?? 0),
      container: tab === null ? '' : getComputedStyle(tab).containerType,
      pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tabScroll: tab === null ? 0 : tab.scrollWidth - tab.clientWidth,
      panels: document.querySelectorAll('.fy-acc .kt-panel').length,
      nested,
      clipped,
      small,
    };
  });

describe('Access settings, in the real Settings shell, over a fake machine', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const tab of TABS) {
        it(`lays out ${tab} (${viewport.name}, ${theme})`, async () => {
          const { page, context, problems } = await open(viewport, theme, tab);
          try {
            await page.setViewportSize({ width: viewport.width, height: viewport.phone ? 2_400 : 1_800 });
            if (shotsDir !== '')
              await page.screenshot({ path: join(shotsDir, `${tab}-${viewport.name}-${theme}.png`) });
            const m = await measure(page);
            expect(problems).toEqual([]);
            expect(m.wide).toEqual([]);
            expect(m.container).toBe('inline-size');
            expect(m.pageScroll).toBeLessThanOrEqual(0);
            expect(m.tabScroll).toBeLessThanOrEqual(0);
            expect(m.panels).toBe(0);
            expect(m.nested).toEqual([]);
            expect(m.clipped).toEqual([]);
            expect(m.small).toEqual([]);
            // At 768 the settings list stands above the panel (not beside it), which is at least 480px; at 1280 it is wider still.
            if (viewport.name === '768') expect(m.panel).toBeGreaterThanOrEqual(480);
            if (viewport.name === '1280') expect(m.panel).toBeGreaterThan(480);
          } finally {
            await context.close();
          }
        });
      }
    }
  }

  for (const viewport of VIEWPORTS) {
    it(`devices: the pairing code and a device's capabilities, by the panel's width (${viewport.name})`, async () => {
      const { page, context, leaks } = await open(viewport, 'studio-light', 'devices', 'long');
      try {
        await page.locator('[data-pair-mint]').click();
        await page.locator('[data-pair-invite]').waitFor();
        // The QR is drawn locally: the code is on the screen on purpose, and in nothing the browser said, asked for or kept.
        expect(await leaks.leaked()).toEqual([]);
        expect(await leaks.inPage()).toEqual([]);
        await page.locator('[data-device-capabilities]').first().locator('summary').click();
        const m = await measure(page);
        expect(m.pageScroll).toBeLessThanOrEqual(0);
        expect(m.tabScroll).toBeLessThanOrEqual(0);
        expect(m.nested).toEqual([]);
        expect(m.clipped).toEqual([]);
        expect(m.small).toEqual([]);
        // The QR sits beside the facts only when the PANEL is 560px or wider; the window never decides.
        const geometry = await page.evaluate(() => {
          const qr = document.querySelector('[data-pair-qr]')?.getBoundingClientRect();
          const facts = document.querySelector('.fy-acc-invite__facts')?.getBoundingClientRect();
          const panel = document.querySelector('.fy-acc')?.getBoundingClientRect().width ?? 0;
          return {
            besides: qr !== undefined && facts !== undefined && facts.left >= qr.right - 1 && facts.top < qr.bottom,
            panel,
          };
        });
        expect(geometry.besides).toBe(geometry.panel >= 560);
        // A switch's box is never above its words, and a device's capability rows line up on one right edge per column.
        const caps = await page.evaluate(() =>
          [
            ...(document
              .querySelectorAll('[data-device-capabilities]')[0]
              ?.querySelectorAll('[data-device-capability]') ?? []),
          ].map(row => {
            const name = row.querySelector('.fy-acc-cap__name')?.getBoundingClientRect();
            const axes = [...row.querySelectorAll('[role=switch]')].map(s => s.getBoundingClientRect());
            return {
              nameTop: name?.top ?? 0,
              axisRights: axes.map(a => Math.round(a.right)),
              axisTops: axes.map(a => Math.round(a.top)),
            };
          }),
        );
        expect(caps.length).toBeGreaterThan(0);
        await page.setViewportSize({ width: viewport.width, height: viewport.phone ? 3_000 : 2_000 });
        if (shotsDir !== '') await page.screenshot({ path: join(shotsDir, `devices-code-${viewport.name}.png`) });
      } finally {
        await context.close();
      }
    });
  }

  // The code is on the screen until Done, and then it is nowhere: not in a message, a request, a frame, the address, the title,
  // the history, an attribute or a store, and not in the words on the page either.
  for (const viewport of VIEWPORTS) {
    it(`devices: the pairing code is in nothing the page says or keeps, and not on the page after Done (${viewport.name})`, async () => {
      const { page, context, leaks } = await open(viewport, 'studio-light', 'devices', 'long');
      try {
        await page.locator('[data-pair-mint]').click();
        await page.locator('[data-pair-invite]').waitFor();
        expect(await page.locator('[data-pair-invite]').innerText()).toMatch(/7F3K/);
        expect(await leaks.leaked()).toEqual([]);
        expect(await leaks.inPage()).toEqual([]);
        await page.locator('[data-pair-discard]').click();
        await page.locator('[data-pair-invite]').waitFor({ state: 'detached' });
        // Let anything the dismissal schedules (a timer, a late render, a deferred log) run.
        await page.waitForTimeout(500);
        expect(await leaks.leaked()).toEqual([]);
        expect(await leaks.inPage()).toEqual([]);
        expect(holdsCode(await page.locator('body').innerText())).toBe(false);
      } finally {
        await context.close();
      }
    });
  }

  // The watch is not blind: a code planted through each way a page can say or keep a thing is caught by the same reads.
  it('the leak watch sees a code planted in each channel it claims to read', async () => {
    const { page, context, leaks } = await open(VIEWPORTS[1], 'studio-light', 'devices');
    try {
      expect(await leaks.leaked()).toEqual([]);
      expect(await leaks.inPage()).toEqual([]);
      const origin = server?.url.origin ?? '';
      await page.evaluate(async (base: string) => {
        console.log('plain 7F3K-Q2ND');
        console.log({ nested: ['Q2ND'] });
        setTimeout(() => {
          throw new Error('late 7F3K');
        }, 0);
        await fetch(`${base}/probe?code=7F3K`, { method: 'POST', headers: { 'x-code': 'Q2ND' }, body: 'body 7F3K' });
        await new Promise<void>(done => {
          const socket = new WebSocket(`${base.replace('http', 'ws')}/echo`);
          socket.onopen = () => socket.send('frame 7F3K');
          socket.onmessage = () => {
            socket.close();
            done();
          };
          socket.onerror = () => done();
        });
        document.title = 'title 7F3K';
        history.replaceState({ code: 'Q2ND' }, '', `#code=7F3K`);
        document.body.setAttribute('data-probe', '7F3K-Q2ND');
        sessionStorage.setItem('probe', 'Q2ND');
      }, origin);
      await page.waitForTimeout(300);
      const said = (await leaks.leaked()).join('\n');
      for (const channel of ['console plain', 'console-arg', 'pageerror', 'request', 'frame-sent', 'frame-received'])
        expect(said).toContain(channel);
      const kept = (await leaks.inPage()).join('\n');
      for (const channel of ['title ', 'location ', 'history ', 'attribute BODY[data-probe]', 'storage probe'])
        expect(kept).toContain(channel);
    } finally {
      await context.close();
    }
  });

  for (const theme of THEMES) {
    it(`devices: the pairing address wraps only at its separators on a phone (390, ${theme})`, async () => {
      const { page, context } = await open(VIEWPORTS[2], theme, 'devices', 'long');
      try {
        await page.locator('[data-pair-mint]').click();
        await page.locator('[data-pair-invite]').waitFor();
        const url = page.locator('[data-pair-url]');
        // Where each line of the address ends: the character a line stops on, read from one box per character.
        const ends = await url.evaluate(element => {
          const range = document.createRange();
          const lines: { top: number; text: string }[] = [];
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            const text = node as Text;
            for (let at = 0; at < text.length; at += 1) {
              range.setStart(text, at);
              range.setEnd(text, at + 1);
              const box = range.getClientRects()[0];
              if (box === undefined) continue;
              const last = lines.at(-1);
              if (last !== undefined && Math.abs(last.top - box.top) < 3) last.text += text.data[at];
              else lines.push({ top: box.top, text: text.data[at] as string });
            }
          }
          return { lines: lines.map(line => line.text), copied: (element as HTMLElement).textContent };
        });
        // Wrapping is real at this width, the copied text is the address as minted, and every break before the long
        // fingerprint (which can be wider than the box on its own) falls after a separator or before a "%"-escape.
        expect(ends.lines.length).toBeGreaterThan(1);
        expect(ends.copied).toBe(
          'https://ferretry.example.test/pair#v1;url=https%3A%2F%2Fworkshop.example.test;code=7F3K-Q2ND;fp=fy_daemon_' +
            'a'.repeat(43),
        );
        const breaks = ends.lines
          .slice(0, -1)
          .map((line, index) => ({
            end: line.at(-1) as string,
            next: (ends.lines[index + 1] as string)[0] as string,
            line,
          }))
          .filter(
            entry =>
              !entry.line.includes('fp=') && !entry.line.startsWith('fy_daemon') && !entry.line.startsWith('aaa'),
          );
        // The hyphen inside the code ("7F3K-Q2ND") is a break the browser may take on its own (it does, at some font
        // metrics); a break inside a word is the only one that is never allowed.
        for (const entry of breaks) expect(`${entry.end}|${entry.next}`).toMatch(/^[/?&#;=.-]\||\|%/u);
        await page.setViewportSize({ width: 390, height: 3_000 });
        if (shotsDir !== '') await page.screenshot({ path: join(shotsDir, `pair-address-390-${theme}.png`) });
      } finally {
        await context.close();
      }
    });
  }

  for (const viewport of [VIEWPORTS[1], VIEWPORTS[2]]) {
    for (const theme of THEMES) {
      it(`devices: a revoke asks first, in the panel's own layout (${viewport.name}, ${theme})`, async () => {
        const { page, context, problems } = await open(viewport, theme, 'devices');
        try {
          await page.locator('[data-pair-mint]').click();
          await page.locator('[data-pair-invite]').waitFor();
          // The first press of either revoke opens a question and sends nothing; the strip is the panel's, not a box in a box.
          await page.locator('[data-pair-revoke-code]').click();
          await page.locator('[data-pair-revoke-code-confirming]').waitFor();
          const row = page.locator('[data-paired-device]').first();
          await row.locator('[data-pair-revoke-device]').click();
          await row.locator('[data-pair-revoke-device-confirming]').waitFor();
          // This browser's own row says it will sign you out here.
          const own = page.locator('[data-paired-device]', { has: page.locator('[data-paired-device-self]') });
          await own.locator('[data-pair-revoke-device]').click();
          await own.locator('[data-pair-revoke-device-confirming]').waitFor();
          expect(await own.innerText()).toContain('Revoke and sign out here');
          // Focus lands on Cancel (the safe key), not on the destructive button.
          expect(
            await page.evaluate(() => document.activeElement?.hasAttribute('data-pair-revoke-device-cancel')),
          ).toBe(true);
          await page.setViewportSize({ width: viewport.width, height: viewport.phone ? 3_000 : 2_000 });
          const m = await measure(page);
          expect(problems).toEqual([]);
          expect(m.pageScroll).toBeLessThanOrEqual(0);
          expect(m.tabScroll).toBeLessThanOrEqual(0);
          expect(m.wide).toEqual([]);
          expect(m.nested).toEqual([]);
          expect(m.clipped).toEqual([]);
          expect(m.small).toEqual([]);
          if (shotsDir !== '')
            await page.screenshot({ path: join(shotsDir, `revoke-confirm-${viewport.name}-${theme}.png`) });
          for (let left = 2; left > 0; left -= 1)
            await page.locator('[data-pair-revoke-device-cancel]').first().click();
          expect(await page.locator('[data-pair-revoke-device-confirming]').count()).toBe(0);
        } finally {
          await context.close();
        }
      });
    }
  }

  it('empty and refused states stay in the same layout (1280)', async () => {
    for (const [tab, state] of [
      ['devices', 'empty'],
      ['security', 'empty'],
      ['audit', 'refused'],
    ] as const) {
      const { page, context } = await open(VIEWPORTS[1], 'studio-light', tab, state);
      try {
        const m = await measure(page);
        expect(m.nested).toEqual([]);
        expect(m.tabScroll).toBeLessThanOrEqual(0);
        if (shotsDir !== '') await page.screenshot({ path: join(shotsDir, `${tab}-${state}-1280.png`) });
      } finally {
        await context.close();
      }
    }
  });
});
