/**
 * Visual contract for the ported theme picker.
 *
 * The port is only finished if it LOOKS like the original, so this renders the
 * ported controls beside a verbatim transcription of kteam's own
 * `ui/src/components/ThemeToggle.tsx` JSX — same data, same compiled stylesheet
 * — and requires the two screenshots to be byte-identical at a phone width and
 * a desktop width.
 *
 * The stylesheet is the REAL one: Tailwind is compiled from
 * `src/styles/index.css` with the shipped config, widened only to also scan this
 * file so the reference markup's classes exist. A hand-written fixture sheet
 * would let a missing class fail both sides equally and pass.
 *
 * The references differ from the port in SEMANTICS only. kteam wrote each option
 * as `<button role="radio">`; this repo's a11y gate rejects that role on a
 * button, so the port makes each option a real radio inside its label — the
 * shape `chat-width-control.tsx` already established — while the two GROUPS stay
 * the same `<div role="radiogroup">` boxes kteam tuned.
 *
 * That last part is this test's finding, not a preference. The groups were
 * fieldsets first, which is the more semantic container; Chrome gives a fieldset
 * a content box a div does not have, and the mode row came out a pixel off the
 * original. The port changed, not the reference.
 *
 * The transcription below drops kteam's `role`/`aria-checked`/`aria-label`
 * attributes — the same omission `task-surfaces.visual.test.tsx` makes, for the
 * same reason: they carry no rendered box, and keeping `role="radio"` on a
 * button would trip the very gate this port exists to satisfy. Everything that
 * OCCUPIES SPACE is transcribed exactly.
 *
 * BOTH VIEWPORTS ARE REQUIRED. The popover is 272px wide below the `sm`
 * breakpoint and 292px at or above it, and the trigger's family label is hidden
 * below `sm`. A picker that only matched at one width would be a failed port.
 */

