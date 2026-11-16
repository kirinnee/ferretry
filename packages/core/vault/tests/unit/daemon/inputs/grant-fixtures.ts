import {
  type AccountId,
  type AccountKey,
  type AccountSummary,
  factorFingerprint,
  type SignInId,
  type SignInRuleId,
  type SignInSummary,
} from '../../../../daemon/lib/inputs/borrowed.ts';
import type { SignInGrant } from '../../../../daemon/lib/inputs/borrowed-grants.ts';
import { identityOf } from '../../../../daemon/lib/inputs/login-observer.ts';
import type { InputRequestField } from '../../../../daemon/lib/inputs/wire.ts';
import type { InputTargetFacts } from '../../../../contract/index.ts';

/**
 * The sign-in a grant is about, as the matcher tests and the service tests draw it: a GitHub account that signs in at
 * github.com (a page) and a `sudo` prompt (a terminal), a task-plan line and a standing rule that cover them.
 */

export const NOW = Date.parse('2026-11-01T12:00:00.000Z');
export const SESSION = 'mvv6b4qw-49d0158d';
export const SIGN_IN = 'si_0123456789abcdef01234567' as SignInId;
export const OTHER_SIGN_IN = 'si_fedcba9876543210fedcba98' as SignInId;
export const KEY = `L${'a'.repeat(31)}` as AccountKey;
export const AT = '2026-10-01T00:00:00.000Z';

export type PageFacts = Extract<InputTargetFacts, { readonly kind: 'page' }>;
export type PageField = PageFacts['fields'][number];
export type TerminalFacts = Extract<InputTargetFacts, { readonly kind: 'terminal' }>;

export const pageField = (
  fieldId: string,
  over: Partial<PageField> = {},
  attrs: Partial<PageField['field']> = {},
): PageField => ({
  fieldId,
  frameOrigin: 'https://github.com',
  frameId: 'main',
  backendNodeId: fieldId === 'pass' ? 12 : 11,
  field: {
    tag: 'input',
    ...(fieldId === 'pass' ? { type: 'password', name: 'password' } : { type: 'text' }),
    ...attrs,
  },
  box: { x: 0, y: 0, w: 100, h: 30 },
  visible: true,
  ...over,
});

export const page = (over: Partial<PageFacts> = {}, fields?: PageField[]): PageFacts => ({
  kind: 'page',
  pageId: 'p1',
  origin: 'https://github.com',
  secure: true,
  navigationId: 'n1',
  fields: fields ?? [pageField('user'), pageField('pass')],
  ...over,
});

export const terminal = (over: Partial<TerminalFacts> = {}): TerminalFacts => ({
  kind: 'terminal',
  paneProof: { paneId: '%1', pid: 10 },
  foreground: { pid: 11, pgid: 11, comm: 'sudo', argv: 'sudo -v' },
  echo: 'off',
  cursorRow: 0,
  promptLine: '[sudo] password for kirin:',
  promptLineDigest: 'b'.repeat(64),
  program: 'sudo',
  canonical: true,
  recognisedConsumer: true,
  trustedProgram: true,
  ...over,
});

export const LOGIN_FIELDS: InputRequestField[] = [
  { id: 'user', label: 'Username', sensitivity: 'plain' },
  { id: 'pass', label: 'Password', sensitivity: 'secret' },
];

export const account = (over: Partial<AccountSummary> = {}): AccountSummary => ({
  id: 'GITHUB' as AccountId,
  label: 'GitHub',
  username: 'kirinnee',
  fields: { password: true },
  factors: [],
  signIns: [SIGN_IN],
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

export const site = (over: Partial<SignInSummary> = {}): SignInSummary => ({
  id: SIGN_IN,
  account: 'GITHUB' as AccountId,
  place: { kind: 'site', domains: ['github.com'], match: ['github.com', 'gist.github.com'] },
  method: { kind: 'password' },
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

export const grant = (over: Partial<SignInGrant> = {}): SignInGrant => ({
  id: `plan:${'ab'.repeat(16)}:0`,
  source: 'plan',
  plan: { id: 'ab'.repeat(16), line: 0 },
  sessionId: SESSION,
  surface: 'page',
  signIn: SIGN_IN,
  accountKey: KEY,
  fields: new Set(['username', 'password']),
  pins: { placeKeys: ['github.com'], recipeVersion: undefined, identities: undefined },
  expiresAt: NOW + 3_600_000,
  state: 'in-force',
  remaining: 1,
  ...over,
});

/** A standing rule for the same sign-in, approved an hour ago with the owner's history of this very form, for any ferret. */
const RULE = 'sr_0123456789abcdef01234567' as SignInRuleId;
export const ruleGrant = (over: Partial<SignInGrant> = {}): SignInGrant => {
  const { sessionId: _plansOnly, plan: _plan, ...base } = grant();
  return {
    ...base,
    id: `rule:${RULE}:1`,
    source: 'rule',
    rule: { id: RULE, revision: 1 },
    scope: { kind: 'any' },
    accountPins: { id: 'GITHUB' as AccountId, username: 'kirinnee', factors: factorFingerprint([]) },
    approvedAt: NOW - 3_600_000,
    pins: {
      placeKeys: ['github.com'],
      recipeVersion: undefined,
      identities: [identityOf(page(), 'github.com') as string],
    },
    remaining: Number.POSITIVE_INFINITY,
    ...over,
  };
};
