/**
 * Accounts' three seams to its neighbours: Gate's audit, Access's passkeys and proofs, and the kernel's one config
 * writer for `accounts.yaml`. The config writer is the kernel's real one over an in-memory file system; the audit
 * and Access ends are the neighbours' contracts, answered by the test.
 */
import { describe, it } from 'bun:test';
import type { AccessApi } from '@ferretry/plugin-access/contract';
import type { GateApi } from '@ferretry/core-gate/contract';
import type { Log } from '@ferretry/kernel/contract';
import { config, state } from '@ferretry/kernel/host';
import { fixedClock } from '@ferretry/kernel/testing';
import type { UsesHandle } from '@ferretry/kernel/manifest';
import should from 'should';
import type { StoredStepUpProof } from '../../../contract/routes/index.ts';
import { accountSecurity } from '../../../daemon/adapters/access-security.ts';
import { gateAuditSink } from '../../../daemon/adapters/gate-audit.ts';
import {
  AccountDefaultsNotWritten,
  KernelAccountDefaultsWriter,
} from '../../../daemon/adapters/kernel-defaults-writer.ts';
import { AccountDefaultsFileBroken } from '../../../daemon/lib/account-defaults.ts';
import manifest from '../../../manifest.ts';

const quiet: Log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
} as unknown as Log;

describe('gateAuditSink', () => {
  it('should hand every record to Gate, the event named as Gate names its kinds', async () => {
    // Arrange
    const kept: unknown[] = [];
    const sink = gateAuditSink({
      audit: async (entry: unknown) => void kept.push(entry),
    } as unknown as Pick<GateApi, 'audit'>);

    // Act
    await sink.record({
      event: 'account.created' as never,
      actor: 'owner' as never,
      outcome: 'ok' as never,
      subject: 'GITHUB',
    });

    // Assert
    should(kept).have.length(1);
    should((kept[0] as { subject: string }).subject).equal('GITHUB');
    should((kept[0] as { event: string }).event).equal('account.created');
  });
});

const handleOf = (api: Partial<AccessApi> | undefined): UsesHandle<AccessApi> => ({
  current: () => api as AccessApi | undefined,
});

describe('accountSecurity', () => {
  it('should never pass anything when Access is off', async () => {
    // Arrange
    const security = accountSecurity(handleOf(undefined));

    // Act / Assert
    should(await security.passkeys.of('d1')).equal(false);
    should(await security.passkeys.any()).equal(false);
    should(await security.proofs.holds('d1', 'c1')).equal(false);
    should(await security.proofs.verify({} as StoredStepUpProof, new Uint8Array())).equal(false);
  });

  it('should never pass anything when an Access answer fails', async () => {
    // Arrange
    const failing = async (): Promise<never> => {
      throw new Error('access is unreadable');
    };
    const security = accountSecurity(
      handleOf({ holdsPasskey: failing, devices: failing, holds: failing, verifyStoredProof: failing }),
    );

    // Act / Assert
    should(await security.passkeys.of('d1')).equal(false);
    should(await security.passkeys.any()).equal(false);
    should(await security.proofs.holds('d1', 'c1')).equal(false);
    should(await security.proofs.verify({} as StoredStepUpProof, new Uint8Array())).equal(false);
  });

  it('should pass what Access passes: a device with a passkey, a credential it holds, a proof it verifies', async () => {
    // Arrange
    const security = accountSecurity(
      handleOf({
        holdsPasskey: async (device: string) => device === 'd2',
        devices: async () => [{ id: 'd1' }, { id: 'd2' }] as never,
        holds: async (device: string, credential: string) => device === 'd2' && credential === 'c2',
        verifyStoredProof: async () => true,
      }),
    );

    // Act / Assert
    should(await security.passkeys.of('d2')).equal(true);
    should(await security.passkeys.of('d1')).equal(false);
    should(await security.passkeys.any()).equal(true);
    should(await security.proofs.holds('d2', 'c2')).equal(true);
    should(await security.proofs.holds('d1', 'c2')).equal(false);
    should(await security.proofs.verify({} as StoredStepUpProof, new Uint8Array())).equal(true);
  });

  it('should say no passkey is held anywhere when no device holds one', async () => {
    // Arrange
    const security = accountSecurity(
      handleOf({ holdsPasskey: async () => false, devices: async () => [{ id: 'd1' }] as never }),
    );

    // Act / Assert
    should(await security.passkeys.any()).equal(false);
  });
});

const HOME = '/home/fy';
const DEFINITION = manifest.data.config[0];
if (DEFINITION === undefined) throw new Error('accounts declares no config file');

/** The kernel's real config writer over an in-memory disk; `judge` says whether Gate lets a loosening into effect. */
async function defaults(options: { readonly judge: boolean; readonly text?: string }) {
  const fs = state.createMemoryHostFs();
  if (options.text !== undefined) fs.seed(`${HOME}/config/accounts.yaml`, options.text);
  // Flipped by a test that needs a ferret's edit held first and the owner's own act confirmed after.
  const verdict = { allow: options.judge };
  const files = config.createConfigFiles({
    home: HOME,
    fs,
    clock: fixedClock('2026-11-09T09:00:00.000Z'),
    log: quiet,
    binary: 'fy',
    defs: [{ plugin: 'accounts', def: DEFINITION }],
    judge: () => verdict.allow,
  });
  await files.reload();
  const port = files.port('accounts');
  return { port, files, fs, verdict, writer: new KernelAccountDefaultsWriter(port, DEFINITION as never) };
}

