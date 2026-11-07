import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { ledgerRows, OWNER_OVERRIDE, parseAppendixD } from './guarantees.ts';

const root = join(import.meta.dir, '..', '..');
const regenerated = async () =>
  new Map(
    ledgerRows(parseAppendixD(await Bun.file(join(root, 'docs/design/redesign.md')).text()).rows).map(
      row => [row.id, row.owner] as const,
    ),
  );
const committed = async () =>
  new Map(
    (await Bun.file(join(root, 'docs/rebuild/guarantees.tsv')).text())
      .split('\n')
      .slice(1)
      .filter(line => line.trim() !== '')
      .map(line => {
        const [id = '', , owner = ''] = line.split('\t');
        return [id, owner] as const;
      }),
  );

test('every owner in the committed guarantee table survives regeneration (an owner moved by hand is an OWNER_OVERRIDE)', async () => {
  const fresh = await regenerated();
  const table = await committed();
  const lost = [...table].filter(([id, owner]) => fresh.get(id) !== owner).map(([id, owner]) => `${id} ${owner}`);
  expect(lost).toEqual([]);
});

test('G33 regenerates as Conversation, with Terminals and Gate as co-owners (port-conversation r3 #5)', async () => {
  expect(OWNER_OVERRIDE.G33?.owner).toBe('conversation');
  expect((await regenerated()).get('G33')).toBe('conversation');
});

test('G95 carries its unmounted clause as OPEN, and a G128 row no longer claims "never held"', async () => {
  const rows = ledgerRows(parseAppendixD(await Bun.file(join(root, 'docs/design/redesign.md')).text()).rows);
  const g95 = rows.find(row => row.id === 'G95');
  expect(g95?.notes).toContain('OPEN');
  expect(g95?.notes).toContain('StepUpDialog');
  expect(g95?.notes).toContain('integration fixture');
  expect(rows.find(row => row.id === 'G128a')?.guarantee).not.toContain('never held');
});
