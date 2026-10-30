import { describe, it } from 'bun:test';
import should from 'should';
import {
  limitedCredentials,
  type PaneLimitSession,
  paneLimitHolds,
  sessionPaneLimits,
} from '../../../src/lib/usage/pane-limit.ts';

const NOW = 1_000;
const limited = (
  agent: string,
  retryAt?: number,
  status: PaneLimitSession['status'] = 'rate_limited',
): PaneLimitSession => ({
  agent,
  status,
  quota: { unavailableReason: 'spend_limit', ...(retryAt === undefined ? {} : { retryAt }) },
  harnessDialog: { kind: 'usage-limit', title: 'What do you want to do?', body: "You've hit your org's spend limit" },
});

describe('sessionPaneLimits', () => {
  it('should prove a limit only from a rate_limited session on the usage-limit dialog', () => {
    // Arrange
    const sessions: PaneLimitSession[] = [
      limited('claude-liftoff', 5_000),
      limited('claude-other', 5_000, 'running'),
      { agent: 'claude-third', status: 'rate_limited', harnessDialog: { kind: 'other', title: 't' } },
    ];

    // Act
    const limits = sessionPaneLimits(sessions, NOW);

    // Assert
    should([...limits.keys()]).deepEqual(['claude-liftoff']);
    should(limits.get('claude-liftoff')).deepEqual({
      notice: "You've hit your org's spend limit",
      spend: true,
      retryAt: 5_000,
    });
  });

  it('should drop a limit whose reset has passed, and keep the latest reset of several sessions', () => {
    // Act
    const expired = sessionPaneLimits([limited('a', 500)], NOW);
    const latest = sessionPaneLimits([limited('a', 2_000), limited('a', 9_000), limited('a', 3_000)], NOW);
    const openEnded = sessionPaneLimits([limited('a', 2_000), limited('a')], NOW);

    // Assert
    should(expired.size).equal(0);
    should(latest.get('a')?.retryAt).equal(9_000);
    should(openEnded.get('a')?.retryAt).be.undefined();
  });
});

describe('limitedCredentials', () => {
  it('should spend every login a limited agent runs on, and no other', () => {
    // Arrange
    const limits = sessionPaneLimits([limited('claude-liftoff', 5_000)], NOW);

    // Act
    const byLogin = limitedCredentials(limits, [
      { agent: 'claude-liftoff', credential: 'liftoff-login' },
      { agent: 'claude-main', credential: 'main-login' },
    ]);

    // Assert
    should([...byLogin.keys()]).deepEqual(['liftoff-login']);
  });
});

describe('paneLimitHolds', () => {
  it('should hold until the reset, and without one for as long as it is asked', () => {
    should(paneLimitHolds({ notice: 'n', spend: true, retryAt: 2_000 }, NOW)).be.true();
    should(paneLimitHolds({ notice: 'n', spend: true, retryAt: 1_000 }, NOW)).be.false();
    should(paneLimitHolds({ notice: 'n', spend: true }, NOW)).be.true();
  });
});
