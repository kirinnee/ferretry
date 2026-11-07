import { describe, expect, test } from 'bun:test';
import { type KnipIgnore, type TagInput, type TaggedFile, tagFindings, tagsOf } from './pending-tags.ts';

const pending = {
  format: 1 as const,
  pending: ['vault'],
  reasons: {
    vault: [
      'GAP(access): the export screen waits for the passkey mount; app/export-sheet.tsx stays until then',
      'GAP(kernel): no event route yet',
    ],
  },
};
const file = (
  text: string,
  owner: string | undefined = 'vault',
  where = 'packages/plugins/vault/app/x.ts',
): TaggedFile => ({
  where,
  text,
  owner,
  manifest: "export const manifest = { ui: { settings: [{ id: 'secrets-tab' }] }, routes: { 'vault.export': {} } };",
});
const run = (files: readonly TaggedFile[], ignores: readonly KnipIgnore[] = [], over: Partial<TagInput> = {}) =>
  tagFindings({ files, ignores, pending, keptRows: new Set(['S68', 'G90']), ...over }).map(f => f.message);

describe('pending-tags', () => {
  test('reads tags from comments only, with their lines', () => {
    const tags = tagsOf("const a = '@pending vault: x';\n/** @pending vault: no event route yet */\n// @public S68\n");
    expect(tags).toEqual([
      { kind: 'pending', rest: 'vault: no event route yet', line: 2 },
      { kind: 'public', rest: 'S68', line: 3 },
    ]);
  });

  test('@pending naming an open gap of its own pending package passes, case and spacing aside', () => {
    expect(run([file('/** @pending vault: No  EVENT route yet */\nexport const a = 1;')])).toEqual([]);
  });

  test('@pending whose gap is in no pendingReasons line is a finding', () => {
    expect(run([file('/** @pending vault: someday maybe */')])).toEqual([
      '@pending gap "someday maybe" is in none of pendingReasons.vault in ports-pending.json',
    ]);
  });

  test('@pending left in a package that has left ports-pending is a finding', () => {
    expect(
      run([file('/** @pending board: no event route yet */', 'board', 'packages/plugins/board/app/x.ts')]),
    ).toEqual(['board has left ports-pending.json; wire or delete what this @pending kept']);
  });

  test('@pending naming another owner, an unowned package, or no gap is a finding', () => {
    expect(run([file('/** @pending access: no event route yet */')])).toEqual([
      '@pending names "access", but this file belongs to "vault"',
    ]);
    expect(run([{ ...file('/** @pending vault: no event route yet */'), owner: undefined }])).toEqual([
      '@pending in a package that is no subsystem; only a pending port may keep code this way',
    ]);
    expect(run([file('/** @pending */')])).toEqual(['@pending must read "@pending <owner>: <the gap it waits for>"']);
  });

  test('@public needs a kept row id or a surface written in the manifest', () => {
    expect(run([file('/** @public S68 enforcer */\n/** @public surface secrets-tab */')])).toEqual([]);
    expect(run([file('/** @public */')])).toEqual([
      '@public needs a reason: a kept guarantee row id, or "surface <name>" from the manifest',
    ]);
    expect(run([file('/** @public kept for later */')])).toEqual([
      '@public needs a reason: a kept guarantee row id, or "surface <name>" from the manifest',
    ]);
    expect(run([file('/** @public S9999 */')])).toEqual([
      '@public names S9999, none of them a kept row of docs/rebuild/guarantees.tsv',
    ]);
    expect(run([file('/** @public surface secrets */')])).toEqual([
      '@public surface "secrets" is not written in this package\'s manifest',
    ]);
  });

  test('a knip ignore in a pending package must be named by a gap line; in a ported one it is a finding', () => {
    const ignore = (owner: string, paths: string[]): KnipIgnore => ({
      config: 'knip.json',
      workspace: `packages/plugins/${owner}`,
      owner,
      paths,
    });
    expect(run([], [ignore('vault', ['app/export-sheet.tsx'])])).toEqual([]);
    expect(run([], [ignore('vault', ['app/other.tsx'])])).toEqual([
      '"app/other.tsx" is ignored, but no pendingReasons.vault line in ports-pending.json names it',
    ]);
    expect(run([], [ignore('board', ['app/x.tsx'])])).toEqual([
      '"app/x.tsx" is ignored, but board has left ports-pending.json; wire or delete it',
    ]);
    expect(
      run([], [{ config: 'knip.json', workspace: 'packages/cli', owner: undefined, paths: ['src/x.ts'] }]),
    ).toEqual([]);
  });
});
