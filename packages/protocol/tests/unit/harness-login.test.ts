import { describe, it } from 'bun:test';
import should from 'should';
import * as harnessLogin from '../../src/lib/harness-login.ts';
import type { ClaudeLoginFlow, CodexLoginFlow, HarnessLoginSubmission } from '../../src/lib/index.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const CLAUDE_URL =
  'https://claude.com/cai/oauth/authorize?code=true&response_type=code&code_challenge_method=S256&state=abc';
const CODEX_URL = 'https://auth.openai.com/codex/device';

const flowShape = {
  flowId: 'flow-one',
  credentialId: 'claude-kirin',
  identity: 'claude-kirin',
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
} satisfies ClaudeLoginFlow;

const claudeFailed = {
  harness: 'claude',
  ...flowShape,
  state: 'failed',
  reason: 'this host’s harness did not offer a remotable login',
  remedy: 'run `fy fleet login` on the host',
} satisfies ClaudeLoginFlow;

const accepted = { outcome: 'accepted', flow: claudeComplete } satisfies HarnessLoginSubmission;

const schemaCases: SchemaCase[] = [
  { name: 'verification url', schema: harnessLogin.HarnessLoginVerificationUrlSchema, value: CODEX_URL },
  { name: 'user code', schema: harnessLogin.HarnessLoginUserCodeSchema, value: '0IER-FFQW6' },
  { name: 'last code', schema: harnessLogin.HarnessLoginLastCodeSchema, value: 'rejected' },
  { name: 'claude flow', schema: harnessLogin.ClaudeLoginFlowSchema, value: claudeAwaiting },
  { name: 'codex flow', schema: harnessLogin.CodexLoginFlowSchema, value: codexAwaiting },
  { name: 'harness flow', schema: harnessLogin.HarnessLoginFlowSchema, value: codexAwaiting },
  {
    name: 'start request',
    schema: harnessLogin.HarnessLoginStartRequestSchema,
    value: { credentialId: 'claude-kirin' },
  },
  { name: 'submit request', schema: harnessLogin.HarnessLoginSubmitRequestSchema, value: { code: 'pasted-code' } },
  { name: 'submission', schema: harnessLogin.HarnessLoginSubmissionSchema, value: accepted },
  { name: 'renewal status', schema: harnessLogin.FleetRenewalStatusSchema, value: 'renewed' },
  { name: 'codex method', schema: harnessLogin.HarnessLoginCodexMethodSchema, value: 'link' },
];

const CODEX_AUTHORIZE_URL =
  'https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=abc';

const rejects = (name: string, schema: SchemaCase['schema'], value: unknown): SchemaCase => ({ name, schema, value });

