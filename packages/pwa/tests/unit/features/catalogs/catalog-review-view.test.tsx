import { describe, expect, it } from 'bun:test';
import { MarkedText, ReviewBody, WarningList } from '../../../../src/features/catalogs/catalog-review-view.tsx';
import { mount } from '../../../support/dom.ts';

const MARK = '⟨U+202E⟩';

describe('MarkedText', () => {
  it('draws each hidden-character marker on its own and keeps every other character', async () => {
    const view = await mount(<MarkedText text={`ab${MARK}cd`} />);
    const marks = view.container.querySelectorAll('mark[data-hidden-marker]');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toBe(MARK);
    expect(view.container.textContent).toBe(`ab${MARK}cd`);
    await view.unmount();
  });
});

describe('hidden characters', () => {
  const RAW = String.fromCodePoint(0x202e);
  it('never puts the raw character on screen, in a marker or beside it', async () => {
    const view = await mount(<MarkedText text={`run ${RAW}fdp.sh`} />);
    expect(view.container.textContent).not.toContain(RAW);
    expect(view.container.querySelector('mark[data-hidden-marker]')?.textContent).toBe(MARK);
    await view.unmount();
  });
  it('marks a raw character in a file body and in a one-line value', async () => {
    const view = await mount(
      <ReviewBody
        entries={[
          { label: 'Skill file SKILL.md', text: `Run split.sh ${RAW}gnp.sh`, document: true },
          { label: 'Starts', text: `acme ${RAW}`, document: false },
        ]}
      />,
    );
    expect(view.container.textContent).not.toContain(RAW);
    expect(view.container.querySelectorAll('mark[data-hidden-marker]')).toHaveLength(2);
    await view.unmount();
  });
});

describe('ReviewBody', () => {
  const files = [
    { label: 'Skill file SKILL.md', text: '# pdf tools\nline two', document: true },
    { label: 'Skill file run.sh', text: 'echo hi', document: true },
    { label: 'Skill file bad.sh', text: `echo ${MARK}`, document: true },
  ];

  it('shows every file in full, every one open, and flags a hidden character in words', async () => {
    const view = await mount(<ReviewBody entries={files} />);
    const blocks = [...view.container.querySelectorAll('details')];
    expect(blocks.map(block => block.open)).toEqual([true, true, true]);
    expect(blocks[0]?.textContent).toContain('2 lines');
    expect(blocks[1]?.textContent).toContain('1 line');
    expect(blocks[2]?.textContent).toContain('Has hidden characters');
    expect(view.container.querySelector('mark[data-hidden-marker]')?.textContent).toBe(MARK);
    expect(view.container.textContent).toContain('echo hi');
    await view.unmount();
  });

  const lines = [
    { label: 'Starts', text: 'acme-mcp --stdio', document: false },
    { label: 'Environment ACME_TOKEN', text: '${secret:ACME_TOKEN}', document: false },
  ];

  it('shows a secret placeholder exactly as written to the installer', async () => {
    const view = await mount(<ReviewBody entries={lines} />);
    expect(view.container.textContent).toContain('${secret:ACME_TOKEN}');
    expect(view.container.textContent).not.toContain('The installer fills in their own');
    await view.unmount();
  });

  it('tells the publisher the installer fills in their own', async () => {
    const view = await mount(<ReviewBody entries={lines} installerView />);
    expect(view.container.textContent).toContain('The installer fills in their own');
    expect(view.container.textContent).not.toContain('${secret:ACME_TOKEN}');
    expect(view.container.textContent).toContain('acme-mcp --stdio');
    await view.unmount();
  });
});

describe('WarningList', () => {
  it('draws nothing for no warnings', async () => {
    const view = await mount(<WarningList warnings={[]} />);
    expect(view.container.querySelector('[data-review-warnings]')).toBeNull();
    await view.unmount();
  });

  it('puts the older version first and gives each warning words, not only a colour', async () => {
    const view = await mount(
      <WarningList
        warnings={[
          { code: 'unpinned-package', text: 'It runs npx acme.' },
          { code: 'first-publisher', text: 'New publisher.' },
          { code: 'older-version', text: 'Version 1 is older than 2.' },
        ]}
      />,
    );
    const items = [...view.container.querySelectorAll('li[data-warning]')];
    expect(items.map(item => item.getAttribute('data-warning'))).toEqual([
      'older-version',
      'unpinned-package',
      'first-publisher',
    ]);
    expect(items.map(item => item.getAttribute('data-warning-tone'))).toEqual(['danger', 'caution', 'note']);
    expect(items[0]?.textContent).toContain('Older version');
    expect(items[0]?.textContent).toContain('Version 1 is older than 2.');
    expect(items[0]?.querySelector('svg')).not.toBeNull();
    await view.unmount();
  });
});
