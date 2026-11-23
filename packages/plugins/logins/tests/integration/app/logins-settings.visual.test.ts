/**
 * THE LOGINS SETTINGS TAB, in a real browser over fake data (`fixtures/logins-settings-scene.tsx`), at 1280 and 390 wide,
 * light and dark (r10 S13). Set `FY_LOGINS_SETTINGS_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser, Page } from 'playwright-core';

setDefaultTimeout(90_000);

const packageRoot = import.meta.dir;
/** A made-up key, never a real one: it is only ever typed into a field to show the field masks it. */
const FAKE_PASTED_KEY = 'sk-or-v1-FAKE0000000000000000000000000000';
const shotsDir = process.env.FY_LOGINS_SETTINGS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-logins-settings-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/logins-settings-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the logins settings scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
const THEMES = ['studio-light', 'studio-dark'] as const;

interface Case {
  readonly name: string;
  readonly view: string;
  readonly ready: string;
  /** Acts after the first paint (a click that opens a form). */
  readonly act?: (tab: Page) => Promise<void>;
}

const CASES: readonly Case[] = [
  { name: 'list', view: 'list', ready: '[data-login-card-wrap]' },
  {
    name: 'remove',
    view: 'list',
    ready: '[data-login-card-wrap]',
    act: async tab => {
      await tab.locator('[data-login-card-remove="claude-personal"]').click();
      await tab.locator('[data-login-remove]').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'switch-off',
    view: 'list',
    ready: '[data-login-card-wrap]',
    act: async tab => {
      await tab.locator('[data-login-switch="claude-personal"] button').click();
      await tab.locator('[data-login-disable]').waitFor({ state: 'visible' });
    },
  },
  { name: 'empty', view: 'empty', ready: '[data-logins-empty]' },
  { name: 'page', view: 'page', ready: '[data-login-page]' },
  { name: 'page-env', view: 'env', ready: '[data-login-environment]' },
  { name: 'page-needs-sign-in', view: 'needs', ready: '[data-login-page]' },
  {
    name: 'add',
    view: 'list',
    ready: '[data-add-login]',
    act: async tab => {
      await tab.locator('[data-add-login]').first().click();
      await tab.locator('[data-provider-grid]').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'add-key',
    view: 'list',
    ready: '[data-add-login]',
    act: async tab => {
      await tab.locator('[data-add-login]').first().click();
      await tab.locator('[data-provider-tile="zai-glm"]').click();
      await tab.locator('[data-quick-key-form]').waitFor({ state: 'visible' });
    },
  },
  {
    // A FAKE key pasted into the full form's secret slot: masked (a password field), then refused with its slot cleared.
    name: 'add-full-pasted-key',
    view: 'list',
    ready: '[data-add-login]',
    act: async tab => {
      await tab.locator('[data-add-login]').first().click();
      await tab.locator('[data-provider-tile="zai-glm"]').click();
      await tab.locator('[data-quick-key-more]').click();
      await tab.locator('[data-add-login-form="zai-glm"]').waitFor({ state: 'visible' });
      await tab.locator('[data-add-login-form="zai-glm"] input').first().fill(FAKE_PASTED_KEY);
      await tab.locator('[data-secret-masked]').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'add-full-refused-key',
    view: 'list',
    ready: '[data-add-login]',
    act: async tab => {
      await tab.locator('[data-add-login]').first().click();
      await tab.locator('[data-provider-tile="zai-glm"]').click();
      await tab.locator('[data-quick-key-more]').click();
      await tab.locator('[data-add-login-form="zai-glm"]').waitFor({ state: 'visible' });
      await tab.locator('[data-add-login-form="zai-glm"] input').first().fill(FAKE_PASTED_KEY);
      await tab.locator('[data-change-submit]').click();
      await tab.locator('[data-change-refusal]').waitFor({ state: 'visible' });
    },
  },
];

describe('the Logins settings tab, in a browser', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      for (const item of CASES)
        it(`${item.name} (${viewport.name}, ${theme})`, async () => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            deviceScaleFactor: viewport.phone ? 2 : 1,
            hasTouch: viewport.phone,
            isMobile: viewport.phone,
          });
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          const tab = await context.newPage();
          try {
            await tab.goto(`${origin}/?theme=${theme}&view=${item.view}`);
            await tab.locator(item.ready).first().waitFor({ state: 'visible' });
            await item.act?.(tab);
            await tab.waitForTimeout(300);
            const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            expect(overflow, 'nothing scrolls sideways').toBeLessThanOrEqual(0);
            if (shotsDir !== '')
              await tab.screenshot({
                fullPage: true,
                path: join(shotsDir, `${viewport.name}-${theme}-${item.name}.png`),
              });
          } finally {
            await context.close();
          }
        });
});

