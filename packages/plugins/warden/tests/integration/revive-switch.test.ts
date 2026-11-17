import { describe, it } from 'bun:test';
import should from 'should';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { fakeRuntimes } from '@ferretry/plugin-runtimes/contract/testing';
import { instantFromEpochMs } from '@ferretry/std';
import type { RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import { createWardenSubsystem } from '../../daemon/subsystem.ts';
import { fakeKernel, wardenConfig } from '../support/kernel.ts';

/**
 * The Warden's automatic revive, through the real subsystem, against the machine's "Auto-resume after restart" switch
 * (Runtimes' to answer; no per-ferret switch exists). The clock is the kernel fake's: nothing here waits.
 */
async function sweepWith(runtimes: (() => RuntimesApi | undefined) | undefined): Promise<FakeFerrets> {
  const fake = fakeKernel({ config: wardenConfig(), start: '2026-11-07T12:00:00.000Z' });
  const ferrets = new FakeFerrets();
  // A ferret whose terminal vanished a minute ago: exactly what the auto-revive brings back.
  ferrets.add({
    id: ferretId('dead'),
    mode: 'auto',
    state: 'stopped',
    stateAt: instantFromEpochMs(Date.parse('2026-11-07T11:59:00.000Z')),
    cause: { kind: 'terminal_gone' },
  });
  const subsystem = createWardenSubsystem({
    kernel: fake.kernel,
    ferrets,
    conversation: fakeConversation(),
    asks: new FakeAsks(),
    usage: () => undefined,
    board: () => undefined,
    ...(runtimes === undefined ? {} : { runtimes }),
  });
  await subsystem.run(false);
  return ferrets;
}

describe('the Warden’s automatic revive and the machine auto-resume switch', () => {
  it('should revive a dead ferret while Runtimes says auto-resume is on', async () => {
    // Arrange
    const runtimes = fakeRuntimes();
    runtimes.setAutoResume(true);

    // Act
    const ferrets = await sweepWith(() => runtimes);

    // Assert
    should(ferrets.resumes.map(entry => entry.ferret)).deepEqual([ferretId('dead')]);
  });

  it('should revive nothing while Runtimes says auto-resume is off', async () => {
    // Arrange
    const runtimes = fakeRuntimes();
    runtimes.setAutoResume(false);

    // Act
    const ferrets = await sweepWith(() => runtimes);

    // Assert
    should(ferrets.resumes).deepEqual([]);
  });

  it('should revive nothing when Runtimes cannot read the switch, or is not running (fail closed)', async () => {
    // Arrange
    const unreadable = fakeRuntimes();
    unreadable.setAutoResume(undefined);

    // Act
    const unread = await sweepWith(() => unreadable);
    const absent = await sweepWith(undefined);
    const throwing = await sweepWith(() => ({
      ...fakeRuntimes(),
      autoResume: async () => {
        throw new Error('the file is unreadable');
      },
    }));

    // Assert
    should(unread.resumes).deepEqual([]);
    should(absent.resumes).deepEqual([]);
    should(throwing.resumes).deepEqual([]);
  });
});