describe('KernelAccountDefaultsWriter', () => {
  it('should put a changed default into effect when Gate lets it, keeping the rest of the file', async () => {
    // Arrange
    const { port, writer } = await defaults({ judge: true });

    // Act
    await writer.amend(file => ({ ...file, sites: { 'github.com': 'WORK' } }), 'refuse');

    // Assert
    should((port.file(DEFINITION as never) as { sites?: unknown }).sites).deepEqual({ 'github.com': 'WORK' });
  });

  it('held-edit patch should put the owner’s one line into effect and leave a ferret’s held line held, then confirm both', async () => {
    // Arrange — a ferret suggests a line for github.com: held, nothing in effect.
    const { port, files, fs, verdict, writer } = await defaults({ judge: false });
    const ferret = await port.write(DEFINITION as never, undefined, 'sites:\n  github.com: GITHUB\n');
    should(ferret.kind).equal('held');
    verdict.allow = true;

    // Act — the owner sets a different line.
    await writer.amend(file => ({ ...file, sites: { ...file.sites, 'app.clickup.com': 'CLICKUP_A' } }), 'refuse');

    // Assert — the owner's line is in effect; the ferret's is neither in effect nor discarded.
    should((port.file(DEFINITION as never) as { sites?: unknown }).sites).deepEqual({ 'app.clickup.com': 'CLICKUP_A' });
    should(port.fileState(DEFINITION as never).state).equal('held');
    const onDisk = String(fs.snapshot().get(`${HOME}/config/accounts.yaml`));
    should(onDisk).containEql('github.com: GITHUB');
    should(onDisk).containEql('app.clickup.com: CLICKUP_A');

    // Act — the owner confirms the ferret's line.
    const [held] = files.held();
    should(await files.confirm(held?.id as string)).equal(true);

    // Assert — both lines are in effect.
    should((port.file(DEFINITION as never) as { sites?: unknown }).sites).deepEqual({
      'github.com': 'GITHUB',
      'app.clickup.com': 'CLICKUP_A',
    });
  });

  it('held-edit patch should take the owner’s removed line out of both versions and keep the ferret’s other line held', async () => {
    // Arrange — one line in effect, then a ferret adds another: held.
    const { port, verdict, writer } = await defaults({ judge: true });
    await writer.amend(file => ({ ...file, sites: { 'github.com': 'GITHUB' } }), 'refuse');
    verdict.allow = false;
    const ferret = await port.write(
      DEFINITION as never,
      undefined,
      'sites:\n  github.com: GITHUB\n  app.clickup.com: CLICKUP_B\n',
    );
    should(ferret.kind).equal('held');
    verdict.allow = true;

    // Act — the owner removes github.com.
    await writer.amend(() => ({}), 'refuse');

    // Assert — nothing in effect, and the ferret's other line is still waiting.
    should((port.file(DEFINITION as never) as { sites?: unknown }).sites ?? {}).deepEqual({});
    should(port.fileState(DEFINITION as never).state).equal('held');
  });

  it('should say a default waits for the owner when Gate holds it', async () => {
    // Arrange
    const { writer } = await defaults({ judge: false });

    // Act
    const actual = await writer
      .amend(file => ({ ...file, sites: { 'github.com': 'WORK' } }), 'refuse')
      .catch((error: unknown) => error);

    // Assert
    should(actual).be.instanceOf(AccountDefaultsNotWritten);
    should((actual as AccountDefaultsNotWritten).outcome).equal('held');
    should((actual as Error).message).match(/waits for the owner/);
  });

  it('should refuse an amendment of a file that does not check, naming its sentences, and say nothing for `record`', async () => {
    // Arrange
    const { writer } = await defaults({ judge: true, text: 'sites: [this is not a mapping\n' });

    // Act
    const refused = await writer.amend(file => file, 'refuse').catch((error: unknown) => error);
    const recorded = await writer.amend(file => file, 'record').catch((error: unknown) => error);

    // Assert
    should(refused).be.instanceOf(AccountDefaultsFileBroken);
    should((refused as AccountDefaultsFileBroken).issues.length).be.greaterThan(0);
    should(recorded).be.instanceOf(AccountDefaultsFileBroken);
    should((recorded as AccountDefaultsFileBroken).issues).deepEqual([]);
  });

  it('should refuse an amendment the schema refuses, with the kernel’s words as the issues', async () => {
    // Arrange
    const { writer } = await defaults({ judge: true });

    // Act
    const actual = await writer
      .amend(() => ({ sites: { 'github.com': 12 } }) as never, 'refuse')
      .catch((error: unknown) => error);

    // Assert
    should(actual).be.instanceOf(AccountDefaultsFileBroken);
    should((actual as AccountDefaultsFileBroken).issues.length).be.greaterThan(0);
  });

  it('should ask for a retry when the file changed while it was written', async () => {
    // Arrange — the kernel’s writer, except that the file moves under this one write.
    const { port } = await defaults({ judge: true });
    const racing = new KernelAccountDefaultsWriter(
      {
        file: def => port.file(def),
        fileState: def => port.fileState(def),
        writeAsOwner: async () => ({ kind: 'conflict' }) as never,
      },
      DEFINITION as never,
    );

    // Act
    const actual = await racing.amend(file => file, 'refuse').catch((error: unknown) => error);

    // Assert
    should(actual).be.instanceOf(AccountDefaultsNotWritten);
    should((actual as AccountDefaultsNotWritten).outcome).equal('conflict');
  });
});