import { afterAll, beforeAll, describe, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import type { Browser } from 'playwright-core';
import { renderToStaticMarkup } from 'react-dom/server';
import should from 'should';

import {
  THEME_FAMILIES,
  type ResolvedMode,
  type ThemeFamilyId,
  type ThemeMode,
} from '../../../src/lib/theme-preferences.ts';
import { THEME_FAMILY_CARD_CLASS, ThemeSettings } from '../../../src/shell/theme-toggle.tsx';
import type { ThemeState } from '../../../src/hooks/use-theme.ts';
import { sharedChromium } from '../support/chromium.ts';

const packageDir = resolve(import.meta.dir, '../../..');

/** The state a reader on Ember, pinned to dark, with default type would have. */
const FAMILY: ThemeFamilyId = 'phosphor';
const MODE: ThemeMode = 'dark';
const RESOLVED: ResolvedMode = 'dark';

const theme: ThemeState = {
  family: FAMILY,
  mode: MODE,
  textScale: 'default',
  resolved: RESOLVED,
  attr: `${FAMILY}-${RESOLVED}`,
  families: THEME_FAMILIES,
  textScaleSupported: true,
  setFamily: () => {},
  setMode: () => {},
  setTextScale: () => {},
};

// ─── verbatim kteam reference ────────────────────────────────────────────────

const MODE_OPTIONS = [
  { id: 'system', label: 'Auto', Icon: Monitor, hint: 'Follow the operating system' },
  { id: 'light', label: 'Light', Icon: Sun, hint: 'Always light' },
  { id: 'dark', label: 'Dark', Icon: Moon, hint: 'Always dark' },
] as const;

/** `ui/src/components/ThemeToggle.tsx` → `Swatch`, transcribed. */
function OriginalSwatch({ theme: swatch, current }: { theme: string; current: boolean }) {
  return (
    <span
      className={`block min-w-0 flex-1 rounded-sm${current ? ' ring-2 ring-accent ring-offset-1 ring-offset-surface' : ''}`}
    >
      <span className="kt-swatch" data-swatch={swatch} aria-hidden="true">
        <span className="kt-swatch-mini">
          <span className="kt-swatch-header">Aa</span>
          <span className="kt-swatch-row">
            <i />
            <i />
            <i />
          </span>
        </span>
        <i className="kt-swatch-accent" />
        <i className="kt-swatch-signal" />
      </span>
    </span>
  );
}

/** `ui/src/components/ThemeToggle.tsx` → `ThemeSettings`, transcribed. */
function OriginalThemeSettings({ constrained }: { constrained: boolean }) {
  return (
    <>
      <div
        role="radiogroup"
        aria-label="Colour mode"
        className="mb-2 flex gap-1 rounded-control border border-border bg-surface-2 p-1"
      >
        {MODE_OPTIONS.map(({ id, label, Icon, hint }) => {
          const checked = MODE === id;
          return (
            <button
              key={id}
              type="button"
              title={hint}
              className={`flex h-control-sm flex-1 items-center justify-center gap-1 rounded-tab px-control-x text-meta font-medium transition-colors ${
                checked
                  ? 'border border-accent bg-accent-soft text-accent'
                  : 'border border-transparent text-muted hover:text-fg'
              }`}
            >
              <Icon size={12} aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>

      <div
        role="radiogroup"
        aria-label="Theme family"
        className={`flex flex-col gap-1.5${constrained ? ' max-h-[min(60vh,420px)] overflow-y-auto scroll-thin' : ''}`}
      >
        {THEME_FAMILIES.map(option => {
          const checked = option.id === FAMILY;
          return (
            <button
              key={option.id}
              type="button"
              data-family={option.id}
              aria-label={`${option.label} — ${option.blurb}`}
              tabIndex={checked ? 0 : -1}
              className={`${THEME_FAMILY_CARD_CLASS} ${
                checked ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:border-accent'
              }`}
            >
              <span className="flex items-center gap-1">
                <span className="text-ui font-semibold text-fg">{option.label}</span>
                {checked && <Check size={12} className="text-accent" aria-hidden="true" />}
              </span>
              <span className="text-meta leading-base text-muted">{option.blurb}</span>
              <span className="mt-1 flex items-stretch gap-1.5">
                {(['light', 'dark'] as ResolvedMode[]).map(variant => (
                  <OriginalSwatch
                    key={variant}
                    theme={`${option.id}-${variant}`}
                    current={checked && RESOLVED === variant}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>

      <p className="mt-2 border-t border-border-soft pt-1.5 text-2xs leading-base text-faint">
        Previews render in their own theme. Auto follows the OS live.
      </p>
    </>
  );
}

// ─── page assembly ───────────────────────────────────────────────────────────

/**
 * The popover silhouette the picker actually lives in, so the comparison covers
 * the panel's own geometry (`rounded-panel`, `p-panel`, `shadow-popover` and the
 * 272→292px breakpoint) and not just the controls inside it.
 */
const PANEL_CLASS = 'w-[272px] rounded-panel border border-border bg-surface p-panel shadow-popover sm:w-[292px]';

function Port() {
  return (
    <>
      <div className={PANEL_CLASS}>
        <ThemeSettings theme={theme} constrained />
      </div>
      <div className="mt-4 w-full max-w-[420px]" data-settings-scroller>
        <ThemeSettings theme={theme} />
      </div>
    </>
  );
}

function Reference() {
  return (
    <>
      <div className={PANEL_CLASS}>
        <OriginalThemeSettings constrained />
      </div>
      <div className="mt-4 w-full max-w-[420px]">
        <OriginalThemeSettings constrained={false} />
      </div>
    </>
  );
}

/**
 * Both trees are stacked in the SAME box — absolutely positioned at the same
 * origin — and revealed one at a time. Two navigations would compare two paints,
 * and even side-by-side blocks are wrong: a fractional container height puts the
 * second block on a different subpixel phase, so identical markup rasterises one
 * pixel apart. Same page, same box, same fonts, same device scale: a difference
 * can only be the markup.
 */
const documentFor = (css: string, port: string, reference: string): string => `<!doctype html>
<html lang="en" data-theme="${FAMILY}-${RESOLVED}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <style>${css}</style>
    <style>.vis-pane { position: absolute; inset: 0 0 auto 0; } .vis-hidden { display: none; }</style>
  </head>
  <body>
    <div id="root" class="relative p-panel">
      <div class="vis-pane" id="port">${port}</div>
      <div class="vis-pane vis-hidden" id="reference">${reference}</div>
    </div>
  </body>
</html>`;

/** Reveals exactly one pane, so both are measured in the identical box. */
const REVEAL = (id: string): string => `(() => {
  for (const pane of document.querySelectorAll('.vis-pane')) {
    pane.classList.toggle('vis-hidden', pane.id !== ${JSON.stringify(id)});
  }
  return true;
})()`;

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;

let workspace = '';
let browser: Browser;
let css = '';

const buildCss = (outFile: string): void => {
  const result = spawnSync(
    './node_modules/.bin/tailwindcss',
    [
      '--config',
      'tailwind.config.ts',
      '--input',
      'src/styles/index.css',
      '--output',
      outFile,
      '--content',
      './src/**/*.{ts,tsx},./tests/integration/shell/*.tsx',
    ],
    { cwd: packageDir, stdio: 'pipe' },
  );
  if (result.status !== 0) throw new Error(`tailwind build failed: ${result.stderr?.toString() ?? ''}`);
};

describe('ported theme picker visual contract', () => {
  beforeAll(async () => {
    browser = await sharedChromium();
    workspace = await mkdtemp(join(tmpdir(), 'fy-visual-theme-'));
    const outFile = join(workspace, 'app.css');
    buildCss(outFile);
    css = await readFile(outFile, 'utf8');
  }, 120_000);

  afterAll(async () => {
    if (workspace !== '') await rm(workspace, { recursive: true, force: true });
  });

  it('should render pixel-identically to the original kteam markup at both viewports', async () => {
    const page = documentFor(css, renderToStaticMarkup(<Port />), renderToStaticMarkup(<Reference />));
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    });

    try {
      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: 'dark',
          reducedMotion: 'reduce',
        });
        try {
          // A public static bundle must never reach the network, and a live daemon
          // runs on the machine that executes this suite.
          await context.route('**/*', async route => {
            if (new URL(route.request().url()).origin !== server.url.origin) {
              await route.abort();
              return;
            }
            await route.continue();
          });
          const tab = await context.newPage();
          await tab.goto(server.url.toString());

          await tab.evaluate<boolean>(REVEAL('port'));
          const overflow = await tab.evaluate<{ inner: number; scroll: number }>(
            `({ inner: window.innerWidth, scroll: document.documentElement.scrollWidth })`,
          );
          should(overflow.scroll).be.belowOrEqual(overflow.inner);
          const ported = await tab.locator('#port').screenshot({ animations: 'disabled' });

          await tab.evaluate<boolean>(REVEAL('reference'));
          const original = await tab.locator('#reference').screenshot({ animations: 'disabled' });

          should(ported.equals(original)).be.true();
        } finally {
          await context.close();
        }
      }
    } finally {
      server.stop(true);
    }
  }, 120_000);
});
