/**
 * A scripted daemon for the accounts screen: the four routes of `git-accounts`, answered with FAKE data, recording every
 * call. The device flow answers what the daemon would: `pending`, then whatever `polls` says, in order.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { GitAccount, GitDeviceFlowStatus } from '../../contract/index.ts';

export const FAKE_USER_CODE = 'WDJB-MJHT';
const FLOW_ID = 'flow_0123456789abcdef';
export const EXPIRES = '2026-11-19T08:15:00.000Z';
export const NOW = Date.parse('2026-11-19T08:00:00.000Z');

export const octo: GitAccount = {
  id: 'gha_4242',
  provider: 'github',
  githubId: 4242,
  login: 'octo-fake',
  name: 'Octo Fake',
  avatarUrl: 'https://avatars.example/u/4242',
  scopes: ['read:user', 'repo'],
  keys: {
    ssh: { githubKeyId: '11', title: 'Ferretry laptop' },
    signing: { githubKeyId: '12', title: 'Ferretry laptop' },
  },
  createdAt: '2026-11-01T10:00:00.000Z',
};
export const hubot: GitAccount = {
  id: 'gha_777',
  provider: 'github',
  githubId: 777,
  login: 'hubot-fake',
  scopes: ['read:user'],
  keys: {},
  createdAt: '2026-11-10T10:00:00.000Z',
};

export interface Call {
  readonly route: string;
  readonly init: { params?: Record<string, string>; body?: unknown; quiet?: boolean } | undefined;
}

export interface ScriptOptions {
  accounts?: GitAccount[];
  /** What each poll answers, in order; the last repeats. */
  polls?: GitDeviceFlowStatus[];
  /** What happens when the flow is `done`: this account is added. */
  connects?: GitAccount;
  verificationUri?: string;
  /** A route that throws this. */
  failures?: Record<string, unknown>;
  keysLeftOnProvider?: string[];
}

export function scriptedGithub(options: ScriptOptions = {}) {
  const accounts = [...(options.accounts ?? [])];
  const polls = options.polls ?? [{ status: 'pending', interval: 1 }];
  let polled = 0;
  const calls: Call[] = [];
  const client = {
    call: async (route: string, init?: Call['init']) => {
      calls.push({ route, init });
      const failure = options.failures?.[route];
      if (failure !== undefined) throw failure;
      if (route === 'GET /v1/git-accounts') return structuredClone(accounts);
      if (route === 'POST /v1/git-accounts/github/device')
        return {
          flowId: FLOW_ID,
          provider: 'github',
          userCode: FAKE_USER_CODE,
          verificationUri: options.verificationUri ?? 'https://github.com/login/device',
          expiresAt: EXPIRES,
          interval: 1,
        };
      if (route === 'GET /v1/git-accounts/github/device/:flowId') {
        const status = polls[Math.min(polled, polls.length - 1)] as GitDeviceFlowStatus;
        polled += 1;
        if (status.status === 'done' && options.connects !== undefined) accounts.push(options.connects);
        return status;
      }
      if (route === 'DELETE /v1/git-accounts/:id') {
        const at = accounts.findIndex(each => each.id === init?.params?.id);
        if (at >= 0) accounts.splice(at, 1);
        return {
          id: init?.params?.id,
          removed: true,
          keysLeftOnProvider: options.keysLeftOnProvider ?? [],
          revokeAt: 'https://github.com/settings/applications',
        };
      }
      throw new Error(`unexpected ${route}`);
    },
  } as unknown as Pick<PluginClient, 'call'>;
  return { client, calls, accounts };
}
