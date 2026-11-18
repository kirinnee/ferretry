import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `public/prefetch-views.js` fetches the plugin view chunks at idle after the page loads, and NOTHING when the reader
 * asked to save data. Like `pre-paint.test.ts`, this runs the REAL FILE with `document`, `navigator` and `window`
 * supplied as parameters.
 */
const source = readFileSync(join(import.meta.dir, '../../public/prefetch-views.js'), 'utf8');

interface Setup {
  readonly chunks?: string | null;
  readonly connection?: { saveData?: boolean; effectiveType?: string };
  readonly reducedData?: boolean;
  readonly ready?: 'loading' | 'complete';
}

function run(setup: Setup): { links: { rel: string; as: string; href: string }[]; idle: number; loaded: () => void } {
  const links: { rel: string; as: string; href: string }[] = [];
  const state = { idle: 0 };
  let onLoad: () => void = () => {};
  const tag = { getAttribute: (name: string) => (name === 'data-chunks' ? (setup.chunks ?? null) : null) };
  const document = {
    currentScript: tag,
    readyState: setup.ready ?? 'loading',
    head: { appendChild: (link: { rel: string; as: string; href: string }) => links.push(link) },
    createElement: () => ({ rel: '', as: '', crossOrigin: '', href: '' }),
  };
  const navigator = setup.connection === undefined ? {} : { connection: setup.connection };
  const window = {
    matchMedia: (query: string) => ({ matches: setup.reducedData === true && query.includes('prefers-reduced-data') }),
    requestIdleCallback: (callback: () => void) => {
      state.idle += 1;
      callback();
    },
    addEventListener: (_event: string, callback: () => void) => {
      onLoad = callback;
    },
  };
  new Function('document', 'navigator', 'window', source)(document, navigator, window);
  return {
    links,
    get idle() {
      return state.idle;
    },
    loaded: () => onLoad(),
  };
}

const CHUNKS = 'assets/a-1.js,assets/b-2.js';

describe('the view prefetch', () => {
  test('after the page has loaded and the browser is idle, every listed chunk is prefetched, not before', () => {
    const page = run({ chunks: CHUNKS });
    expect(page.links).toEqual([]);
    page.loaded();
    expect(page.links.map(l => [l.rel, l.as, l.href])).toEqual([
      ['prefetch', 'script', '/assets/a-1.js'],
      ['prefetch', 'script', '/assets/b-2.js'],
    ]);
  });

  test('a page that has already loaded prefetches at idle at once', () => {
    expect(run({ chunks: CHUNKS, ready: 'complete' }).links).toHaveLength(2);
  });

  test('Save-Data, a 2g-class connection or prefers-reduced-data fetch nothing', () => {
    for (const setup of [
      { connection: { saveData: true } },
      { connection: { effectiveType: 'slow-2g' } },
      { connection: { effectiveType: '2g' } },
      { reducedData: true },
    ]) {
      const page = run({ chunks: CHUNKS, ready: 'complete', ...setup });
      page.loaded();
      expect(page.links).toEqual([]);
    }
    expect(
      run({ chunks: CHUNKS, ready: 'complete', connection: { saveData: false, effectiveType: '4g' } }).links,
    ).toHaveLength(2);
  });

  test('no list, or a name that is not a plain same-origin chunk path, fetches nothing', () => {
    expect(run({ chunks: null, ready: 'complete' }).links).toEqual([]);
    const page = run({ chunks: 'https://evil.test/x.js,../up.js,assets/ok.js', ready: 'complete' });
    expect(page.links.map(l => l.href)).toEqual(['/assets/ok.js']);
  });
});
