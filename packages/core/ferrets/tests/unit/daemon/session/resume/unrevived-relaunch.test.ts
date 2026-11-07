import { describe, it } from 'bun:test';
import should from 'should';
import {
  RESTAMPED_RECORD_KEYS,
  restoreRestamped,
  settleRejectedRelaunch,
  settleUnrevivedRelaunch,
} from '../../../../src/lib/session/resume/index.ts';

const settle = async (
  disposition: Parameters<typeof settleUnrevivedRelaunch>[0]['disposition'],
  paneBefore: string | undefined,
  paneNow: string | undefined,
) => {
  let rolledBack = 0;
  const detail = await settleUnrevivedRelaunch({
    disposition,
    from: 'claude-a',
    to: 'claude-b',
    paneBefore,
    paneNow,
    rollBack: async () => {
      rolledBack += 1;
    },
  });
  return { detail, rolledBack };
};

describe('settling a migration whose relaunch did not come up', () => {
  it('should put the record back only when the registered pane is the one that served before', async () => {
    const { detail, rolledBack } = await settle('preserved', '%1:10:100', '%1:10:100');
    should(rolledBack).equal(1);
    should(detail).equal(
      'the relaunch failed before a new harness was registered, so claude-a is still serving ' +
        'this session and its record names claude-a again',
    );
  });

  it('should keep the record when the surviving pane is the target the relaunch started', async () => {
    const { detail, rolledBack } = await settle('preserved', '%1:10:100', '%1:11:200');
    should(rolledBack).equal(0);
    should(detail).equal(
      'the new harness on claude-b started but the hand-over message was not delivered; ' +
        'the session is serving claude-b and its record names it',
    );
  });

  it('should keep the record and say so when the pane identity cannot be proven', async () => {
    for (const [before, now] of [
      [undefined, '%1:10:100'],
      ['%1:10:100', undefined],
      [undefined, undefined],
    ] as const) {
      const { detail, rolledBack } = await settle('preserved', before, now);
      should(rolledBack).equal(0);
      should(detail).containEql('could not be proven');
    }
  });

  it('should leave the record for the retry that is already scheduled', async () => {
    const retry = await settle('retry-scheduled', '%1:10:100', '%1:10:100');
    const sent = await settle('sent', '%1:10:100', '%1:10:100');
    should(retry.rolledBack + sent.rolledBack).equal(0);
    should(retry.detail).equal(
      'the relaunch failed and an automatic retry was scheduled; the session is still on claude-a',
    );
    should(sent.detail).equal(retry.detail);
  });
});

describe('restoring the fields a migration restamped', () => {
  it('should put back the restamped fields and keep every write made since', () => {
    const before = { agent: 'claude-a', model: 'm1', name: 'old', sessionCapabilityHash: 'h1', launchFast: true };
    const current = {
      agent: 'claude-b',
      model: 'm2',
      name: 'renamed',
      sessionCapabilityHash: 'h2',
      migration: { from: 'claude-a' },
    };
    should(restoreRestamped(before, current)).eql({
      agent: 'claude-a',
      model: 'm1',
      name: 'renamed',
      sessionCapabilityHash: 'h2',
      launchFast: true,
    });
  });

  it('should only ever touch the keys the migration restamps', () => {
    should(RESTAMPED_RECORD_KEYS).containEql('agent').and.not.containEql('sessionCapabilityHash');
    should(RESTAMPED_RECORD_KEYS).not.containEql('name');
  });
});

describe('settling a migration whose resume was refused or threw', () => {
  const run = async (paneBefore: string | undefined, paneNow: string | undefined) => {
    let rolledBack = 0;
    const note = await settleRejectedRelaunch({
      from: 'claude-a',
      paneBefore,
      paneNow,
      rollBack: async () => {
        rolledBack += 1;
      },
    });
    return { note, rolledBack };
  };

  it('should put the record back when the same pane is still registered', async () => {
    const { note, rolledBack } = await run('%1:10:100', '%1:10:100');
    should(rolledBack).equal(1);
    should(note).equal('; the previous harness is still serving, so the record names claude-a again');
  });

  it('should leave the record when the pane changed or cannot be identified', async () => {
    for (const [before, now] of [
      ['%1:10:100', '%1:11:200'],
      [undefined, undefined],
      ['%1:10:100', undefined],
    ] as const) {
      const { note, rolledBack } = await run(before, now);
      should(rolledBack).equal(0);
      should(note).equal('');
    }
  });
});
