import { describe, it } from 'bun:test';
import should from 'should';
import { newItemTabs, tabFieldsOf, tabText } from '../../../cli/lib/tab-flags.ts';
import { agentItem } from './fixtures.ts';

/**
 * THE TAB FLAGS (&F923; docs/agenda.md § The tabs): `--where-file` writes the main tab, `--tab-file "Name=file"`,
 * `--rename-tab`, `--move-tab` and `--remove-tab` become the edit's tab operations, and `show --tab` prints one tab
 * exactly as written.
 */

const files: Record<string, string> = {
  'where.md': '## Status\nBuilding.\n',
  'risks.md': 'The export may slip.',
  'empty.md': '   ',
  '-': 'From stdin.',
};
const read = async (path: string): Promise<string> => {
  const found = files[path];
  if (found === undefined) throw new Error(`no ${path}`);
  return found;
};

describe('the tab flags as request fields', () => {
  it('should read the main tab and each tab file, then the renames, moves and removals, in that order', async () => {
    // Act
    const fields = await tabFieldsOf(
      {
        whereFile: 'where.md',
        tabFile: ['Risks=risks.md', 'Notes = - '],
        renameTab: ['Status=Progress'],
        moveTab: ['Risks=1'],
        removeTab: [' Old ', ''],
      },
      [],
      read,
    );

    // Assert
    should(fields).deepEqual({
      whereWeAre: '## Status\nBuilding.',
      tabEdits: [
        { tab: 'Risks', body: 'The export may slip.' },
        { tab: 'Notes', body: 'From stdin.' },
        { tab: 'Status', rename: 'Progress' },
        { tab: 'Risks', position: 1 },
        { tab: 'Old', remove: true },
      ],
    });
  });

  it('should give nothing when no tab flag is given', async () => {
    should(await tabFieldsOf({}, undefined, read)).deepEqual({});
    should(await tabFieldsOf({ whereFile: ' ' }, 'Building.', read)).deepEqual({});
  });

  it('should refuse what it cannot read in plain words', async () => {
    await should(tabFieldsOf({ whereFile: 'where.md' }, ['Building.'], read)).be.rejectedWith(/not both/u);
    await should(tabFieldsOf({ whereFile: '-', tabFile: ['A=-'] }, undefined, read)).be.rejectedWith(
      /only one file can be read from standard input/u,
    );
    await should(tabFieldsOf({ whereFile: '-' }, undefined, read, 1)).be.rejectedWith(/standard input/u);
    await should(tabFieldsOf({ whereFile: 'empty.md' }, undefined, read)).be.rejectedWith(
      /--where-file empty.md is empty/u,
    );
    await should(tabFieldsOf({ tabFile: ['A=empty.md'] }, undefined, read)).be.rejectedWith(
      /--tab-file A=empty.md is empty/u,
    );
    await should(tabFieldsOf({ tabFile: ['risks.md'] }, undefined, read)).be.rejectedWith(
      /--tab-file takes "Name=value", not "risks.md"/u,
    );
    await should(tabFieldsOf({ renameTab: ['=New'] }, undefined, read)).be.rejectedWith(/--rename-tab takes/u);
    await should(tabFieldsOf({ moveTab: ['Risks=0'] }, undefined, read)).be.rejectedWith(/counts from 1/u);
    await should(tabFieldsOf({ moveTab: ['Risks=first'] }, undefined, read)).be.rejectedWith(/counts from 1/u);
  });
});

describe('a new item’s tabs', () => {
  it('should take the tab files in order, and nothing else', () => {
    should(newItemTabs(undefined)).be.undefined();
    should(newItemTabs([{ tab: 'Risks', body: 'x' }])).deepEqual([{ id: 'risks', name: 'Risks', body: 'x' }]);
    should(() => newItemTabs([{ tab: 'Risks', remove: true }])).throw(/takes --tab-file only/u);
    should(() => newItemTabs([{ tab: 'a=b', body: 'x' }])).throw(/"="/u);
  });
});

describe('show --tab', () => {
  const item = agentItem('A4', 'plan the relay', {
    whereWeAre: '## Status\nBuilding.',
    decided: '- SQLite',
    body: 'The report.',
    tabs: [{ id: 'risks', name: 'Risks', body: 'The export may slip.' }],
  });

  it('should print one tab exactly as written, named by id or by name in any case', () => {
    should(tabText(item, 'main')).equal('## Status\nBuilding.');
    should(tabText(item, 'Where we are now')).equal('## Status\nBuilding.');
    should(tabText(item, 'BODY')).equal('The report.');
    should(tabText(item, ' risks ')).equal('The export may slip.');
    // The main tab of an item whose main tab holds only the decided points prints nothing it did not write.
    should(tabText(agentItem('A5', 'x', { decided: '- SQLite' }), 'main')).equal('');
  });

  it('should read a renamed tab by its new name or its kept id (review of &F923)', () => {
    const renamed = agentItem('A7', 'x', {
      tabs: [
        { id: 'status', name: 'Progress', body: 'The progress.' },
        { id: 'risks', name: 'Open risks', body: 'The status.' },
      ],
    });
    should(tabText(renamed, 'open RISKS')).equal('The status.');
    should(tabText(renamed, 'risks')).equal('The status.');
    should(tabText(renamed, 'status')).equal('The progress.');
  });

  it('should name the tabs it has when one is not there', () => {
    should(() => tabText(item, 'Decisions')).throw(
      '!A4 has no tab "Decisions": its tabs are "Where we are now" (main), "The full picture" (body), "Risks" (risks)',
    );
    should(() => tabText(agentItem('A6', 'x'), 'main')).throw('!A6 has no tabs yet');
  });
});