describe('harness-login schemas', () => {
  it('should carry Codex’s link sign-in, and say when a device code was unavailable', () => {
    const awaitingCallback = {
      harness: 'codex',
      ...flowShape,
      state: 'awaiting-callback',
      verificationUrl: CODEX_AUTHORIZE_URL,
    } satisfies CodexLoginFlow;
    assertRoundTrips([
      { name: 'awaiting callback', schema: harnessLogin.CodexLoginFlowSchema, value: awaitingCallback },
      {
        name: 'switched automatically',
        schema: harnessLogin.CodexLoginFlowSchema,
        value: { ...awaitingCallback, deviceCode: 'unavailable' },
      },
      {
        name: 'finishing',
        schema: harnessLogin.CodexLoginFlowSchema,
        value: { harness: 'codex', ...flowShape, state: 'finishing' },
      },
      {
        name: 'start as a link',
        schema: harnessLogin.HarnessLoginStartRequestSchema,
        value: { credentialId: 'codex-kirin', method: 'link' },
      },
      { name: 'switch to a link', schema: harnessLogin.HarnessLoginSubmitRequestSchema, value: { method: 'link' } },
    ]);
    assertRejects([
      rejects('the pasted address on the wire', harnessLogin.CodexLoginFlowSchema, {
        ...awaitingCallback,
        callbackUrl: 'http://localhost:1455/auth/callback?code=x',
      }),
      rejects('a callback on a Claude flow', harnessLogin.ClaudeLoginFlowSchema, {
        ...awaitingCallback,
        harness: 'claude',
      }),
      rejects('a switch to a device code', harnessLogin.HarnessLoginSubmitRequestSchema, { method: 'device-code' }),
      rejects('a switch with a code', harnessLogin.HarnessLoginSubmitRequestSchema, { method: 'link', code: 'x' }),
    ]);
  });

  it('should carry a refused or expired code as a recognised value, and nothing else', () => {
    // The fix for §6: a refused code needs a state of its own, and never the child's text.
    assertRoundTrips([
      {
        name: 'claude refused, waiting',
        schema: harnessLogin.ClaudeLoginFlowSchema,
        value: { ...claudeAwaiting, lastCode: 'rejected' },
      },
      {
        name: 'claude refused, ended',
        schema: harnessLogin.ClaudeLoginFlowSchema,
        value: { ...claudeFailed, lastCode: 'rejected' },
      },
      {
        name: 'codex expired',
        schema: harnessLogin.CodexLoginFlowSchema,
        value: { ...claudeFailed, harness: 'codex', identity: 'codex:kirin', lastCode: 'expired' },
      },
    ]);
    assertRejects([
      rejects('a waiting flow cannot have expired', harnessLogin.ClaudeLoginFlowSchema, {
        ...claudeAwaiting,
        lastCode: 'expired',
      }),
      rejects('child text in place of a value', harnessLogin.ClaudeLoginFlowSchema, {
        ...claudeAwaiting,
        lastCode: 'Invalid code. Please make sure the full code was copied.',
      }),
      rejects('a code value on a device flow in progress', harnessLogin.CodexLoginFlowSchema, {
        ...codexAwaiting,
        lastCode: 'expired',
      }),
    ]);
  });

  it('should round-trip every public schema', () => {
    assertRoundTrips(schemaCases);
    assertCoversEverySchema(harnessLogin, schemaCases);
  });

  it('should carry no field that could hold a token, in either direction', () => {
    // A token would have to arrive under a name, and no schema here declares one. The check is over
    // the rendered JSON shape rather than over the types, because the wire is what a caller sees.
    const rendered = JSON.stringify([claudeAwaiting, codexAwaiting, claudeComplete, accepted]);

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
      should(harnessLogin.FleetRenewalStatusSchema.parse(status)).equal(status);
    }
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
    should(harnessLogin.HarnessLoginSubmitRequestSchema.parse({ code: 'code#state' })).deepEqual({
      code: 'code#state',
    });
    assertRejects([
      rejects('empty code', harnessLogin.HarnessLoginSubmitRequestSchema, { code: '' }),
      rejects('unbounded code', harnessLogin.HarnessLoginSubmitRequestSchema, { code: 'x'.repeat(4_097) }),
      rejects('an extra field beside the code', harnessLogin.HarnessLoginSubmitRequestSchema, {
        code: 'ok',
        accessToken: 'sk-live',
      }),
    ]);
  });

  it('should refuse a start request that names anything but a credential', () => {
    assertRejects([
      rejects('a command', harnessLogin.HarnessLoginStartRequestSchema, { command: 'claude auth login' }),
      rejects('a wrapper path', harnessLogin.HarnessLoginStartRequestSchema, {
        credentialId: 'claude-kirin',
        wrapper: '/usr/local/bin/claude-kirin',
      }),
      rejects('a retired account id', harnessLogin.HarnessLoginStartRequestSchema, {
        accountId: '00000000-0000-4000-8000-000000000001',
      }),
    ]);
  });

  it('should start a sign-in from a credential', () => {
    // Arrange / Act
    const byCredential = harnessLogin.HarnessLoginStartRequestSchema.parse({ credentialId: 'claude-work' });

    // Assert
    should(byCredential).deepEqual({ credentialId: 'claude-work' });
    assertRejects([
      rejects('no credential', harnessLogin.HarnessLoginStartRequestSchema, {}),
      rejects('a credential with a confirmation riding along', harnessLogin.HarnessLoginStartRequestSchema, {
        credentialId: 'claude-work',
        operatorPassword: 'the operator password',
      }),
      rejects('a credential id that is not a slug', harnessLogin.HarnessLoginStartRequestSchema, {
        credentialId: 'Claude Work',
      }),
    ]);
  });

  it('should refuse a flow that names no credential, or a retired account', () => {
    // Arrange
    const { credentialId: _credentialId, ...withoutCredential } = flowShape;

    // Act / Assert
    assertRejects([
      rejects('no credential', harnessLogin.HarnessLoginFlowSchema, {
        harness: 'claude',
        ...withoutCredential,
        state: 'starting',
      }),
      rejects('an account', harnessLogin.HarnessLoginFlowSchema, {
        harness: 'claude',
        ...flowShape,
        accountId: '00000000-0000-4000-8000-000000000001',
        state: 'starting',
      }),
      rejects('a complete flow carrying account outcomes', harnessLogin.ClaudeLoginFlowSchema, {
        ...claudeComplete,
        accounts: [],
      }),
    ]);
  });
});
