/**
 * SETTINGS FORMS (C59 O8-10: "look at the settings, so far looks very confusing ... study Geist or Material for their forms").
 *
 * ONE SAVE MODEL PER KIND OF SETTING, asserted in a real browser over the real plugin tabs (the sweep scene, fake data):
 *  - a CHOICE (a switch) saves at once, so it sits in a group that says so (`data-setting-saves="now"`);
 *  - a VALUE (a text / number / textarea field) is saved by ONE Save bar at the foot of its form
 *    (`data-setting-saves="on-save"` holding a `data-setting-savebar`), which is drawn from the first paint (never only once
 *    something is dirty), and a switch never sits inside such a form (a switch takes effect now; a checkbox is saved with the form);
 *  - every group that saves says WHEN, in words the person can see;
 *  - typing a value and leaving the field writes nothing; Save writes exactly once;
 *  - a control that cannot be changed from here stays disabled and says why next to it.
 * Set `FY_SETTINGS_FORMS_SHOTS_DIR` to keep `<viewport>-<scheme>-<plugin>-<tab>.png`; `FY_SETTINGS_FORMS_SCHEME=light` for light.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(90_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SETTINGS_FORMS_SHOTS_DIR ?? '';
const scheme = process.env.FY_SETTINGS_FORMS_SCHEME === 'light' ? 'light' : 'dark';
/** The pages this unit puts on the model (`FY_SETTINGS_FORMS_PAGES` narrows or widens them). */
const PAGES = (process.env.FY_SETTINGS_FORMS_PAGES ?? 'access/security,warden/warden,usage/budgets')
  .split(',')
  .filter(Boolean)
  .map(page => page.split('/') as [string, string]);
