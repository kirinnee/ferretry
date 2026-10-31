import { describe, it } from 'bun:test';
import type { HarnessDialog } from '@ferretry/protocol';
import should from 'should';
import {
  limitedQuota,
  limitPatch,
  parseContinueAt,
  transcriptUsageLimit,
  usageLimitOf,
} from '../../../../src/lib/session/turn/usage-limit.ts';
import type { TranscriptEvent } from '../../../../src/lib/transcript/types.ts';

/** A session parked on "You've hit your … limit" is a spent login — and nothing here ever picks an option. */

const NOW = new Date(2026, 9, 30, 6, 0).getTime();
const CODEX_NOTICE = 'Your workspace is out of credits. Add credits to continue.';
const CODEX_LIMIT = { notice: CODEX_NOTICE, spend: false };
const meta = { harness: 'codex', role: 'system' } as const;
const started = { ...meta, kind: 'turn', state: 'started' } as TranscriptEvent;
const completed = { ...meta, kind: 'turn', state: 'completed' } as TranscriptEvent;
const usageLimitError = {
  ...meta,
  kind: 'error',
  error: { message: CODEX_NOTICE, code: 'usage_limit_exceeded', recoverable: true },
} as TranscriptEvent;
const usage = { ...meta, kind: 'usage', usage: {} } as TranscriptEvent;
const reply = { harness: 'codex', role: 'assistant', kind: 'message', content: [] } as unknown as TranscriptEvent;
const NOTICE = "You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit";

const dialog = (over: Partial<HarnessDialog> = {}): HarnessDialog => ({
  id: '0123456789abcdef',
  harness: 'claude',
  selected: 1,
  kind: 'usage-limit',
  title: 'What do you want to do?',
  body: NOTICE,
  options: [
    { number: 1, label: 'Stop and wait for limit to reset', grantsTrust: false },
    { number: 2, label: 'Wait here, then continue automatically at Nov 1, 12am', grantsTrust: false },
    { number: 3, label: 'Ask your admin for more usage', grantsTrust: false },
  ],
  ...over,
});

describe('parseContinueAt', () => {
  it('should read the harness local-time label, midnight and noon included', () => {
    // Act / Assert
    should(parseContinueAt('continue automatically at Nov 1, 12am', NOW)).equal(new Date(2026, 10, 1, 0, 0).getTime());
    should(parseContinueAt('continue automatically at Nov 1, 12pm', NOW)).equal(new Date(2026, 10, 1, 12, 0).getTime());
    should(parseContinueAt('continue automatically at Nov 2, 3:30pm', NOW)).equal(
      new Date(2026, 10, 2, 15, 30).getTime(),
    );
  });

  it('should roll to next year when the date has passed, and tolerate any other text', () => {
    // Act / Assert
    should(parseContinueAt('continue automatically at Jan 5, 9am', NOW)).equal(new Date(2027, 0, 5, 9, 0).getTime());
    should(parseContinueAt('Stop and wait for limit to reset', NOW)).be.undefined();
    should(parseContinueAt('continue automatically at Nov 40, 12am', NOW)).be.undefined();
    should(parseContinueAt('continue automatically at Xyz 1, 12am', NOW)).be.undefined();
    should(parseContinueAt('continue automatically at Nov 1, 13am', NOW)).be.undefined();
    should(parseContinueAt('continue automatically at Feb 31, 9am', NOW)).be.undefined();
  });
});

describe('usageLimitOf', () => {
  it('should carry the notice, the spend flag and the reset time', () => {
    // Act
    const limit = usageLimitOf(dialog(), NOW);

    // Assert
    should(limit).deepEqual({ notice: NOTICE, spend: true, retryAt: new Date(2026, 10, 1, 0, 0).getTime() });
  });

  it('should tolerate a missing time and a non-spend limit', () => {
    // Act
    const limit = usageLimitOf(
      dialog({ body: "You've hit your session limit", options: [{ number: 1, label: 'Stop', grantsTrust: false }] }),
      NOW,
    );

    // Assert
    should(limit).deepEqual({ notice: "You've hit your session limit", spend: false });
  });

  it('should read nothing from any other dialog', () => {
    should(usageLimitOf(dialog({ kind: 'other' }), NOW)).be.undefined();
    should(usageLimitOf(undefined, NOW)).be.undefined();
  });
});

