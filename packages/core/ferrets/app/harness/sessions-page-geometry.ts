/**
 * THE SESSIONS PAGE NEVER SCROLLS SIDEWAYS ON A PHONE, MEASURED IN A REAL BROWSER.
 *
 * The page's groups sat in a grid with one implicit `auto` column, which is as wide as its widest
 * unbreakable line: one long task title or path widened every group past the phone, and the list's
 * scroller (`overflow-y: auto` makes `overflow-x` auto too) scrolled sideways. Short names hide it, so the
 * frame carries the worst text (`?long-names=1`: an unbroken title, path, model, label and question) and
 * the page is measured at the four widths a phone spans, in every density.
 *
 * Every check announces itself and is counted: a check that stops being reached reads exactly like one
 * that passed, so the run owes `SESSIONS_PAGE_GEOMETRY_CHECKS`.
 */

import type { Browser } from 'playwright-core';

const WIDTHS = [320, 360, 390, 430] as const;
const DENSITIES = ['full', 'compact', 'minimal'] as const;
const EPSILON = 1;

export const SESSIONS_PAGE_GEOMETRY_CHECKS = WIDTHS.length * DENSITIES.length;

export interface SessionsPageRun {
  readonly browser: Browser;
  readonly rootUrl: string;
  readonly scheme: 'light' | 'dark';
  readonly fail: (message: string) => never;
}

export async function runSessionsPageGeometry(run: SessionsPageRun): Promise<number> {
  const { browser, rootUrl, scheme, fail } = run;
  let checks = 0;
  // ONE LOAD PER DENSITY, the four widths reached by resizing the same page: density is read from the URL
  // once at mount, while width is only ever CSS and the layout hook's phone/drawer answer (all four widths
  // are phone), so a resize lands exactly where a fresh load at that width would.
  for (const density of DENSITIES) {
    const context = await browser.newContext({
      viewport: { width: WIDTHS[0], height: 800 },
      isMobile: true,
      hasTouch: true,
      colorScheme: scheme,
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      await page.goto(`${rootUrl}?app-chrome=sessions&long-names=1&density=${density}`);
      await page
        .getByText(/bartholomew/i)
        .first()
        .waitFor({ state: 'attached' });
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        const m = await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const scroller = document.querySelector('[data-density-region="dashboard-scroller"]');
          const groups = [...document.querySelectorAll('.fy-session-group')];
          return {
            page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            scroller: scroller === null ? Number.NaN : scroller.scrollWidth - scroller.clientWidth,
            widestGroup: Math.max(...groups.map(group => group.getBoundingClientRect().width)),
            viewport: document.documentElement.clientWidth,
            sawLongName: /bartholomew/i.test(document.body.innerText),
          };
        });
        if (!m.sawLongName) fail(`sessions page @ ${width}px ${density}: the long-name fixture did not render`);
        if (m.viewport !== width)
          fail(`sessions page @ ${width}px ${density}: the page is ${m.viewport}px wide after the resize`);
        if (!(m.page <= EPSILON && m.scroller <= EPSILON) || m.widestGroup > m.viewport + EPSILON)
          fail(
            `sessions page @ ${width}px ${density}: scrolls sideways — page +${m.page}px, list +${m.scroller}px, ` +
              `widest group ${Math.round(m.widestGroup)}px in a ${m.viewport}px viewport`,
          );
        checks += 1;
        process.stdout.write(`   sessions page @ ${width}px ${density}: no sideways scroll (long names)\n`);
      }
    } finally {
      await context.close();
    }
  }
  return checks;
}
