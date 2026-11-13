import { describe, it } from 'bun:test';
import type { ConfigFileDef, ConfigPort, ConfigWriteOutcome } from '@ferretry/kernel/contract';
import should from 'should';
import type { AccountsConfig } from '../../../contract/index.ts';
import type { AccountDefaultsFile } from '../../../contract/routes/index.ts';
import { KernelAccountDefaultsWriter } from '../../../daemon/adapters/kernel-defaults-writer.ts';
import { AccountDefaultsFileBroken } from '../../../daemon/lib/account-defaults.ts';

/**
 * BG-012 m-3: when the kernel refuses to write `accounts.yaml` it says why (a link, a file that is not UTF-8), and the
 * owner is told that sentence, not "does not check", which is the wrong diagnosis for those.
 */
const UNREADABLE =
  'accounts.yaml cannot be read (a link, not a regular file, or larger than a config file may be), so nothing was written over it';
const FIX = 'replace the file with an ordinary one, then make the change again';

function writerOver(outcome: ConfigWriteOutcome) {
  const config = {
    file: () => undefined,
    fileState: () => ({ state: 'valid', inEffect: true }),
    writeAsOwner: async () => outcome,
  } as unknown as Pick<ConfigPort, 'file' | 'fileState' | 'writeAsOwner'>;
  return new KernelAccountDefaultsWriter(config, {} as ConfigFileDef<AccountsConfig>);
}

/** A port noting every write-shaped call, answering `written`; `held` makes `accounts.yaml` hold an edit. */
function portNoting(held: boolean, file: AccountDefaultsFile) {
  const calls: { readonly call: 'write' | 'writeAsOwner'; readonly edit: unknown }[] = [];
  const written: ConfigWriteOutcome = { kind: 'written', etag: 'e', loosened: [] };
  const port = {
    file: () => file,
    fileState: () => ({ state: held ? 'held' : 'valid', inEffect: true }),
    write: async (_def: unknown, _name: unknown, edit: unknown) => (calls.push({ call: 'write', edit }), written),
    writeAsOwner: async (_def: unknown, _name: unknown, edit: unknown) => (
      calls.push({ call: 'writeAsOwner', edit }), written
    ),
  } as unknown as Pick<ConfigPort, 'file' | 'fileState' | 'writeAsOwner'>;
  return { writer: new KernelAccountDefaultsWriter(port, {} as ConfigFileDef<AccountsConfig>), calls };
}

const BEFORE: AccountDefaultsFile = {
  sites: { 'a.example': 'one', 'b.example': 'two' },
  projects: { p: { k: 'one' } },
};

describe('the accounts defaults writer beside a held edit (row 62)', () => {
  it('M15 should send only the lines the owner changed, each section merged, while accounts.yaml holds an edit', async () => {
    const { writer, calls } = portNoting(true, BEFORE);

    // 'a.example' is set to a new account and 'b.example' is removed
    await writer.amend(file => ({ ...file, sites: { 'a.example': 'three' } }), 'refuse');

    should(calls).deepEqual([
      {
        call: 'writeAsOwner',
        edit: { patch: { sites: { 'a.example': 'three', 'b.example': undefined } }, within: ['sites'] },
      },
    ]);
  });

  it('should send the whole sections through writeAsOwner when nothing is held', async () => {
    const { writer, calls } = portNoting(false, BEFORE);

    await writer.amend(file => ({ ...file, sites: { ...file.sites, 'a.example': 'three' } }), 'refuse');

    should(calls).deepEqual([
      {
        call: 'writeAsOwner',
        edit: {
          patch: {
            sites: { 'a.example': 'three', 'b.example': 'two' },
            projects: { p: { k: 'one' } },
            folders: undefined,
          },
        },
      },
    ]);
  });

  it('M14 should never use a plain write, held or not', async () => {
    for (const held of [true, false]) {
      const { writer, calls } = portNoting(held, BEFORE);

      await writer.amend(file => ({ ...file, sites: { ...file.sites, 'a.example': 'three' } }), 'refuse');

      should(calls.map(entry => entry.call)).deepEqual(['writeAsOwner']);
    }
  });
});

const broken = async (work: Promise<unknown>) =>
  (await work.then(
    () => undefined,
    (error: unknown) => error,
  )) as AccountDefaultsFileBroken;

describe('the accounts defaults writer says why the kernel refused a write', () => {
  it('should carry the kernel’s sentence and its fix, not “does not check”', async () => {
    const writer = writerOver({
      kind: 'refused',
      reason: 'yaml',
      issues: [{ path: 'accounts.yaml', message: UNREADABLE, fix: FIX }],
    });

    const error = await broken(writer.amend(file => file, 'refuse'));

    should(error).be.instanceOf(AccountDefaultsFileBroken);
    should(error.message).equal(`${UNREADABLE}: ${FIX}`);
    should(error.message).not.containEql('does not check');
    should(error.issues.map(issue => issue.message)).deepEqual([UNREADABLE]);
  });

  it('BG-012 m-3 should not end the sentence in a bare colon when the kernel’s fix is the empty string', async () => {
    const writer = writerOver({
      kind: 'refused',
      reason: 'yaml',
      issues: [{ path: 'accounts.yaml', message: UNREADABLE, fix: '' }],
    });

    const error = await broken(writer.amend(file => file, 'refuse'));

    should(error.message).equal(UNREADABLE);
  });

  it('should keep the fixed sentence when the kernel gave no issue to say', async () => {
    const writer = writerOver({ kind: 'refused', reason: 'schema', issues: [] });

    const error = await broken(writer.amend(file => file, 'refuse'));

    should(error.message).equal('accounts.yaml does not check, so it was not changed; fix it first');
  });
});
