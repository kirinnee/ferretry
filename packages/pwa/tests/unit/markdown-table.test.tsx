import { describe, test } from 'bun:test';
import should from 'should';
import { MarkdownTable } from '../../src/components/markdown-table.tsx';
import { TableViewPreferenceStore, type TableViewStorage } from '../../src/lib/table-view-preference.ts';
import { interact, mount, must } from '../support/dom.ts';

const memory = (): TableViewStorage => {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
};

const rows = (
  <>
    <thead>
      <tr>
        <th scope="col">Who</th>
        <th scope="col">State</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td data-label="Who">Hadi</td>
        <td data-label="State">working</td>
      </tr>
    </tbody>
  </>
);

const button = (root: ParentNode, name: string): HTMLButtonElement =>
  must(
    [...root.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === name),
    `the ${name} button`,
  );

describe('MarkdownTable', () => {
  test('opens as cards, switches every table to the real one, and offers it full screen', async () => {
    const store = new TableViewPreferenceStore(memory());
    const view = await mount(
      <>
        <MarkdownTable store={store}>{rows}</MarkdownTable>
        <MarkdownTable store={store}>{rows}</MarkdownTable>
      </>,
    );
    const tables = () => [...view.container.querySelectorAll<HTMLElement>('[data-md-table-view]')];
    should(tables().map(table => table.dataset.mdTableView)).eql(['cards', 'cards']);
    const group = must(view.container.querySelector('fieldset'), 'the view switch');
    should(group.getAttribute('aria-label')).equal('Table view');
    should(button(group, 'Cards').getAttribute('aria-pressed')).equal('true');
    should(group.querySelector('[data-md-table-full]')).be.null();

    await interact(() => button(group, 'Table').click());
    // Both tables follow the one device-wide choice.
    should(tables().map(table => table.dataset.mdTableView)).eql(['table', 'table']);
    should(button(group, 'Table').getAttribute('aria-pressed')).equal('true');

    const full = must(group.querySelector<HTMLButtonElement>('[data-md-table-full]'), 'Full screen');
    should(full.getAttribute('aria-expanded')).equal('false');
    await interact(() => full.click());
    should(full.getAttribute('aria-expanded')).equal('true');
    const sheet = must(document.body.querySelector(`[id="${full.getAttribute('aria-controls')}"]`), 'the sheet');
    // At the document root, never inside the transcript it was opened from.
    should(view.container.contains(sheet)).be.false();
    should(sheet.querySelector('.md-table-pan table')?.textContent).containEql('Hadi');

    await interact(() => must(sheet.querySelector<HTMLButtonElement>('[data-sheet-swipe]'), 'close').click());
    should(full.getAttribute('aria-expanded')).equal('false');

    await interact(() => button(group, 'Cards').click());
    should(tables().map(table => table.dataset.mdTableView)).eql(['cards', 'cards']);
    await view.unmount();
  });

  test('a table with no store of its own uses the device-wide one', async () => {
    const view = await mount(<MarkdownTable>{rows}</MarkdownTable>);
    should(view.container.querySelector('table')?.textContent).containEql('working');
    await view.unmount();
  });
});
