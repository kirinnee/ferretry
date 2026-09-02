import { describe, it } from 'bun:test';
import should from 'should';
import * as harnessLogin from '../../src/lib/harness-login.ts';
import type {
  ClaudeLoginFlow,
  CodexLoginFlow,
  FleetLoginAccount,
  FleetLoginIdentity,
  FleetLoginReadiness,
  FleetRenewal,
  HarnessLoginSubmission,
} from '../../src/lib/index.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const SIBLING_ID = '00000000-0000-4000-8000-000000000002';

const CLAUDE_URL =
  'https://claude.com/cai/oauth/authorize?code=true&response_type=code&code_challenge_method=S256&state=abc';
const CODEX_URL = 'https://auth.openai.com/codex/device';

const loginAccount = {
  accountId: ACCOUNT_ID,
  kind: 'claude',
  displayName: 'Claude Kirin',
  wrapper: 'claude-kirin',
  mode: 'interactive',
  available: true,
  credential: { state: 'missing' },
  source: { source: 'interactive-login' },
  login: { applies: true },
} satisfies FleetLoginAccount;

const configuredAccount = {
  ...loginAccount,
  accountId: SIBLING_ID,
  wrapper: 'claude-ci',
  mode: 'auto',
  credential: { state: 'not-read' },
  source: { source: 'token-file', variable: 'ANTHROPIC_API_KEY', path: '/etc/ferretry/secrets.sh' },
  login: { applies: false, because: 'credential-is-not-a-login' },
} satisfies FleetLoginAccount;

const identity = {
  identity: 'claude:kirin',
  kind: 'claude',
  verdict: 'login',
  accounts: [loginAccount, configuredAccount],
} satisfies FleetLoginIdentity;

const readiness = { identities: [identity] } satisfies FleetLoginReadiness;

const flowShape = {
  flowId: 'flow-one',
  accountId: ACCOUNT_ID,
  identity: 'claude:kirin',
  startedAt: INSTANT,
  expiresAt: LATER_INSTANT,
} as const;

const claudeAwaiting = {
  harness: 'claude',
  ...flowShape,
  state: 'awaiting-code',
  verificationUrl: CLAUDE_URL,
} satisfies ClaudeLoginFlow;

const codexAwaiting = {
  harness: 'codex',
  ...flowShape,
  identity: 'codex:kirin',
  state: 'awaiting-approval',
  verificationUrl: CODEX_URL,
  userCode: '0IER-FFQW6',
} satisfies CodexLoginFlow;

const claudeComplete = {
  harness: 'claude',
  ...flowShape,
  state: 'complete',
  accounts: [
    { accountId: ACCOUNT_ID, status: 'logged-in' },
    { accountId: SIBLING_ID, status: 'synced' },
  ],
} satisfies ClaudeLoginFlow;

const claudeFailed = {
  harness: 'claude',
  ...flowShape,
  state: 'failed',
  reason: 'this host’s harness did not offer a remotable login',
  remedy: 'run `fy fleet login` on the host',
} satisfies ClaudeLoginFlow;

const accepted = { outcome: 'accepted', flow: claudeComplete } satisfies HarnessLoginSubmission;

const renewal = {
  identity: 'claude:kirin',
  status: 'renewed',
  accountId: ACCOUNT_ID,
  reason: 'the harness renewed it, and no browser was opened',
  ran: true,
} satisfies FleetRenewal;

