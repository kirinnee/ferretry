/**
 * `fy render guide` has ONE source: the `## Guide for agents` section of docs/hypermedia.md (r12 H6). The CLI ships a
 * copy in the binary (`guide-text.ts`, written from the doc by `tests/support/guide-text/generate.ts`), and this test
 * is the contract that fails the commit that lets the two disagree — by one word.
 */
import { describe, expect, test } from 'bun:test';
import { RENDER_GUIDE_SECTION } from '../../../cli/reading/guide-text.ts';
import { guideSectionOf, guideTextModule } from '../../support/guide-text/generate.ts';

const ROOT = new URL('../../../../../../', import.meta.url);
const DOC = await Bun.file(new URL('docs/hypermedia.md', ROOT)).text();
const SHIPPED = await Bun.file(new URL('packages/plugins/conversation/cli/reading/guide-text.ts', ROOT)).text();

describe('the shipped guide equals the doc section', () => {
  test('docs/hypermedia.md has the section, and the binary constant is exactly it', () => {
    const section = guideSectionOf(DOC);
    expect(section).toBeDefined();
    expect(RENDER_GUIDE_SECTION).toBe(section as string);
  });

  test('guide-text.ts is byte-for-byte what the generator writes from the doc', () => {
    expect(SHIPPED).toBe(guideTextModule(guideSectionOf(DOC) as string));
  });

  test('a one-word edit of the doc is drift: the constant no longer equals the section', () => {
    const section = guideSectionOf(DOC) as string;
    const edited = DOC.replace(section, section.replace('Markdown', 'Markdowns'));
    expect(edited).not.toBe(DOC);
    expect(guideSectionOf(edited)).not.toBe(RENDER_GUIDE_SECTION);
    expect(guideTextModule(guideSectionOf(edited) as string)).not.toBe(SHIPPED);
  });

  test('the section names the per-part topics `fy render guide <topic>` answers, and carries no fy-render fence opener', () => {
    const section = guideSectionOf(DOC) as string;
    for (const topic of ['overview', 'terminal', 'chart', 'mermaid', 'human', 'references'])
      expect(section).toContain(`### ${topic}\n`);
    // Taught only once the app draws it (r12 H4 adds each back with its renderer): no section, no mention.
    for (const pending of ['filetree', 'editor', 'animation', 'tierlist', 'alignment', 'tabs', 'accordion']) {
      expect(section).not.toContain(`### ${pending}\n`);
      expect(section).not.toContain(`\`${pending}\``);
    }
    expect(section).not.toContain(':::tabs');
    // The legacy agenda sigil is never spelled out: no guide, prompt or doc teaches it (ask-reference-sigil guard).
    expect(section).not.toContain('!A3');
    // guide-text.ts is source, where no-fy-render-in-docs.sh refuses an opener.
    expect(section).not.toMatch(/^\s*(`{3,}|~{3,})fy-render\s*$/mu);
  });
});
