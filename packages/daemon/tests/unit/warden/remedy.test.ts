import { describe, it } from 'bun:test';
import { DEFAULT_WARDEN_CONFIG } from '@ferretry/protocol';
import should from 'should';
import { mayActAlone, verdictAct, wardenActDetail, wardenNudgeMessage } from '../../../src/lib/warden/index.ts';

describe('the act a verdict asks for', () => {
  it('should ask for nothing without an explicit verdict marker', () => {
    // Act / Assert
    should(verdictAct(undefined, { action: 'stop', reason: 'looping' })).be.undefined();
  });

  it.each([
    ['nudged', 'nudge'],
    ['revived', 'resume'],
    ['killed', 'stop'],
  ] as const)('should turn %s into %s, in the report’s own words', (verdict, action) => {
    // Act
    const actual = verdictAct(verdict, { action: 'nudge', reason: 'it is wedged' });

    // Assert
    should(actual).deepEqual({ action, reason: 'it is wedged' });
  });

  it.each(['cleared', 'needs_human', 'unknown'] as const)('should ask for no act on %s', verdict => {
    // Act / Assert
    should(verdictAct(verdict, undefined)).be.undefined();
  });

  it('should fall back to a plain reason when the report gave none', () => {
    // Act
    const actual = verdictAct('killed', { action: 'stop', reason: '  ' });

    // Assert
    should(actual).deepEqual({ action: 'stop', reason: 'it is burning time with no progress' });
  });

  it('should fail over only when the recommendation names the account', () => {
    // Act
    const named = verdictAct('nudged', { action: 'migrate', reason: 'quota is out', agent: 'claude-work' });
    const unnamed = verdictAct('revived', { action: 'migrate', reason: 'quota is out' });
    const cleared = verdictAct('cleared', { action: 'migrate', reason: 'quota is out', agent: 'claude-work' });
    const noReason = verdictAct('nudged', { action: 'migrate', reason: '', agent: 'claude-work' });

    // Assert
    should(named).deepEqual({ action: 'failover', agent: 'claude-work', reason: 'quota is out' });
    should(unnamed).deepEqual({ action: 'resume', reason: 'quota is out' });
    should(cleared).be.undefined();
    should(noReason).deepEqual({ action: 'failover', agent: 'claude-work', reason: 'its login is out of quota' });
  });
});

describe('what the Warden may do alone', () => {
  it('should never stop by default, and nudge, resume and fail over by default', () => {
    // Act / Assert
    should(mayActAlone({ action: 'stop', reason: 'r' }, DEFAULT_WARDEN_CONFIG.mayActAlone)).be.false();
    should(mayActAlone({ action: 'nudge', reason: 'r' }, DEFAULT_WARDEN_CONFIG.mayActAlone)).be.true();
    should(
      mayActAlone(
        { action: 'failover', reason: 'r', agent: 'a' },
        { ...DEFAULT_WARDEN_CONFIG.mayActAlone, failover: false },
      ),
    ).be.false();
  });
});

describe('what the Warden says', () => {
  it('should nudge in the investigation’s words', () => {
    // Act
    const actual = wardenNudgeMessage('it has not posted for 20 minutes.');

    // Assert
    should(actual).equal(
      'The Warden checked on you: it has not posted for 20 minutes. If you are blocked, say exactly what you need; otherwise carry on and post a short status.',
    );
  });

  it.each([
    [{ action: 'nudge', reason: 'quiet.' }, 'done', undefined, 'Nudged: quiet.'],
    [
      { action: 'resume', reason: 'pane died' },
      'held',
      undefined,
      'The Warden recommends resuming it: pane died. It waits for you.',
    ],
    [
      { action: 'stop', reason: 'looping' },
      'held',
      undefined,
      'The Warden recommends stopping it: looping. It waits for you.',
    ],
    [
      { action: 'failover', reason: 'quota out', agent: 'claude-work' },
      'done',
      undefined,
      'Moved to another login (claude-work): quota out.',
    ],
    [
      { action: 'nudge', reason: 'quiet' },
      'held',
      undefined,
      'The Warden recommends a nudge: quiet. It waits for you.',
    ],
    [
      { action: 'failover', reason: 'q', agent: 'b' },
      'held',
      undefined,
      'The Warden recommends moving it to another login (b): q. It waits for you.',
    ],
    [{ action: 'stop', reason: 'looping' }, 'failed', 'already stopped', 'Stopped did not take: already stopped.'],
    [{ action: 'resume', reason: 'x' }, 'failed', undefined, 'Resumed did not take: the daemon refused it.'],
  ] as const)('should describe %j %s as one sentence', (act, outcome, error, expected) => {
    // Act / Assert
    should(wardenActDetail(act, outcome, error)).equal(expected);
  });
});
