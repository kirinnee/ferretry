import { describe, expect, test } from 'bun:test';
import type { HarnessLoginFlow, LoginFile, LoginView } from '../../contract/index.ts';
import { loginKinds } from '../../daemon/lib/kinds.ts';
import { sampleLogin } from '../../contract/testing/index.ts';

const AT = '2026-11-01T10:00:00.000Z';
const LATER = '2026-11-01T10:15:00.000Z';

const flow = (overrides: Record<string, unknown>): HarnessLoginFlow =>
  ({
    harness: 'claude-code',
    flowId: 'flow-1',
    loginId: 'work',
    identity: 'claude:you',
    startedAt: AT,
    expiresAt: LATER,
    state: 'starting',
    ...overrides,
  }) as unknown as HarnessLoginFlow;

const FILES = new Map<string, LoginFile>([
  ['work', { harness: 'claude-code', store: 'host' } as LoginFile],
  ['team', { harness: 'codex', store: 'ferretry' } as LoginFile],
  ['glm', { harness: 'claude-code', store: 'environment', preset: 'zai-glm', env: { A: '1' } } as LoginFile],
]);

/** Kinds over a scripted harness-login: `started` is the first flow, then each status read answers the next one. */
function world(started: HarnessLoginFlow, ...later: HarnessLoginFlow[]) {
  const sleeps: number[] = [];
  const reads: string[] = [];
  const queue = [...later];
  const kinds = loginKinds({
    signInVariables: async () => ({}),
    clock: {
      sleep: async duration => {
        sleeps.push(Number(duration));
      },
    },
    files: () => FILES,
    view: async id => sampleLogin(id),
    check: async id => sampleLogin(id),
    startSignIn: async () => started,
    signInStatus: async flowId => {
      reads.push(flowId);
      return queue.shift() ?? started;
    },
  });
  return { kinds, sleeps, reads };
}

describe('a kind’s sign-in', () => {
  test('hands back the page a person opens, for a flow waiting on a code or a callback', async () => {
    for (const state of ['awaiting-code', 'awaiting-callback']) {
      const { kinds } = world(flow({ state, verificationUrl: 'https://claude.ai/oauth/authorize?x=1' }));
      expect(await kinds.anthropic.signIn('work')).toEqual({
        kind: 'browser',
        url: 'https://claude.ai/oauth/authorize?x=1',
      });
    }
  });

  test('hands back the page and code of a device-code flow', async () => {
    const { kinds } = world(
      flow({
        harness: 'codex',
        loginId: 'team',
        state: 'awaiting-approval',
        verificationUrl: 'https://auth.example.test/device',
        userCode: 'ABCD-EFGH',
      }),
    );
    expect(await kinds.openai.signIn('team')).toEqual({
      kind: 'device-code',
      url: 'https://auth.example.test/device',
      code: 'ABCD-EFGH',
    });
  });

  test('says done for a flow that completed, and for a login that needs no sign-in at all', async () => {
    const { kinds } = world(flow({ state: 'complete' }));
    expect(await kinds.anthropic.signIn('work')).toEqual({ kind: 'done' });
    expect(await kinds.endpoint.signIn('glm')).toEqual({ kind: 'done' });
  });

  test('waits for the harness to offer a page, reading the flow again after each pause', async () => {
    const { kinds, sleeps, reads } = world(
      flow({ state: 'starting' }),
      flow({ state: 'starting' }),
      flow({ state: 'awaiting-code', verificationUrl: 'https://claude.ai/oauth/authorize?y=2' }),
    );
    expect(await kinds.anthropic.signIn('work')).toEqual({
      kind: 'browser',
      url: 'https://claude.ai/oauth/authorize?y=2',
    });
    expect(sleeps).toEqual([250, 250]);
    expect(reads).toEqual(['flow-1', 'flow-1']);
  });

  test('says why a flow failed, in the harness’s words', async () => {
    const { kinds } = world(flow({ state: 'failed', reason: 'the browser tab was closed', remedy: 'Try again.' }));
    await expect(kinds.anthropic.signIn('work')).rejects.toThrow('the browser tab was closed');
  });

  test('gives up after twenty looks when the harness never offers a page', async () => {
    const { kinds, sleeps } = world(flow({ state: 'starting' }));
    await expect(kinds.anthropic.signIn('work')).rejects.toThrow(
      'the harness has not offered a sign-in yet; try again',
    );
    expect(sleeps).toHaveLength(20);
  });
});

describe('a kind’s reads', () => {
  const quotaOf = async (view: LoginView) => {
    const kinds = loginKinds({
      clock: { sleep: async () => undefined },
      signInVariables: async () => ({}),
      files: () => FILES,
      view: async () => view,
      check: async () => view,
      startSignIn: async () => flow({}),
      signInStatus: async () => flow({}),
    });
    const quota = kinds.anthropic.quota;
    if (quota === undefined) throw new Error('every kind reads a quota');
    return await quota('work');
  };
  const withUsage = (usage: LoginView['usage']): LoginView => sampleLogin('work', { usage });

  test('carries each window measured, and the reset of the first window that has one', async () => {
    expect(
      await quotaOf(withUsage({ fiveHour: { usedPercent: 12 }, weekly: { usedPercent: 80, resetsAt: AT as never } })),
    ).toEqual({ fiveHourPercent: 12, weeklyPercent: 80, resetsAt: AT } as never);
    expect(await quotaOf(withUsage({ fiveHour: {}, weekly: { usedPercent: 5 } }))).toEqual({ weeklyPercent: 5 });
    expect(await quotaOf(withUsage({ fiveHour: { usedPercent: 7 }, weekly: {} }))).toEqual({ fiveHourPercent: 7 });
  });

  test('says nothing when no window was measured, rather than zero', async () => {
    expect(await quotaOf(withUsage({ fiveHour: {}, weekly: {} }))).toBeUndefined();
  });

  test('says the login does not exist when the list no longer shows it', async () => {
    const kinds = loginKinds({
      clock: { sleep: async () => undefined },
      signInVariables: async () => ({}),
      files: () => FILES,
      view: async () => undefined,
      check: async id => sampleLogin(id),
      startSignIn: async () => flow({}),
      signInStatus: async () => flow({}),
    });
    await expect(kinds.anthropic.status('work')).rejects.toThrow('there is no anthropic login named work');
  });
});