const schemaCases: SchemaCase[] = [
  { name: 'verification url', schema: harnessLogin.HarnessLoginVerificationUrlSchema, value: CODEX_URL },
  { name: 'user code', schema: harnessLogin.HarnessLoginUserCodeSchema, value: '0IER-FFQW6' },
  {
    name: 'credential source',
    schema: harnessLogin.FleetCredentialSourceSchema,
    value: { source: 'environment', variable: 'OPENAI_API_KEY' },
  },
  { name: 'login applicability', schema: harnessLogin.FleetLoginApplicabilitySchema, value: { applies: true } },
  {
    name: 'credential reading',
    schema: harnessLogin.FleetCredentialReadingSchema,
    value: { state: 'valid', expiresAt: LATER_INSTANT },
  },
  { name: 'login account', schema: harnessLogin.FleetLoginAccountSchema, value: loginAccount },
  { name: 'login identity', schema: harnessLogin.FleetLoginIdentitySchema, value: identity },
  { name: 'login readiness', schema: harnessLogin.FleetLoginReadinessSchema, value: readiness },
  {
    name: 'account outcome',
    schema: harnessLogin.FleetLoginAccountOutcomeSchema,
    value: { accountId: ACCOUNT_ID, status: 'logged-in' },
  },
  { name: 'claude flow', schema: harnessLogin.ClaudeLoginFlowSchema, value: claudeAwaiting },
  { name: 'codex flow', schema: harnessLogin.CodexLoginFlowSchema, value: codexAwaiting },
  { name: 'harness flow', schema: harnessLogin.HarnessLoginFlowSchema, value: codexAwaiting },
  {
    name: 'start request',
    schema: harnessLogin.HarnessLoginStartRequestSchema,
    value: { accountId: ACCOUNT_ID, operatorPassword: 'the operator password' },
  },
  { name: 'submit request', schema: harnessLogin.HarnessLoginSubmitRequestSchema, value: { code: 'pasted-code' } },
  { name: 'submission', schema: harnessLogin.HarnessLoginSubmissionSchema, value: accepted },
  { name: 'renewal status', schema: harnessLogin.FleetRenewalStatusSchema, value: 'renewed' },
  {
    name: 'renewal request',
    schema: harnessLogin.FleetRenewalRequestSchema,
    value: { accountId: ACCOUNT_ID, operatorPassword: 'the operator password' },
  },
  { name: 'renewal', schema: harnessLogin.FleetRenewalSchema, value: renewal },
];

const rejects = (name: string, schema: SchemaCase['schema'], value: unknown): SchemaCase => ({ name, schema, value });

