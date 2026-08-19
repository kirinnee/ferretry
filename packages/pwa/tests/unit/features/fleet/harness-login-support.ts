/**
 * Fixtures shared by the sign-in suites.
 *
 * Every shape is TYPED as the contract the surface parses, so a suite cannot cast past the thing it
 * exists to pin, and every value is written out longhand — a fixture derived from the same schema could
 * never fail on the day the daemon's answer changes shape.
 */

import type {
  ClaudeLoginFlow,
  CodexLoginFlow,
  FleetCredentialSource,
  FleetLoginAccount,
  FleetLoginIdentity,
  FleetLoginReadiness,
  UsageAccountView,
} from '@ferretry/protocol';

export const CLAUDE_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const CLAUDE_SIBLING_ID = '22222222-2222-4222-8222-222222222222';
const CODEX_ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const KEYED_ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';

/** Observed at claude-code 2.1.220. The PKCE query is part of the fixture on purpose. */
export const CLAUDE_URL = 'https://claude.com/cai/oauth/authorize?code=true&code_challenge_method=S256&state=fixture';
/** Observed at codex-cli 0.145.0. */
export const CODEX_URL = 'https://auth.openai.com/codex/device';
export const CODEX_CODE = '0IER-FFQW6';

export const NOW = Date.parse('2026-08-19T10:00:00.000Z');

export const loginAccount = (overrides: Partial<FleetLoginAccount> = {}): FleetLoginAccount => ({
  accountId: CLAUDE_ACCOUNT_ID,
  kind: 'claude',
  displayName: 'Studio Claude',
  wrapper: 'claude-studio',
  mode: 'interactive',
  available: true,
  credential: { state: 'missing' },
  source: { source: 'interactive-login' },
  login: { applies: true },
  ...overrides,
});

/** An account whose key arrives from the secrets file, so no sign-in applies to it. */
export const keyedAccount = (source?: FleetCredentialSource): FleetLoginAccount =>
  loginAccount({
    accountId: KEYED_ACCOUNT_ID,
    displayName: 'Proxy Claude',
    wrapper: 'claude-proxy',
    credential: { state: 'not-read' },
    source: source ?? { source: 'token-file', variable: 'ANTHROPIC_API_KEY', path: '/etc/ferretry/secrets.sh' },
    login: { applies: false, because: 'credential-is-not-a-login' },
  });

export const claudeIdentity = (accounts?: readonly FleetLoginAccount[]): FleetLoginIdentity => ({
  identity: 'claude:studio',
  kind: 'claude',
  verdict: 'login',
  accounts: accounts ?? [
    loginAccount(),
    loginAccount({ accountId: CLAUDE_SIBLING_ID, wrapper: 'claude-auto', mode: 'auto' }),
  ],
});

export const codexIdentity = (): FleetLoginIdentity => ({
  identity: 'codex:studio',
  kind: 'codex',
  verdict: 'login',
  accounts: [
    loginAccount({
      accountId: CODEX_ACCOUNT_ID,
      kind: 'codex',
      displayName: 'Studio Codex',
      wrapper: 'codex-studio',
    }),
  ],
});

export const readiness = (identities?: readonly FleetLoginIdentity[]): FleetLoginReadiness => ({
  identities: identities ?? [claudeIdentity()],
});

const FLOW_BASE = {
  flowId: 'flow-one',
  startedAt: '2026-08-19T10:00:00.000Z',
  expiresAt: '2026-08-19T10:10:00.000Z',
} as const;

export const claudeFlow = (state: ClaudeLoginFlow['state']): ClaudeLoginFlow => {
  const base = { harness: 'claude', ...FLOW_BASE, accountId: CLAUDE_ACCOUNT_ID, identity: 'claude:studio' } as const;
  if (state === 'awaiting-code') return { ...base, state, verificationUrl: CLAUDE_URL };
  if (state === 'complete') {
    return {
      ...base,
      state,
      accounts: [
        { accountId: CLAUDE_ACCOUNT_ID, status: 'logged-in' },
        { accountId: CLAUDE_SIBLING_ID, status: 'synced' },
      ],
    };
  }
  if (state === 'failed') {
    return {
      ...base,
      state,
      reason: 'this host’s claude did not offer a sign-in that can be driven from a browser',
      remedy: 'sign this account in on the host with `fy fleet login`',
    };
  }
  return { ...base, state: 'starting' };
};

export const codexFlow = (state: CodexLoginFlow['state']): CodexLoginFlow => {
  const base = { harness: 'codex', ...FLOW_BASE, accountId: CODEX_ACCOUNT_ID, identity: 'codex:studio' } as const;
  if (state === 'awaiting-approval') return { ...base, state, verificationUrl: CODEX_URL, userCode: CODEX_CODE };
  if (state === 'complete') return { ...base, state, accounts: [{ accountId: CODEX_ACCOUNT_ID, status: 'logged-in' }] };
  if (state === 'failed') {
    return { ...base, state, reason: 'the sign-in ran out of time', remedy: 'run `fy fleet login` on the host' };
  }
  return { ...base, state: 'starting' };
};

/** A usage row as `GET /v1/usage` sends one, keyed by the wrapper name. */
export const usageRow = (overrides: Partial<UsageAccountView> = {}): UsageAccountView => ({
  agent: 'claude-studio',
  ...overrides,
});