const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 1_000 },
  { name: '390', width: 390, height: 844 },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-settings-forms-'));
  const entry = join(directory, 'entry.tsx');
  await Bun.write(
    entry,
    `import { registerSettingsSweep } from ${JSON.stringify(resolve(packageRoot, 'fixtures/settings-sweep-register.ts'))};\nregisterSettingsSweep();\nawait import(${JSON.stringify(resolve(packageRoot, 'fixtures/settings-shell-scene.tsx'))});\n`,
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
  if (code !== 0) throw new Error(`the forms scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 300_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

/** What the page's forms look like, measured in the page and returned as plain data. */
const measure = () => {
  const root = document.querySelector<HTMLElement>('.fy-settings-page');
  const shown = (el: Element) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const name = (el: Element) =>
    el.getAttribute('aria-label') ??
    el.getAttribute('data-security-input') ??
    el.getAttribute('data-budget-input') ??
    el.getAttribute('placeholder') ??
    (el.id === '' ? undefined : el.id) ??
    el.tagName.toLowerCase();
  const valueFields: string[] = [];
  const fieldsOutsideForm: string[] = [];
  const switchesOutsideNow: string[] = [];
  const switchesInForm: string[] = [];
  const formsWithoutBar: string[] = [];
  const savesWithoutWords: string[] = [];
  const barsHidden: string[] = [];
  const barStates: string[] = [];
  let firstBarBottom: number | null = null;
  if (root !== null) {
    for (const el of root.querySelectorAll<HTMLElement>(
      'input:not([type=radio]):not([type=checkbox]):not([type=range]):not(.sr-only), textarea',
    )) {
      // An ACTION (a field that only feeds a verb button: "Look at its screen") is not a setting value; its section says so.
      if (!shown(el) || (el as HTMLInputElement).disabled || el.closest('[data-setting-action]') !== null) continue;
      valueFields.push(name(el));
      const form = el.closest('[data-setting-saves="on-save"]');
      if (form === null) fieldsOutsideForm.push(name(el));
    }
    for (const el of root.querySelectorAll<HTMLElement>('[role=switch]')) {
      if (!shown(el)) continue;
      if (el.closest('[data-setting-saves="on-save"]') !== null) switchesInForm.push(name(el));
      else if (el.closest('[data-setting-saves="now"]') === null) switchesOutsideNow.push(name(el));
    }
    for (const form of root.querySelectorAll<HTMLElement>('[data-setting-saves="on-save"]')) {
      const bar = form.querySelector<HTMLElement>('[data-setting-savebar]');
      if (bar === null) formsWithoutBar.push(form.getAttribute('data-setting-group') ?? 'a form');
      else {
        if (!shown(bar)) barsHidden.push(form.getAttribute('data-setting-group') ?? 'a form');
        barStates.push(bar.getAttribute('data-state') ?? '');
        // A form that is on screen keeps its Save bar on screen too (it sticks to the foot while the form is in view); a form still
        // below the fold has nothing to keep. The first form that starts on screen is the one measured.
        if (firstBarBottom === null && form.getBoundingClientRect().top < window.innerHeight)
          firstBarBottom = bar.getBoundingClientRect().bottom;
      }
    }
    for (const group of root.querySelectorAll<HTMLElement>('[data-setting-saves]')) {
      const words = group.querySelector<HTMLElement>('[data-setting-saves-note]');
      const text = (words?.textContent ?? '').trim();
      const wanted =
        group.getAttribute('data-setting-saves') === 'now' ? /as soon as|right away|at once/i : /press Save/i;
      if (words === null || !shown(words) || !wanted.test(text))
        savesWithoutWords.push(group.getAttribute('data-setting-group') ?? 'a group');
    }
  }
  return {
    valueFields,
    fieldsOutsideForm,
    switchesOutsideNow,
    switchesInForm,
    formsWithoutBar,
    savesWithoutWords,
    barsHidden,
    barStates,
    firstBarBottom,
    windowHeight: window.innerHeight,
    forms: root?.querySelectorAll('[data-setting-saves="on-save"]').length ?? 0,
  };
};

/**
 * `seed` steers the fake machine from `localStorage` (see `fixtures/sweep/answers-forms.ts`). It is written only where nothing is kept
 * yet, so a reload reads back what a Save wrote instead of the seed.
 */
const open = async (
  width: number,
  height: number,
  plugin: string,
  tab: string,
  seed: Readonly<Record<string, string>> = {},
) => {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
  await context.addInitScript(entries => {
    for (const [key, value] of entries) if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
  }, Object.entries(seed));
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  await page.goto(`${origin}/d/ws/settings/${plugin}/${tab}?theme=studio-${scheme}`);
  await page.waitForSelector('.fy-settings-page', { timeout: 20_000 });
  await page.waitForTimeout(1_200);
  return { page, problems, close: async () => await context.close() };
};

/** An after-shot of what the page shows now (kept only when `FY_SETTINGS_FORMS_SHOTS_DIR` is set). */
const shot = async (page: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await page.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
};

const writes = async (page: Page, prefix: string): Promise<number> =>
  await page.evaluate(
    needle =>
      ((globalThis as { __fyRequests?: string[] }).__fyRequests ?? []).filter(line => line.startsWith(needle)).length,
    prefix,
  );

describe('Settings forms: one save model, said out loud', () => {
  for (const viewport of VIEWPORTS) {
    for (const [plugin, tab] of PAGES) {
      it(`${viewport.name}-${scheme}: ${plugin}/${tab} keeps the save model`, async () => {
        const { page, problems, close } = await open(viewport.width, viewport.height, plugin, tab);
        try {
          const measured = await page.evaluate(measure);
          // The shell scrolls inside itself, so the picture is taken in a window tall enough to hold the whole page (its Save bar included).
          if (shotsDir !== '') {
            await page.setViewportSize({ width: viewport.width, height: 3_000 });
            await page.waitForTimeout(400);
            await page.screenshot({
              path: join(shotsDir, `${viewport.name}-${scheme}-${plugin}-${tab}.png`),
              fullPage: true,
            });
          }
          expect(
            measured.forms,
            `${plugin}/${tab}: it has a form with value fields, so it has a Save bar`,
          ).toBeGreaterThan(0);
          expect(measured.fieldsOutsideForm, 'a value field that no Save bar saves').toEqual([]);
          expect(measured.formsWithoutBar, 'a form with no Save bar').toEqual([]);
          expect(measured.barsHidden, 'a Save bar that is not drawn until something changes').toEqual([]);
          expect(
            measured.barStates.every(state => state === 'clean'),
            'every Save bar starts clean',
          ).toBe(true);
          expect(
            measured.firstBarBottom ?? 0,
            `${plugin}/${tab}: the Save bar is on screen without scrolling (a long form keeps it in view): bar bottom ${measured.firstBarBottom}, window ${measured.windowHeight}`,
          ).toBeLessThanOrEqual(measured.windowHeight + 1);
          expect(measured.switchesInForm, 'a switch inside a form that is saved with a button').toEqual([]);
          expect(measured.switchesOutsideNow, 'a switch in a group that does not say it saves at once').toEqual([]);
          expect(measured.savesWithoutWords, 'a group that does not say when it saves').toEqual([]);
          expect(problems, 'page errors').toEqual([]);
        } finally {
          await close();
        }
      });
    }
  }

  it('Security: typing a value and leaving the field writes nothing; Save lands, and the saved value is read back after a reload; a locked switch stays locked and says why', async () => {
    const { page, close } = await open(1_280, 1_000, 'access', 'security');
    try {
      const input = page.locator('[data-security-input="deviceKeyRotationDays"]');
      const bar = page.locator('[data-setting-savebar]').first();
      await bar.waitFor();
      expect(await bar.getAttribute('data-state')).toBe('clean');
      await input.fill('14');
      expect(await bar.getAttribute('data-state'), 'a typed value is unsaved').toBe('dirty');
      await input.blur();
      await page.waitForTimeout(300);
      expect(await writes(page, 'PATCH '), 'leaving the field saved nothing').toBe(0);
      await bar.getByRole('button', { name: /^Save/ }).click();
      // The fake machine answers with a VALID write: the proof is the saved state, not that a request left.
      await page.waitForSelector('[data-setting-savebar][data-state="saved"]', { timeout: 5_000 });
      expect(await writes(page, 'PATCH /v1/security'), 'Save wrote once').toBe(1);
      expect(await input.inputValue(), 'the saved value stays in the box').toBe('14');
      // The persisted value: a reload reads what the machine kept, and nothing is left unsaved.
      await page.reload();
      await page.waitForSelector('[data-security-input="deviceKeyRotationDays"]', { timeout: 20_000 });
      await page.waitForTimeout(600);
      expect(await page.locator('[data-security-input="deviceKeyRotationDays"]').inputValue(), 'it persisted').toBe(
        '14',
      );
      expect(
        await page.locator('[data-setting-savebar]').first().getAttribute('data-state'),
        'clean after reload',
      ).toBe('clean');
      // The machine's passkey-at-the-machine rule: the switch that would loosen security is disabled here, with the reason beside it.
      const locked = page.locator('[data-security-switch="unlockOnOpen"] [role=switch]');
      expect(await locked.isDisabled(), 'a locked switch cannot be pressed from here').toBe(true);
      expect(
        await page.locator('[data-security-note="unlockOnOpen"]').innerText(),
        'the reason is on the page, beside the control',
      ).toContain('fy daemon security set');
    } finally {
      await close();
    }
  });

  // ITEM 1: Back on a phone must not drop what was typed without a word. Done once, in the shared kit; asserted on every form page.
  const TYPED = {
    'access/security': async (page: Page) =>
      await page.locator('[data-security-input="deviceKeyRotationDays"]').fill('14'),
    'warden/warden': async (page: Page) => {
      const field = page.locator('.fy-settings-page input[type=number]:not([disabled])').first();
      await field.fill(String(Number(await field.inputValue()) + 1));
    },
    'usage/budgets': async (page: Page) => await page.locator('[data-budget-input="dailyTrigger"]').first().fill('7'),
  } as const;
  for (const [key, type] of Object.entries(TYPED)) {
    const [plugin, tab] = key.split('/') as [string, string];
    it(`390: ${key}: Back with an unsaved change asks first; Keep editing keeps it; Discard leaves`, async () => {
      const { page, close } = await open(390, 844, plugin, tab);
      try {
        await page.locator('[data-setting-savebar]').first().waitFor();
        await type(page);
        const dialog = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
        await page.locator('.fy-settings-back').click();
        await dialog.waitFor({ timeout: 3_000 });
        await shot(page, `390-guard-${plugin}-${tab}`);
        await dialog.getByRole('button', { name: 'Keep editing' }).click();
        await dialog.waitFor({ state: 'detached', timeout: 3_000 });
        expect(new URL(page.url()).pathname, 'Keep editing stays on the page').toBe(`/d/ws/settings/${plugin}/${tab}`);
        expect(
          await page.locator('[data-setting-savebar]').first().getAttribute('data-state'),
          'what was typed is still there',
        ).toBe('dirty');
        await page.locator('.fy-settings-back').click();
        await dialog.getByRole('button', { name: 'Discard' }).click();
        await page.waitForFunction(() => location.pathname === '/d/ws/settings', null, { timeout: 5_000 });
      } finally {
        await close();
      }
    });
  }

  it('390: Back from a form with nothing unsaved leaves at once, with no question', async () => {
    const { page, close } = await open(390, 844, 'access', 'security');
    try {
      await page.locator('.fy-settings-back').click();
      await page.waitForFunction(() => location.pathname === '/d/ws/settings', null, { timeout: 5_000 });
      expect(await page.getByRole('dialog').count(), 'no question for a clean form').toBe(0);
    } finally {
      await close();
    }
  });

  // ITEM 2: a Save in flight takes no more typing, so the answer that replaces the draft cannot erase an edit.
  it('1280: Warden: while a Save is in flight every field is off, and what the machine kept is what shows after', async () => {
    const { page, close } = await open(1_280, 1_000, 'warden', 'warden');
    try {
      const bar = page.locator('[data-setting-savebar]').first();
      await bar.waitFor();
      const field = page.locator('.fy-settings-page input[type=number]:not([disabled])').first();
      const before = Number(await field.inputValue());
      await field.fill(String(before + 1));
      await page.evaluate(() => (globalThis as unknown as { __fyHoldWrites: () => void }).__fyHoldWrites());
      await bar.getByRole('button', { name: /^Save/ }).click();
      await page.waitForSelector('[data-setting-savebar][data-state="saving"]', { timeout: 3_000 });
      // The form is the Warden card: every control in it (inputs, selects, the on/off boxes) must be off, by name when one is not.
      const enabled = await page.evaluate(() =>
        [
          ...document.querySelectorAll<HTMLInputElement>(
            '[data-testid="warden-config-card"] input, [data-testid="warden-config-card"] select, [data-testid="warden-config-card"] textarea, [data-testid="warden-config-card"] [role=switch]',
          ),
        ]
          .filter(control => !control.disabled && !control.closest('fieldset:disabled'))
          .map(control => control.getAttribute('aria-label') ?? control.id ?? control.tagName),
      );
      expect(enabled, 'a field that can still be typed in while the Save is in flight').toEqual([]);
      await page.evaluate(() => (globalThis as unknown as { __fyReleaseWrites: () => void }).__fyReleaseWrites());
      await page.waitForSelector('[data-setting-savebar][data-state="saved"]', { timeout: 5_000 });
      expect(await field.inputValue(), 'the saved value is on screen').toBe(String(before + 1));
      expect(await field.isEnabled(), 'the fields are back on').toBe(true);
    } finally {
      await close();
    }
  });

  // ITEM 3: an instant switch that did not change says why NEXT TO the switch, in view on a phone.
  for (const viewport of VIEWPORTS) {
    it(`${viewport.name}: Security: a refused instant switch says so in its own row, inside the viewport`, async () => {
      const { page, close } = await open(viewport.width, viewport.height, 'access', 'security', {
        'fyFake.security': JSON.stringify({ unlockOnOpen: false }),
        'fyFake.refuseSecurity': '1',
      });
      try {
        await page.locator('[data-security-switch="unlockOnOpen"] [role=switch]').click();
        const status = page.locator('[data-security-failure-settings]');
        await status.waitFor({ timeout: 5_000 });
        await shot(page, `${viewport.name}-switch-refused`);
        const box = await status.boundingBox();
        const height = page.viewportSize()?.height ?? 0;
        expect(box, 'the sentence is drawn').not.toBeNull();
        expect(box?.y ?? -1, 'its top is inside the viewport').toBeGreaterThanOrEqual(0);
        expect((box?.y ?? 0) + (box?.height ?? 0), `its bottom is inside the ${height}px viewport`).toBeLessThanOrEqual(
          height,
        );
        expect(
          await status.evaluate(node => node.closest('[data-setting-row]')?.getAttribute('data-setting-row') ?? ''),
          'it sits in the row of the switch that failed',
        ).toBe('Unlock with a passkey on opening');
        expect(
          await status.evaluate(node => node.closest('[data-setting-group]')?.getAttribute('data-setting-group')),
          'inside the Prompts group, not below the Limits',
        ).toBe('Prompts');
      } finally {
        await close();
      }
    });
  }

  // The same guard at a desktop width, through the settings list (the Back link is a phone's way out; the list is the desktop's).
  it('1280: Security: leaving through the settings list with an unsaved change asks first', async () => {
    const { page, close } = await open(1_280, 1_000, 'access', 'security');
    try {
      await page.locator('[data-security-input="deviceKeyRotationDays"]').fill('14');
      const dialog = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
      await page.locator('a.fy-settings-device').click();
      await dialog.waitFor({ timeout: 3_000 });
      await shot(page, '1280-guard-access-security');
      await dialog.getByRole('button', { name: 'Keep editing' }).click();
      expect(new URL(page.url()).pathname, 'Keep editing stays').toBe('/d/ws/settings/access/security');
      await page.locator('a.fy-settings-device').click();
      await dialog.getByRole('button', { name: 'Discard' }).click();
      await page.waitForFunction(() => location.pathname !== '/d/ws/settings/access/security', null, {
        timeout: 5_000,
      });
    } finally {
      await close();
    }
  });

  it('Claude Code: the update to a version Ferretry has not verified is RISKY: a danger button in a group of its own at the foot, with the consequence in words', async () => {
    const { page, close } = await open(1_280, 1_000, 'claude-code', 'claude-code');
    try {
      const risky = await page.evaluate(() => {
        const button = document.querySelector<HTMLElement>('[data-unverified-update]');
        const group = button?.closest<HTMLElement>('[data-setting-group]') ?? null;
        const groups = [...document.querySelectorAll<HTMLElement>('.fy-settings-page [data-setting-group]')];
        return {
          variant: button?.getAttribute('data-variant') ?? null,
          group: group?.getAttribute('data-setting-group') ?? null,
          last: groups.at(-1) === group,
          alone: group?.querySelectorAll('button').length === 1,
          words: group?.textContent ?? '',
        };
      });
      expect(risky.variant, 'a danger button').toBe('danger');
      expect(risky.group, 'its own group').toMatch(/^Risky/);
      expect(risky.last, 'at the foot of the page').toBe(true);
      expect(risky.alone, 'the safe update is not beside it').toBe(true);
      expect(risky.words, 'the consequence is said').toContain('could break');
    } finally {
      await close();
    }
  });

  it('Claude Code: the risky update asks first: Cancel sends nothing, Confirm sends one write that names the target', async () => {
    const { page, close } = await open(1_280, 1_000, 'claude-code', 'claude-code');
    try {
      const risky = page.locator('[data-unverified-update]');
      await risky.click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      expect(await dialog.innerText(), 'the dialog says what the update does').toContain('could break');
      expect(await writes(page, 'POST /v1/claude-code/update'), 'opening the dialog writes nothing').toBe(0);
      await page.locator('[data-unverified-cancel]').click();
      await page.waitForTimeout(200);
      expect(await page.getByRole('dialog').count(), 'Cancel closes it').toBe(0);
      expect(await writes(page, 'POST /v1/claude-code/update'), 'Cancel sends nothing').toBe(0);
      await risky.click();
      await page.locator('[data-unverified-confirm]').click();
      await page.waitForTimeout(400);
      expect(await writes(page, 'POST /v1/claude-code/update'), 'Confirm sends exactly one write').toBe(1);
      const body = await page.evaluate(
        () => (globalThis as { __fyBodies?: { route: string; body: unknown }[] }).__fyBodies?.at(-1)?.body,
      );
      expect(body, 'the write confirms and names the version the dialog said').toEqual({
        confirmUnverified: true,
        target: '2.1.44',
      });
    } finally {
      await close();
    }
  });

  it('Claude Code: the safe update names the VERIFIED version and confirms nothing', async () => {
    const { page, close } = await open(1_280, 1_000, 'claude-code', 'claude-code');
    try {
      await page.getByRole('button', { name: 'Update Claude Code' }).click();
      await page.waitForTimeout(400);
      expect(await writes(page, 'POST /v1/claude-code/update')).toBe(1);
      const body = await page.evaluate(
        () => (globalThis as { __fyBodies?: { route: string; body: unknown }[] }).__fyBodies?.at(-1)?.body,
      );
      expect(body).toEqual({ target: '2.1.40' });
    } finally {
      await close();
    }
  });
});
