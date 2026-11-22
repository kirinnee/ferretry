/** The Safari page's verdict (r12 H8): what passes, and every way the page can be wrong. */
import { describe, expect, it } from 'bun:test';
import { REQUIRED_PARTS, type PageReport, verdict } from '../../safari/verdict.ts';

const drawn = Object.fromEntries(REQUIRED_PARTS.map(selector => [selector, 1]));
const clean: PageReport = { csp: [], errors: [], console: [], docs: 1, parts: drawn };

describe('the Safari page verdict', () => {
  it('passes a page with every part drawn and nothing reported', () => {
    expect(verdict(clean)).toEqual([]);
  });

  it('fails a console.error or console.warn the page made', () => {
    expect(verdict({ ...clean, console: ['error boom'] })).toEqual(['console: error boom']);
    expect(verdict({ ...clean, console: ['warn careful'] })).toEqual(['console: warn careful']);
  });

  it('fails a policy violation, a page error and a failed load', () => {
    expect(verdict({ ...clean, csp: ['script-src inline'] })).toEqual(['policy violation: script-src inline']);
    expect(verdict({ ...clean, errors: ['rejection oops', 'failed to load /x.png'] })).toEqual([
      'page error: rejection oops',
      'page error: failed to load /x.png',
    ]);
  });

  it('fails a page with no message drawn, or two, or a missing part', () => {
    expect(verdict({ ...clean, docs: 0 })).toEqual(['expected one .dh-doc, found 0']);
    expect(verdict({ ...clean, docs: 2 })).toEqual(['expected one .dh-doc, found 2']);
    expect(verdict({ ...clean, parts: { ...drawn, '.term': 0 } })).toEqual(['no .term was drawn']);
  });

  it('names a part the report left out as not drawn', () => {
    expect(verdict({ ...clean, parts: {} })).toHaveLength(REQUIRED_PARTS.length);
  });
});
