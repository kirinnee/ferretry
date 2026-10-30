import { describe, it } from 'bun:test';
import should from 'should';
import { restartNotice } from '../../src/lib/migrate/restart-notice.ts';
import { bootNotice } from '../../src/lib/session/auto-resume/policy.ts';
import { resumeTurnAuthor } from '../../src/lib/session/resume/policy.ts';
import { sendFailureNotice } from '../../src/lib/session/send/tracking.ts';
import type { SendRecord } from '../../src/lib/session/send/types.ts';
import { reviveMessage } from '../../src/lib/warden/revive.ts';

/**
 * THE OWNER'S RULE (2026-10-30): "there should not be any append or prepend on any feature". No text Ferretry
 * types into a session on its own account opens with a tag or carries a footer: who it is from is metadata.
 */

const record = (overrides: Partial<SendRecord>): SendRecord => ({
  sendId: 'send-1',
  acceptedAt: '2026-10-30T19:00:00.000Z',
  acceptedTurn: 2,
  path: 'native-inline',
  message: 'hi',
  fate: 'timed_out',
  ...overrides,
});

const report = {
  status: 'tool_running',
  openTools: [],
  processes: [],
  codexBackgroundTerminals: 0,
  blindSpots: [],
} as unknown as Parameters<typeof restartNotice>[0];

describe('no tag and no footer on anything Ferretry types', () => {
  it('should open every notice with words, never a bracketed tag, and never say whose it is not', () => {
    const notices = [
      restartNotice(report, '/state/inflight.json', 'auto'),
      restartNotice({ ...report, status: 'waiting' } as typeof report, '/state/inflight.json', 'auto'),
      bootNotice('tool_running', 'auto'),
      bootNotice('awaiting_user', 'auto'),
      sendFailureNotice('hadi', record({}), 'fy'),
      sendFailureNotice('hadi', record({ fate: 'unaccounted', unaccountedReason: 'transcript_unbound' }), 'fy'),
      sendFailureNotice('hadi', record({ fate: 'unaccounted', unaccountedReason: 'revive_unconfirmed' }), 'fy'),
      reviveMessage({ kind: 'tmux_crashed' }, '2026-10-30T19:00:00.000Z', 'auto'),
      reviveMessage({ kind: 'tmux_crashed' }, '2026-10-30T19:00:00.000Z', 'interactive'),
    ];

    for (const notice of notices) {
      should(notice).be.a.String();
      should(notice).not.match(/^\s*\[/u);
      should(notice).not.containEql('not from the owner');
      should(notice).not.containEql('No reply needed');
      should(notice).match(/^Ferretry/u);
    }
  });
});

describe('who a relaunch turn is from', () => {
  it('should be Ferretry for the Warden and the daemon, the owner for an operator, a ferret for a peer', () => {
    should(resumeTurnAuthor('warden')).deepEqual({ kind: 'ferretry', feature: 'Warden' });
    should(resumeTurnAuthor('daemon')).deepEqual({ kind: 'ferretry', feature: 'Restart' });
    should(resumeTurnAuthor('admin-cli')).deepEqual({ kind: 'owner' });
    should(resumeTurnAuthor('admin-ui')).deepEqual({ kind: 'owner' });
    should(resumeTurnAuthor('peer')).deepEqual({ kind: 'ferret' });
    should(resumeTurnAuthor('unknown')).be.undefined();
  });
});
