/**
 * THE TEACHING AND THE APP AGREE (r12 H4 follow-up). Every example the agent guide shows is a message an agent will copy,
 * so each one must (a) pass `fy render check` with no finding at all and (b) really draw in the app as the part it teaches,
 * with no error box and no source fallback. And the guide teaches exactly the parts the app draws: a part held as code
 * (Durian's `chart`, the `codewalk`) is never taught.
 *
 * The guide is read the way the binary ships it (`RENDER_GUIDE_SECTION`); `guide-drift.test.ts` pins that to the doc.
 * Drawn for real in happy-dom over the fake reference surface; the animation engine is a lazy chunk, so it is loaded first.
 */
import { describe, expect, it } from 'bun:test';
import { type ReferenceSurface, ReferenceSurfaceProvider } from '@ferretry/app';
import { interact, mount } from '@ferretry/app/testing';
import type { ReactNode } from 'react';
import { animationEngineReady, loadAnimationEngine } from '../../../../app/hypermedia/animation-engine.ts';
import { HypermediaProse } from '../../../../app/hypermedia/hypermedia-prose.tsx';
import { readMessage } from '../../../../app/hypermedia/parse-message.ts';
import { checkMessage } from '../../../../cli/reading/check.ts';
import { RENDER_GUIDE_SECTION } from '../../../../cli/reading/guide-text.ts';
import { fixture, inShell } from './surface-fixture.tsx';

/** One fenced block of the guide: its info string, its body, and the whole fence as an agent would copy it. */
interface Example {
  readonly info: string;
  readonly body: string;
  readonly text: string;
}

const OPENER = /^(?<run>`{3,}|~{3,})(?<info>.*)$/u;

/** Every fenced block of a text, in order (a block is closed by a line of only the same mark, at least as long). */
function fencesOf(text: string): readonly Example[] {
  const lines = text.split('\n');
  const found: Example[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const open = OPENER.exec(lines[index] as string)?.groups;
    if (open === undefined) continue;
    const run = open.run as string;
    let end = index + 1;
    while (end < lines.length && !(lines[end] as string).startsWith(run)) end += 1;
    found.push({
      info: (open.info as string).trim(),
      body: lines.slice(index + 1, end).join('\n'),
      text: lines.slice(index, end + 1).join('\n'),
    });
    index = end;
  }
  return found;
}

/** The parts the app draws from a fence, by the first word of its info string, and the block type each becomes. */
const DRAWN_FENCES: Readonly<Record<string, string>> = {
  terminal: 'terminal',
  filetree: 'filetree',
  editor: 'editor',
  animation: 'animation',
  tierlist: 'tierlist',
  alignment: 'alignment',
  mermaid: 'mermaid',
};

/** The words of a fence Durian reads as a part but the app holds as code: never taught. */
const HELD_FENCES = ['chart', 'codewalk'] as const;

const FENCES = fencesOf(RENDER_GUIDE_SECTION);
const firstWord = (info: string): string => info.split(/\s+/u)[0] ?? '';
/** Examples of a Durian part are the fences named for it; an `md` fence is a whole message (the containers). */
const EXAMPLES = FENCES.filter(each => firstWord(each.info) in DRAWN_FENCES || firstWord(each.info) === 'md');
/** The message an example stands for. */
const messageOf = (example: Example): string => (firstWord(example.info) === 'md' ? example.body : example.text);

/** The fake surface, lending the one door a mermaid step is drawn through (the sandbox itself is Chromium evidence). */
const surface = (): ReferenceSurface => ({
  ...fixture().surface,
  fences: { remark: [], draw: (): ReactNode => <div data-fy-render-type="mermaid">drawn</div> },
});

const draw = async (text: string) => {
  const tree = inShell(
    <ReferenceSurfaceProvider surface={surface()}>
      <HypermediaProse text={text} />
    </ReferenceSurfaceProvider>,
  ) as ReactNode;
  const mounted = await mount(tree as never);
  await interact(() => Promise.resolve());
  return mounted;
};

describe('the guide teaches the parts the app draws', () => {
  it('has an example for every part and container it teaches, the 3D animation and the steps among them', () => {
    const words = new Set(EXAMPLES.map(each => firstWord(each.info)));
    for (const part of Object.keys(DRAWN_FENCES)) expect(words).toContain(part);
    expect(words).toContain('md');
    const bodies = EXAMPLES.map(each => each.text).join('\n');
    expect(bodies).toContain(':::tabs');
    expect(bodies).toContain(':::accordion');
    expect(EXAMPLES.some(each => /^animation\s+3d\b/u.test(each.info))).toBe(true);
    expect(bodies).toContain('@step');
  });

  it('never teaches a part the app holds as code: no fence, no section for a Durian chart or a code walk', () => {
    for (const held of HELD_FENCES) {
      expect(FENCES.map(each => firstWord(each.info))).not.toContain(held);
      expect(RENDER_GUIDE_SECTION).not.toContain(`### ${held}\n\nA \`${held}\` fence`);
    }
    expect(RENDER_GUIDE_SECTION).not.toContain('### codewalk');
    // The chart that draws is the fy-render chart, named as one.
    expect(RENDER_GUIDE_SECTION).toContain('An `fy-render` block of `type: chart`');
  });
});

describe('every example of the guide passes `fy render check` and draws', () => {
  it('finds examples to test (the extraction itself is not empty)', () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(9);
  });

  for (const [number, example] of EXAMPLES.entries()) {
    const label = `${number + 1}. ${firstWord(example.info)}${example.info.includes('3d') ? ' 3d' : ''}`;

    it(`${label}: passes fy render check with no finding`, () => {
      expect(checkMessage(messageOf(example))).toEqual([]);
    });

    it(`${label}: is read as the part it teaches, with no problem and no error block`, async () => {
      await loadAnimationEngine();
      expect(animationEngineReady()).toBe(true);
      const { doc } = readMessage(messageOf(example), 'teach-');
      expect(doc.problems).toEqual([]);
      const types = doc.blocks.map(block => block.type);
      expect(types).not.toContain('error');
      const word = firstWord(example.info);
      if (word === 'md') expect(types.some(type => type === 'tabs' || type === 'accordion')).toBe(true);
      else expect(types).toContain(DRAWN_FENCES[word] as never);
    });

    it(`${label}: draws in the app, not as source and not as an error`, async () => {
      await loadAnimationEngine();
      const { container, unmount } = await draw(messageOf(example));
      expect(container.querySelector('.dh-doc')).not.toBeNull();
      expect(container.querySelector('.dh-error, [data-dh-missing]')).toBeNull();
      const word = firstWord(example.info);
      if (word === 'animation') expect(container.querySelector('[data-fy-animation] .scn')).not.toBeNull();
      else if (word === 'mermaid')
        expect(container.querySelector('.dh-doc [data-fy-render-type="mermaid"]')).not.toBeNull();
      else if (word === 'md') expect(container.querySelector('.dh-doc .tabs, .dh-doc .accordion')).not.toBeNull();
      else expect(container.querySelector(`.dh-doc [data-dh-part="${DRAWN_FENCES[word]}"]`)).not.toBeNull();
      await unmount();
    });
  }
});