/** Opens one view of the scene in a fresh page of the given size and runs the checks against it. */
async function inPage(
  size: { readonly width: number; readonly height: number; readonly phone?: boolean },
  query: string,
  ready: string,
  check: (tab: Page) => Promise<void>,
  act?: (tab: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    hasTouch: size.phone === true,
    isMobile: size.phone === true,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  try {
    await tab.goto(`${origin}/?${query.includes('theme=') ? '' : 'theme=studio-light&'}${query}`);
    await tab.locator(ready).first().waitFor({ state: 'visible' });
    await act?.(tab);
    await tab.waitForTimeout(250);
    await check(tab);
  } finally {
    await context.close();
  }
}

const distinct = async (tab: Page, selector: string, edge: 'left' | 'top'): Promise<number> =>
  await tab.$$eval(
    selector,
    (nodes, side) => new Set(nodes.map(node => Math.round(node.getBoundingClientRect()[side as 'left' | 'top']))).size,
    edge,
  );

describe('the Logins tab keeps the settings rules', () => {
  it('draws no box inside a box, anywhere in the tab', async () => {
    for (const [query, ready, act] of [
      ['view=list', '[data-login-card-wrap]', undefined],
      ['view=page', '[data-login-page]', undefined],
      ['view=env', '[data-login-environment]', undefined],
      ['view=needs', '[data-login-sign-in]', undefined],
      [
        'view=list',
        '[data-login-card-wrap]',
        async (tab: Page) => {
          await tab.locator('[data-login-card-remove="claude-personal"]').click();
          await tab.locator('[data-login-remove]').waitFor({ state: 'visible' });
        },
      ],
      [
        'view=list',
        '[data-add-login]',
        async (tab: Page) => {
          await tab.locator('[data-add-login]').first().click();
          await tab.locator('[data-provider-tile="zai-glm"]').click();
          await tab.locator('[data-quick-key-form]').waitFor({ state: 'visible' });
        },
      ],
    ] as const)
      await inPage(
        { width: 1_280, height: 900 },
        query,
        ready,
        async tab => {
          expect(await tab.$$eval('.kt-panel .kt-panel', nodes => nodes.length), `${query}: a panel in a panel`).toBe(
            0,
          );
        },
        act,
      );
  });

  it('puts the login cards two across when the panel is wide, one when it is narrow, whatever the window', async () => {
    await inPage({ width: 1_280, height: 900 }, 'view=list', '[data-login-card-wrap]', async tab => {
      expect(await distinct(tab, '[data-logins-group="claude-code"] [data-login-card-wrap]', 'left')).toBe(2);
    });
    // The window is wide but the panel is 420px: one column.
    await inPage({ width: 1_280, height: 900 }, 'view=list&panel=420', '[data-login-card-wrap]', async tab => {
      expect(await distinct(tab, '[data-logins-group="claude-code"] [data-login-card-wrap]', 'left')).toBe(1);
    });
    await inPage({ width: 390, height: 844, phone: true }, 'view=list', '[data-login-card-wrap]', async tab => {
      expect(await distinct(tab, '[data-logins-group="claude-code"] [data-login-card-wrap]', 'left')).toBe(1);
    });
  });

  it('keeps 32px between the groups and 12px inside one', async () => {
    await inPage({ width: 1_280, height: 900 }, 'view=list', '[data-login-card-wrap]', async tab => {
      const gaps = await tab.$$eval('[data-logins-group]', nodes =>
        nodes
          .slice(1)
          .map((node, at) => node.getBoundingClientRect().top - (nodes[at]?.getBoundingClientRect().bottom ?? 0)),
      );
      expect(gaps.length).toBeGreaterThan(0);
      for (const gap of gaps) expect(Math.round(gap)).toBe(32);
      const inside = await tab.$$eval('[data-logins-group="claude-code"] [data-login-card-wrap]', nodes => {
        const tops = nodes.map(node => Math.round(node.getBoundingClientRect().top));
        const rows = [...new Set(tops)];
        const first = nodes.find(node => Math.round(node.getBoundingClientRect().top) === rows[0]);
        const second = nodes.find(node => Math.round(node.getBoundingClientRect().top) === rows[1]);
        return rows.length > 1 && first !== undefined && second !== undefined
          ? Math.round(second.getBoundingClientRect().top - first.getBoundingClientRect().bottom)
          : 12;
      });
      expect(inside).toBe(12);
    });
  });

  it('never stretches a single input across the panel, and lines the labels up', async () => {
    await inPage({ width: 1_280, height: 900 }, 'view=page', '[data-login-label]', async tab => {
      const widths = await tab.$$eval('[data-login-page] input.kt-input', nodes =>
        nodes.map(node => Math.round(node.getBoundingClientRect().width)),
      );
      expect(widths.length).toBeGreaterThan(0);
      for (const width of widths) expect(width, 'an input is at most 28rem').toBeLessThanOrEqual(449);
      // Label and Switch off: the two inputs start at the same left edge (the label column).
      expect(await distinct(tab, '[data-login-page] .fy-lg-field > input', 'left')).toBe(1);
    });
  });

  it('puts the CLI choice in a row of cards and the provider tiles by the PANEL width', async () => {
    const open = async (tab: Page): Promise<void> => {
      await tab.locator('[data-add-login]').first().click();
      await tab.locator('[data-provider-grid]').waitFor({ state: 'visible' });
    };
    await inPage(
      { width: 1_280, height: 900 },
      'view=list',
      '[data-add-login]',
      async tab => {
        expect(await distinct(tab, '[data-add-login-sign-in] .fy-cc__card', 'top'), 'two cards share a row').toBe(1);
        expect(await distinct(tab, '[data-provider-section="popular"] [data-provider-tile]', 'left')).toBe(4);
      },
      open,
    );
    await inPage(
      { width: 1_280, height: 900 },
      'view=list&panel=420',
      '[data-add-login]',
      async tab => {
        expect(await distinct(tab, '[data-provider-section="popular"] [data-provider-tile]', 'left')).toBe(2);
      },
      open,
    );
  });

  it('lets a card’s details use the card’s whole width on a phone, the switch sitting on the name’s line', async () => {
    await inPage({ width: 390, height: 844, phone: true }, 'view=list', '[data-login-card-wrap]', async tab => {
      const measured = await tab.evaluate(() => {
        const card = document.querySelector('[data-login-card-wrap="claude-personal"]');
        const usage = card?.querySelector('[data-login-usage] [role="img"]')?.getBoundingClientRect();
        const box = card?.getBoundingClientRect();
        const name = card?.querySelector('[data-login-row]')?.getBoundingClientRect();
        const toggle = card?.querySelector('[data-login-switch] button')?.getBoundingClientRect();
        return { usage, box, name, toggle };
      });
      expect(measured.usage !== undefined && measured.box !== undefined).toBe(true);
      // The bar reaches within the card's padding of its right edge (not stopping short for a controls column).
      expect((measured.box?.right ?? 0) - (measured.usage?.right ?? 0)).toBeLessThan(40);
      // The switch is on the first line of the card.
      expect((measured.toggle?.top ?? 0) - (measured.box?.top ?? 0)).toBeLessThan(24);
    });
  });

  it('keeps Edit variables and Test on one line, the same height', async () => {
    await inPage({ width: 1_280, height: 900 }, 'view=env', '[data-login-env-edit]', async tab => {
      const boxes = await tab.$$eval('[data-login-env-edit], [data-login-test-run]', nodes =>
        nodes.map(node => {
          const box = node.getBoundingClientRect();
          return { top: Math.round(box.top), height: Math.round(box.height) };
        }),
      );
      expect(boxes).toHaveLength(2);
      expect(boxes[0]?.top).toBe(boxes[1]?.top);
      expect(boxes[0]?.height).toBe(boxes[1]?.height);
    });
  });
});

describe('C59 O8-1 review: the shared answer row fits the PANEL it is in, not the window', () => {
  // The Codex link sign-in inside a Settings panel at a 1280 window (the panel is 604px): its "Start over" + "Cancel" row is two
  // 12rem answers (396px with the gap) in a column NARROWER than that, so a row that groups at the right edge used to overflow
  // to the left and the panel's own clipping cut "Start over".
  for (const theme of THEMES)
    it(`the Codex link sign-in in a 604px panel at 1280 (${theme}): every action is whole, inside its row and the panel`, async () => {
      await inPage(
        { width: 1_280, height: 900 },
        `theme=${theme}&view=needs-codex&panel=604`,
        '[data-login-sign-in="start"]',
        async tab => {
          await tab
            .getByRole('button', { name: /Sign in to Codex/u })
            .first()
            .click();
          await tab.locator('[data-login-sign-in="awaiting-callback"] [data-sign-in-start-over]').waitFor({
            state: 'visible',
          });
          await tab.evaluate(async () => await document.fonts.ready);
          const facts = await tab.evaluate(() => {
            const visibleSlice = (el: HTMLElement): { width: number; visible: number } => {
              const own = el.getBoundingClientRect();
              let left = own.left;
              let right = own.right;
              for (let up = el.parentElement; up !== null; up = up.parentElement) {
                if (getComputedStyle(up).overflowX === 'visible') continue;
                const box = up.getBoundingClientRect();
                left = Math.max(left, box.left);
                right = Math.min(right, box.right);
              }
              return { width: own.width, visible: Math.max(0, right - left) };
            };
            const rows = [...document.querySelectorAll<HTMLElement>('[data-login-sign-in] [data-action-row]')];
            return {
              rows: rows.map(row => {
                const rowBox = row.getBoundingClientRect();
                return {
                  width: rowBox.width,
                  buttons: [...row.querySelectorAll<HTMLElement>('.kt-btn')].map(button => {
                    const box = button.getBoundingClientRect();
                    return {
                      label: button.textContent?.trim() ?? '',
                      leftOfRow: box.left - rowBox.left,
                      rightOfRow: rowBox.right - box.right,
                      ...visibleSlice(button),
                    };
                  }),
                };
              }),
            };
          });
          const labels = facts.rows.flatMap(row => row.buttons.map(button => button.label));
          expect(
            labels.some(label => label.includes('Start over')),
            `Start over is drawn (${labels.join(' | ')})`,
          ).toBe(true);
          expect(labels.some(label => label.includes('Cancel'))).toBe(true);
          for (const row of facts.rows)
            for (const button of row.buttons) {
              const named = `"${button.label}" (row ${Math.round(row.width)}px wide)`;
              expect(button.visible, `${named} is not clipped by anything around it`).toBeGreaterThanOrEqual(
                button.width - 0.5,
              );
              expect(button.leftOfRow, `${named} starts inside its row`).toBeGreaterThanOrEqual(-0.5);
              expect(button.rightOfRow, `${named} ends inside its row`).toBeGreaterThanOrEqual(-0.5);
            }
          if (shotsDir !== '') {
            // The whole answer area on screen: the shot is what the owner looks at.
            await tab.locator('[data-sign-in-start-over]').scrollIntoViewIfNeeded();
            await tab.mouse.wheel(0, 300);
            await tab.waitForTimeout(150);
            await tab.screenshot({ path: join(shotsDir, `1280-${theme}-codex-link-panel604.png`) });
          }
        },
      );
    });
});
