import { describe, it } from 'bun:test';
import type { ConfigFileDef, ConfigPort, ConfigWriteOutcome } from '@ferretry/kernel/contract';
import should from 'should';
import type { AccountsConfig } from '../../../contract/index.ts';
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
