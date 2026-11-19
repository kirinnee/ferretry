/**
 * The connect card's pure parts: how the page words a refusal, how long a code has left, and which address it may open.
 * No clock is read here (the caller passes `now`), so a countdown is the same on every run.
 */
import { GIT_ACCOUNT_CODES } from '../../contract/index.ts';

const WORDS: Readonly<Record<string, string>> = {
  [GIT_ACCOUNT_CODES.clientIdUnset]:
    'This machine has no GitHub app configured to ask. Set github.clientId in config/git-accounts.yaml.',
  [GIT_ACCOUNT_CODES.tooManyFlows]: 'Too many connections are waiting. Finish or let one expire, then try again.',
  [GIT_ACCOUNT_CODES.providerUnreachable]: 'This machine could not reach GitHub. Check its network and try again.',
  [GIT_ACCOUNT_CODES.providerRefused]: 'GitHub refused the request. Try again in a minute.',
  [GIT_ACCOUNT_CODES.unknownFlow]: 'That connection is no longer waiting. Start again.',
};

/** What a failed call says, in the page's words; an unknown failure keeps its own message. */
export function explainFailure(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string') {
    const known = WORDS[cause.code];
    if (known !== undefined) return known;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/** Milliseconds left until `expiresAt` (never negative); an unreadable instant counts as no time left. */
export function remainingMs(expiresAt: string, now: number): number {
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) ? 0 : Math.max(0, at - now);
}

/** `14:32`: minutes and zero-padded seconds, rounded UP so the last second reads 0:01, not 0:00. */
export function formatRemaining(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The address the code card may link to: https on github.com only. The daemon relays GitHub's `verification_uri`, and a
 * page must not turn a stranger's string into a link a person is told to type a code into.
 */
export function safeVerificationUri(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.username === '' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