describe('limitedQuota', () => {
  it('should mark a spend limit unavailable with its reason, keeping other quota fields', () => {
    // Act
    const quota = limitedQuota({ retryAt: 1 }, { notice: 'n', spend: true, retryAt: 99 });

    // Assert
    should(quota).deepEqual({
      atLimit: true,
      limitNotice: 'n',
      unavailable: true,
      unavailableReason: 'spend_limit',
      retryAt: 99,
      resetAt: 99,
    });
  });

  it('should only say at-limit for a usage window with no known reset', () => {
    should(limitedQuota(undefined, { notice: 'n', spend: false })).deepEqual({ atLimit: true, limitNotice: 'n' });
  });
});

describe('limitPatch', () => {
  it('should rate limit a running session parked on the dialog', () => {
    // Act
    const patch = limitPatch({ status: 'running' }, dialog(), NOW);

    // Assert
    should(patch?.status).equal('rate_limited');
    should(patch?.quota?.atLimit).be.true();
    should(patch?.quota?.retryAt).equal(new Date(2026, 10, 1, 0, 0).getTime());
  });

  it('should release only a session it limited itself, once the dialog is gone', () => {
    // Arrange
    const limited = { status: 'rate_limited' as const, quota: { atLimit: true }, harnessDialog: dialog() };

    // Act
    const released = limitPatch(limited, undefined, NOW);
    const foreign = limitPatch({ status: 'rate_limited', quota: { atLimit: true } }, undefined, NOW);

    // Assert
    should(released).deepEqual({ status: 'running', quota: undefined });
    should(foreign).be.undefined();
  });

  it('should change nothing for an ordinary running session', () => {
    should(limitPatch({ status: 'running' }, undefined, NOW)).be.undefined();
  });

  it('should rate limit a session whose turn the transcript proved ended on its limit', () => {
    // Act
    const patch = limitPatch({ status: 'running' }, undefined, NOW, { limit: CODEX_LIMIT, to: 'your-turn' });

    // Assert
    should(patch).deepEqual({ status: 'rate_limited', quota: { atLimit: true, limitNotice: CODEX_NOTICE } });
  });

  it('should read a turn seen working as proof the provider accepted it', () => {
    // Act
    const patch = limitPatch({ status: 'running' }, undefined, NOW, { limit: CODEX_LIMIT, to: 'working' });

    // Assert
    should(patch).be.undefined();
  });

  it('should release a transcript-limited session once no turn proves the limit', () => {
    // Arrange
    const limited = { status: 'rate_limited' as const, quota: { atLimit: true, limitNotice: CODEX_NOTICE } };

    // Act
    const released = limitPatch(limited, undefined, NOW, { limit: undefined, to: 'your-turn' });

    // Assert
    should(released).deepEqual({ status: 'running', quota: undefined });
  });

  it('should take away a notice a send left on a running session, keeping the rest of its quota', () => {
    // Arrange — a send moved the limited session to running and left its quota as it was.
    const sent = { status: 'running' as const, quota: { atLimit: true, limitNotice: CODEX_NOTICE, weeklyPercent: 80 } };

    // Act
    const patch = limitPatch(sent, undefined, NOW, { limit: undefined, to: 'working' });

    // Assert
    should(patch).deepEqual({ status: 'running', quota: { weeklyPercent: 80 } });
  });
});

describe('transcriptUsageLimit', () => {
  it('should read the limit the newest turn ended on', () => {
    // Act
    const limit = transcriptUsageLimit([started, completed, usageLimitError, usage]);

    // Assert
    should(limit).deepEqual(CODEX_LIMIT);
  });

  it('should read nothing once a later turn started or did any work', () => {
    // Act / Assert
    should(transcriptUsageLimit([completed, usageLimitError, started])).be.undefined();
    should(transcriptUsageLimit([completed, usageLimitError, reply])).be.undefined();
  });

  it('should read nothing from an older turn, a turn that ended cleanly or any other error', () => {
    // Act / Assert
    should(transcriptUsageLimit([completed, usageLimitError, started, reply, completed])).be.undefined();
    should(transcriptUsageLimit([started, completed])).be.undefined();
    const otherError = {
      ...meta,
      kind: 'error',
      error: { message: 'boom', code: 'x', recoverable: true },
    } as TranscriptEvent;
    should(transcriptUsageLimit([completed, otherError])).be.undefined();
    should(transcriptUsageLimit([usageLimitError])).be.undefined();
    should(transcriptUsageLimit([])).be.undefined();
  });
});
