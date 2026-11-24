/**
 * `<voice>` lines in an assistant message: drawn as speaker lines (`voice-line.tsx`), through the REAL `HypermediaProse`, in
 * a real DOM (happy-dom). Prose around them is still read as Durian hypermedia; code that only SHOWS the tag stays code.
 */
import { describe, expect, it } from 'bun:test';
import { ReferenceSurfaceProvider } from '@ferretry/app';
import { interact, mount } from '@ferretry/app/testing';
import { HypermediaProse } from '../../../../app/hypermedia/hypermedia-prose.tsx';
import { fixture, inShell } from './surface-fixture.tsx';

const FENCE = '`'.repeat(3);

const draw = async (text: string, arriving = false) => {
  const f = fixture();
  const mounted = await mount(
    inShell(
      <ReferenceSurfaceProvider surface={f.surface}>
        <HypermediaProse arriving={arriving} text={text} />
      </ReferenceSurfaceProvider>,
    ) as never,
  );
  await interact(() => Promise.resolve());
  await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
  return mounted;
};

const lines = (root: ParentNode): { readonly words: string; readonly state: string | null }[] =>
  [...root.querySelectorAll('[data-fy-voice-line]')].map(line => ({
    words: line.querySelector('.fy-voice-line__words')?.textContent ?? '',
    state: line.getAttribute('data-fy-voice-line'),
  }));

describe('a spoken line in a reply', () => {
  it('is a speaker line, and the tag is not shown as text', async () => {
    const { container, unmount } = await draw('Checking the tests.\n\n<voice>Let me check.</voice>\n\nDone.');
    expect(lines(container)).toEqual([{ words: 'Let me check.', state: 'closed' }]);
    expect(container.textContent).not.toContain('<voice>');
    expect(container.textContent).toContain('Checking the tests.');
    expect(container.textContent).toContain('Done.');
    await unmount();
  });

  it('draws the opening and the closing line of a long answer, with the work between them as prose', async () => {
    const { container, unmount } = await draw(
      ['<voice>On it.</voice>', '', '## Result', '', '- one', '- two', '', '<voice>All three pass.</voice>'].join('\n'),
    );
    expect(lines(container).map(line => line.words)).toEqual(['On it.', 'All three pass.']);
    expect(container.querySelectorAll('.dh-doc ul li').length).toBe(2);
    await unmount();
  });

  it('keeps words as text, never as markup', async () => {
    const { container, unmount } = await draw('<voice>I <b>said</b> **this**</voice>');
    expect(lines(container)[0]?.words).toBe('I <b>said</b> **this**');
    expect(container.querySelector('[data-fy-voice-line] b')).toBeNull();
    await unmount();
  });

  it('leaves a tag inside a code fence or a code span as the code it is', async () => {
    const { container, unmount } = await draw(
      `Say it like this: \`<voice>hi</voice>\`\n\n${FENCE}\n<voice>hi</voice>\n${FENCE}`,
    );
    expect(lines(container)).toEqual([]);
    expect(container.textContent).toContain('<voice>hi</voice>');
    await unmount();
  });

  it('shows an unclosed tag in a finished message as the text it is', async () => {
    const { container, unmount } = await draw('Hello.\n\n<voice>never closed');
    expect(lines(container)).toEqual([]);
    expect(container.textContent).toContain('<voice>never closed');
    await unmount();
  });

  it('draws an unclosed tag as an open line while the message is arriving', async () => {
    const { container, unmount } = await draw('Hello.\n\n<voice>Let me ch', true);
    expect(lines(container)).toEqual([{ words: 'Let me ch', state: 'open' }]);
    await unmount();
  });

  it('is a plain document when there is no voice line', async () => {
    const { container, unmount } = await draw('Just a reply.');
    expect(lines(container)).toEqual([]);
    expect(container.querySelectorAll('.dh-doc').length).toBe(1);
    await unmount();
  });
});
