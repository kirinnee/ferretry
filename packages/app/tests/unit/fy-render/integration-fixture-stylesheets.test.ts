/**
 * The fy-render integration fixture's page loads the stylesheets the real app loads, in the real app's order.
 *
 * The browser tier cannot run here, so this pins the part of its fidelity that is a fact about files: `main.tsx`
 * imports `styles/index.css` and then `ui/design-system.css`, and the fixture builder serves exactly those, in that
 * order. A fixture built from the index alone (as it once was) lost `.kt-overlay` and the `.md` fence, so every
 * fullscreen picture collapsed to its content's height and the fallback fence never scrolled.
 */

import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { APP_STYLESHEETS } from '../../../scripts/build-fy-render-integration-fixture.ts';

const packageRoot = resolve(import.meta.dir, '../../..');

/** The stylesheets `main.tsx` imports, in source order, as package-relative paths. */
const mainStylesheets = async (): Promise<readonly string[]> => {
  const source = await Bun.file(resolve(packageRoot, 'src/main.tsx')).text();
  return [...source.matchAll(/^import '\.\/([^']+\.css)';$/gmu)].map(match => `src/${match[1]}`);
};

describe('the fy-render integration fixture stylesheets', () => {
  it('serves the stylesheets main.tsx loads, in its order', async () => {
    expect(await mainStylesheets()).toEqual([...APP_STYLESHEETS]);
  });

  it('carries the overlay box and the scrolling fence the fullscreen and fallback evidence measures', async () => {
    const sheets = await Promise.all(APP_STYLESHEETS.map(entry => Bun.file(resolve(packageRoot, entry)).text()));
    const all = sheets.join('\n');
    expect(all).toMatch(/^\.kt-overlay \{[^}]*height:/mu);
    expect(all).toMatch(/^\.md pre \{[^}]*overflow: auto;/mu);
  });
});