describe('harness-login schemas', () => {
  it('should round-trip every public schema', () => {
    assertRoundTrips(schemaCases);
    assertCoversEverySchema(harnessLogin, schemaCases);
  });

  it('should carry no field that could hold a token, in either direction', () => {
    // A token would have to arrive under a name, and no schema here declares one. The check is over
    // the rendered JSON shape rather than over the types, because the wire is what a caller sees.
    const rendered = JSON.stringify([readiness, claudeAwaiting, codexAwaiting, claudeComplete, accepted]);

    should(rendered.toLowerCase()).not.match(/"[a-z]*(accesstoken|refreshtoken|apikey|bearer)/u);
  });

  it('should refuse a verification URL a browser would activate as script', () => {
    assertRejects([
      rejects('javascript scheme', harnessLogin.HarnessLoginVerificationUrlSchema, 'javascript:alert(1)'),
      rejects('data scheme', harnessLogin.HarnessLoginVerificationUrlSchema, 'data:text/html,<b>hi</b>'),
      rejects('plain http', harnessLogin.HarnessLoginVerificationUrlSchema, 'http://auth.openai.com/codex/device'),
      rejects(
        'credentials in the address',
        harnessLogin.HarnessLoginVerificationUrlSchema,
        'https://user:secret@auth.openai.com/codex/device',
      ),
      rejects('not a URL at all', harnessLogin.HarnessLoginVerificationUrlSchema, 'auth.openai.com'),
    ]);
  });

  it('should accept the authorization URL Claude actually prints, PKCE challenge and all', () => {
    // Observed from `claude auth login --claudeai` at claude-code 2.1.220. The query string is the
    // point: a schema that stripped or refused it would refuse the only URL this flow ever publishes.
    should(harnessLogin.HarnessLoginVerificationUrlSchema.parse(CLAUDE_URL)).equal(CLAUDE_URL);
  });

  it('should accept only a device user code shaped the way a provider prints one', () => {
    should(harnessLogin.HarnessLoginUserCodeSchema.parse('ABCD-1234')).equal('ABCD-1234');
    assertRejects([
      rejects('lower case', harnessLogin.HarnessLoginUserCodeSchema, 'abcd-1234'),
      rejects('no hyphen', harnessLogin.HarnessLoginUserCodeSchema, '0IERFFQW6'),
      rejects('a whole sentence', harnessLogin.HarnessLoginUserCodeSchema, 'Enter this one-time code'),
      rejects('empty', harnessLogin.HarnessLoginUserCodeSchema, ''),
    ]);
  });

  it('should keep a Codex device code out of every Claude state', () => {
    assertRejects([
      rejects('claude awaiting a device code', harnessLogin.ClaudeLoginFlowSchema, {
        ...claudeAwaiting,
        userCode: '0IER-FFQW6',
      }),
      rejects('claude with an approval state', harnessLogin.ClaudeLoginFlowSchema, {
        ...claudeAwaiting,
        state: 'awaiting-approval',
      }),
    ]);
  });

  it('should keep a paste state out of every Codex state', () => {
    assertRejects([
      rejects('codex awaiting a pasted code', harnessLogin.CodexLoginFlowSchema, {
        ...codexAwaiting,
        state: 'awaiting-code',
      }),
      rejects('codex publishing a URL with no user code', harnessLogin.CodexLoginFlowSchema, {
        harness: 'codex',
        ...flowShape,
        state: 'awaiting-approval',
        verificationUrl: CODEX_URL,
      }),
    ]);
  });

  it('should refuse a flow that mixes one harness’s label with the other’s states', () => {
    assertRejects([
      rejects('codex label on a paste state', harnessLogin.HarnessLoginFlowSchema, {
        ...claudeAwaiting,
        harness: 'codex',
      }),
      rejects('claude label on an approval state', harnessLogin.HarnessLoginFlowSchema, {
        ...codexAwaiting,
        harness: 'claude',
      }),
      rejects('no harness at all', harnessLogin.HarnessLoginFlowSchema, { ...flowShape, state: 'starting' }),
    ]);
  });

  it('should refuse a URL in a state that has not published one yet', () => {
    assertRejects([
      rejects('starting with a URL', harnessLogin.ClaudeLoginFlowSchema, {
        harness: 'claude',
        ...flowShape,
        state: 'starting',
        verificationUrl: CLAUDE_URL,
      }),
      rejects('complete with a URL', harnessLogin.ClaudeLoginFlowSchema, {
        ...claudeComplete,
        verificationUrl: CLAUDE_URL,
      }),
    ]);
  });

  it('should demand a remedy from every failure, so a dead end always names the way back', () => {
    assertRejects([
      rejects('failed with no remedy', harnessLogin.ClaudeLoginFlowSchema, {
        harness: 'claude',
        ...flowShape,
        state: 'failed',
        reason: 'the child exited',
      }),
      rejects('failed with no reason', harnessLogin.CodexLoginFlowSchema, {
        harness: 'codex',
        ...flowShape,
        state: 'failed',
        remedy: 'run `fy fleet login`',
      }),
    ]);
    should(harnessLogin.ClaudeLoginFlowSchema.parse(claudeFailed)).deepEqual(claudeFailed);
  });

  it('should demand a reason from an unreadable credential and refuse one from the others', () => {
    assertRejects([
      rejects('unreadable with no reason', harnessLogin.FleetCredentialReadingSchema, { state: 'unreadable' }),
      rejects('missing with a reason', harnessLogin.FleetCredentialReadingSchema, {
        state: 'missing',
        reason: 'a locked keychain',
      }),
      rejects('not-read with an expiry', harnessLogin.FleetCredentialReadingSchema, {
        state: 'not-read',
        expiresAt: LATER_INSTANT,
      }),
    ]);
  });

  it('should demand a variable from every source that names one', () => {
    assertRejects([
      rejects('token file with no path', harnessLogin.FleetCredentialSourceSchema, {
        source: 'token-file',
        variable: 'ANTHROPIC_API_KEY',
      }),
      rejects('environment with no variable', harnessLogin.FleetCredentialSourceSchema, { source: 'environment' }),
      rejects('interactive login naming a variable', harnessLogin.FleetCredentialSourceSchema, {
        source: 'interactive-login',
        variable: 'ANTHROPIC_API_KEY',
      }),
      rejects('undeclared naming a path', harnessLogin.FleetCredentialSourceSchema, {
        source: 'undeclared',
        path: '/etc/secrets.sh',
      }),
    ]);
  });

  it('should refuse an applicable login that also carries a refusal', () => {
    assertRejects([
      rejects('applies with a because', harnessLogin.FleetLoginApplicabilitySchema, {
        applies: true,
        because: 'credential-is-not-a-login',
      }),
      rejects('refused with no because', harnessLogin.FleetLoginApplicabilitySchema, { applies: false }),
    ]);
  });

  it('should refuse an identity with no accounts, because a login is always of an identity', () => {
    assertRejects([rejects('empty identity', harnessLogin.FleetLoginIdentitySchema, { ...identity, accounts: [] })]);
  });

  it('should keep every fleet outcome distinguishable rather than collapsing them to success', () => {
    const statuses = [
      'logged-in',
      // A silent renewal: refreshed with no browser and nobody asked. A SUCCESS, and not a sign-in.
      'renewed',
      'synced',
      'usable',
      'not-required',
      'login-needed',
      'indeterminate',
      'unavailable',
      'failed',
    ] as const;

    for (const status of statuses) {
      should(harnessLogin.FleetLoginAccountOutcomeSchema.parse({ accountId: ACCOUNT_ID, status }).status).equal(status);
    }
  });

  it('should keep every renewal outcome distinguishable, because four of them mean nothing was fired', () => {
    // `not-expired`, `not-renewable`, `not-required` and `indeterminate` are four different reasons for
    // having done nothing, and they send a reader four different places: wait, sign in, look at the
    // configuration, and fix an unreadable home. Collapsing them is how a report implies a fleet renewed
    // itself when part of it was never looked at.
    const statuses = [
      'renewed',
      'not-expired',
      'not-renewable',
      'not-required',
      'indeterminate',
      'unavailable',
      'failed',
    ] as const;

    for (const status of statuses) {
      should(harnessLogin.FleetRenewalSchema.parse({ identity: 'claude:kirin', status, ran: false }).status).equal(
        status,
      );
    }
  });

  it('should let a renewal refuse before it chose a home, and carry no field a token could occupy', () => {
    // An identity that authenticates with a key has no home to name. Inventing one would point a reader
    // at an account this renewal never looked at.
    const refused = harnessLogin.FleetRenewalSchema.parse({
      identity: 'claude:api',
      status: 'not-required',
      reason: 'this account authenticates with a key, so it has no provider token to renew',
      ran: false,
    });

    should(refused).not.have.property('accountId');
    assertRejects([
      rejects('a renewed credential', harnessLogin.FleetRenewalSchema, {
        identity: 'claude:kirin',
        status: 'renewed',
        ran: true,
        accessToken: 'sk-live',
      }),
      rejects('a home to fire at', harnessLogin.FleetRenewalRequestSchema, {
        accountId: ACCOUNT_ID,
        home: '/fleet/homes/claude-kirin',
      }),
      rejects('a status the domain cannot produce', harnessLogin.FleetRenewalSchema, {
        identity: 'claude:kirin',
        status: 'logged-in',
        ran: true,
      }),
    ]);
  });

  it('should keep the four submission outcomes apart, including unconfirmed', () => {
    const outcomes: HarnessLoginSubmission[] = [
      accepted,
      { outcome: 'refused', reason: 'Codex completes at the provider; there is nothing to bring back' },
      { outcome: 'conflict', reason: 'this flow is no longer waiting for a code' },
      { outcome: 'unconfirmed', reason: 'the code was written but nobody can say whether the child read it' },
    ];

    should(outcomes.map(outcome => harnessLogin.HarnessLoginSubmissionSchema.parse(outcome))).deepEqual(outcomes);
  });

  it('should bound the submitted value without pinning a provider’s format', () => {
    should(harnessLogin.HarnessLoginSubmitRequestSchema.parse({ code: 'code#state' }).code).equal('code#state');
    assertRejects([
      rejects('empty code', harnessLogin.HarnessLoginSubmitRequestSchema, { code: '' }),
      rejects('unbounded code', harnessLogin.HarnessLoginSubmitRequestSchema, { code: 'x'.repeat(4_097) }),
      rejects('an extra field beside the code', harnessLogin.HarnessLoginSubmitRequestSchema, {
        code: 'ok',
        accessToken: 'sk-live',
      }),
    ]);
  });

  it('should refuse a start request that names anything but an account', () => {
    assertRejects([
      rejects('a command', harnessLogin.HarnessLoginStartRequestSchema, { command: 'claude auth login' }),
      rejects('a wrapper path', harnessLogin.HarnessLoginStartRequestSchema, {
        accountId: ACCOUNT_ID,
        wrapper: '/usr/local/bin/claude-kirin',
      }),
      rejects('an account name rather than an id', harnessLogin.HarnessLoginStartRequestSchema, {
        accountId: 'claude-kirin',
      }),
    ]);
  });
});
