/**
 * Fixtures shared by the sign-in suites.
 *
 * Every shape is TYPED as the contract the surface parses, so a suite cannot cast past the thing it
 * exists to pin, and every value is written out longhand — a fixture derived from the same schema could
 * never fail on the day the daemon's answer changes shape.
 */

import type { ClaudeLoginFlow, CodexLoginFlow } from '@ferretry/protocol';

export const CLAUDE_CREDENTIAL_ID = 'claude-studio';
const CODEX_CREDENTIAL_ID = 'codex-studio';

/** Observed at claude-code 2.1.220. The PKCE query is part of the fixture on purpose. */
export const CLAUDE_URL = 'https://claude.com/cai/oauth/authorize?code=true&code_challenge_method=S256&state=fixture';
/** Observed at codex-cli 0.145.0. */
export const CODEX_URL = 'https://auth.openai.com/codex/device';
export const CODEX_CODE = '0IER-FFQW6';
/** The shape `codex login` printed at codex-cli 0.145.0, its values replaced. */
export const CODEX_LINK_URL =
  'https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=fixture';

export const NOW = Date.parse('2026-08-19T10:00:00.000Z');

const FLOW_BASE = {
  flowId: 'flow-one',
  startedAt: '2026-08-19T10:00:00.000Z',
  expiresAt: '2026-08-19T10:10:00.000Z',
} as const;

export const claudeFlow = (state: ClaudeLoginFlow['state']): ClaudeLoginFlow => {
  const base = {
    harness: 'claude',
    ...FLOW_BASE,
    credentialId: CLAUDE_CREDENTIAL_ID,
    identity: 'claude:studio',
  } as const;
  if (state === 'awaiting-code') return { ...base, state, verificationUrl: CLAUDE_URL };
  if (state === 'complete') return { ...base, state };
  if (state === 'failed') {
    return {
      ...base,
      state,
      reason: 'this host’s claude did not offer a sign-in that can be driven from a browser',
      remedy: 'sign this login in on the host',
    };
  }
  return { ...base, state: 'starting' };
};

export const codexFlow = (state: CodexLoginFlow['state']): CodexLoginFlow => {
  const base = { harness: 'codex', ...FLOW_BASE, credentialId: CODEX_CREDENTIAL_ID, identity: 'codex:studio' } as const;
  if (state === 'awaiting-approval') return { ...base, state, verificationUrl: CODEX_URL, userCode: CODEX_CODE };
  if (state === 'awaiting-callback') return { ...base, state, verificationUrl: CODEX_LINK_URL };
  if (state === 'finishing') return { ...base, state };
  if (state === 'complete') return { ...base, state };
  if (state === 'failed') {
    return { ...base, state, reason: 'the sign-in ran out of time', remedy: 'sign this login in on the host' };
  }
  return { ...base, state: 'starting' };
};
