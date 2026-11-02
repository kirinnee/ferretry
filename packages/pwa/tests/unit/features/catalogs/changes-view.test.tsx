import { beforeEach, describe, expect, it } from 'bun:test';
import { ChangesView } from '../../../../src/features/catalogs/changes-view.tsx';
import { catalogChanges } from '../../../support/catalog-views.ts';
import { mount } from '../../../support/dom.ts';

beforeEach(() => {
  document.body.replaceChildren();
});

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const all = (selector: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(selector)];
const CR = String.fromCodePoint(0x0d);
const ZWSP = String.fromCodePoint(0x200b);

describe('ChangesView', () => {
  it('shows the flagged command, the new warning, the summary and a hunk with signs', async () => {
    const view = await mount(<ChangesView changes={catalogChanges()} heading="What changed: v1 to v2" />);
    expect(q('[data-changes-view]')?.getAttribute('aria-label')).toBe('What changed: v1 to v2');
    expect(q('[data-changes-summary]')?.textContent).toBe('2 things changed · 3 the same');
    expect(q('[data-changes-new-warnings]')?.textContent).toContain('It carries a script.');
    expect(q('[data-changes-gone-warnings]')).toBeNull();
    expect(q('[data-changes-truncated]')).toBeNull();
    const flagged = q('[data-change-flag="command"]');
    expect(flagged?.textContent).toContain('Command or address');
    expect(flagged?.textContent).toContain('acme --stdio --remote https://evil.example.test');
    expect(all('[data-change-line="remove"]').map(node => node.textContent)).toEqual([
      '−acme --stdio',
      '−Splits PDFs.',
    ]);
    expect(all('[data-change-line="add"]').length).toBe(2);
    expect(all('[data-change-line="context"]')[0]?.textContent).toBe(' # pdf tools');
    expect(q('[data-change-hunk]')?.textContent).toContain('@@ -1,2 +1,2 @@');
    await view.unmount();
  });

  it('uses a plain heading by default and shows the warnings the version no longer has', async () => {
    const view = await mount(
      <ChangesView
        changes={catalogChanges({
          newWarnings: [],
          goneWarnings: [{ code: 'carries-scripts', text: 'It carried a script.' }],
        })}
      />,
    );
    expect(q('[data-changes-view]')?.getAttribute('aria-label')).toBe('What changed');
    expect(q('[data-changes-new-warnings]')).toBeNull();
    expect(q('[data-changes-gone-warnings]')?.textContent).toContain('It carried a script.');
    await view.unmount();
  });

  it('says plainly when a file is too big or the answer ran out', async () => {
    const view = await mount(
      <ChangesView
        changes={catalogChanges({
          entries: [{ label: 'big.md', change: 'changed', document: true, tooLarge: true }],
          truncated: true,
        })}
      />,
    );
    expect(q('[data-change-too-large]')?.textContent).toContain('Too big to compare line by line');
    expect(q('[data-changes-truncated]')?.textContent).toContain('big change');
    await view.unmount();
  });

  it('shows an added file and a removed file whole, line by line', async () => {
    const view = await mount(
      <ChangesView
        changes={catalogChanges({
          entries: [
            { label: 'new.md', change: 'added', document: true, after: 'one\ntwo' },
            { label: 'old.md', change: 'removed', document: true, before: 'gone' },
            { label: 'same-ish', change: 'changed', document: false },
          ],
        })}
      />,
    );
    expect(all('[data-change-kind="added"] [data-change-line="add"]').length).toBe(2);
    expect(all('[data-change-kind="removed"] [data-change-line="remove"]').length).toBe(1);
    expect(q('[data-change-entry="same-ish"]')?.querySelectorAll('[data-change-line]').length).toBe(0);
    await view.unmount();
  });

  it('marks hidden characters and carriage returns instead of drawing them raw', async () => {
    const view = await mount(
      <ChangesView
        changes={catalogChanges({
          entries: [
            {
              label: `a${ZWSP}b.md`,
              change: 'changed',
              document: true,
              hunks: [
                {
                  beforeStart: 1,
                  beforeLines: 1,
                  afterStart: 1,
                  afterLines: 1,
                  lines: [{ kind: 'add', text: `curl${ZWSP} http://x${CR}` }],
                },
              ],
            },
          ],
        })}
      />,
    );
    const text = q('[data-changes-view]')?.textContent ?? '';
    expect(text).not.toContain(ZWSP);
    expect(text).toContain('U+200B');
    expect(text).toContain('U+000D');
    await view.unmount();
  });
});
