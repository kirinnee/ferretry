import { describe, expect, it } from 'bun:test';
import {
  cancelLoginSignIn,
  readLoginSignIn,
  recheckLoginSignIn,
  restartLoginSignIn,
  SIGN_IN_ROUTES,
  startLoginSignIn,
  submitLoginSignInCode,
  switchLoginSignInToLink,
} from '../../../app/lib/harness-login-api.ts';
import { type Call, scripted } from './support/client.ts';
import { CLAUDE_LOGIN_ID, claudeFlow } from './support/harness-login.ts';

const bodyOf = (call: Call | undefined): unknown => call?.body;

describe('signing in a login', () => {
  it('starts with POST, naming the login and nothing else', async () => {
    const calls: Call[] = [];
    const client = scripted({ [SIGN_IN_ROUTES.start]: claudeFlow('starting') }, calls);

    const flow = await startLoginSignIn(client, { loginId: CLAUDE_LOGIN_ID });

    expect(flow.loginId).toBe(CLAUDE_LOGIN_ID);
    expect(calls[0]?.route).toBe('POST /v1/logins/sign-in');
    expect(bodyOf(calls[0])).toEqual({ loginId: CLAUDE_LOGIN_ID });
  });

  it('reads, cancels and submits on the flow route, by flow id', async () => {
    const flow = claudeFlow('awaiting-code');
    const accepted = { outcome: 'accepted', flow };
    const calls: Call[] = [];
    const client = scripted(
      {
        [SIGN_IN_ROUTES.read]: flow,
        [SIGN_IN_ROUTES.cancel]: flow,
        [SIGN_IN_ROUTES.submit]: accepted,
      },
      calls,
    );

    await readLoginSignIn(client, flow.flowId);
    await cancelLoginSignIn(client, flow.flowId);
    await submitLoginSignInCode(client, flow.flowId, 'x');
    await switchLoginSignInToLink(client, flow.flowId);
    await recheckLoginSignIn(client, flow.flowId);

    expect(calls.map(call => call.route)).toEqual([
      'GET /v1/logins/sign-in/:flowId',
      'DELETE /v1/logins/sign-in/:flowId',
      'POST /v1/logins/sign-in/:flowId',
      'POST /v1/logins/sign-in/:flowId',
      'POST /v1/logins/sign-in/:flowId',
    ]);
    expect(calls.every(call => call.params?.flowId === flow.flowId)).toBe(true);
  });

  it('asks for a second look with nothing in the body but the method', async () => {
    const calls: Call[] = [];
    const client = scripted({ [SIGN_IN_ROUTES.submit]: { outcome: 'refused', reason: 'still nothing' } }, calls);

    const outcome = await recheckLoginSignIn(client, 'flow-one');

    expect(outcome).toEqual({ outcome: 'refused', reason: 'still nothing' });
    expect(bodyOf(calls[0])).toEqual({ method: 'recheck' });
  });

  it('forwards the code in the body only: never in the route, the params or the query', async () => {
    const calls: Call[] = [];
    const client = scripted({ [SIGN_IN_ROUTES.submit]: { outcome: 'accepted', flow: claudeFlow('complete') } }, calls);

    const outcome = await submitLoginSignInCode(client, 'flow-one', 'pasted-code');

    expect(outcome).toMatchObject({ outcome: 'accepted', flow: { loginId: CLAUDE_LOGIN_ID } });
    expect(bodyOf(calls[0])).toEqual({ code: 'pasted-code' });
    expect(calls[0]?.route).not.toContain('pasted-code');
    expect(JSON.stringify(calls[0]?.params)).not.toContain('pasted-code');
    expect(calls[0]?.query).toBeUndefined();
  });

  it('passes a refusal through unchanged rather than throwing on one', async () => {
    // `refused`, `conflict` and `unconfirmed` are answers, not failures: a Codex flow always refuses, and
    // a caller that treated that as an error would render it as a broken panel.
    const client = scripted({
      [SIGN_IN_ROUTES.submit]: { outcome: 'conflict', reason: 'this login is no longer running' },
    });

    expect(await submitLoginSignInCode(client, 'flow-one', 'x')).toEqual({
      outcome: 'conflict',
      reason: 'this login is no longer running',
    });
  });

  it('refuses an answer carrying a field the contract does not name, such as a token', async () => {
    const client = scripted({ [SIGN_IN_ROUTES.read]: { ...claudeFlow('awaiting-code'), accessToken: 'x' } });

    await expect(readLoginSignIn(client, 'flow-one')).rejects.toThrow();
  });

  it('refuses a body the daemon would refuse, at the call rather than as a 400', async () => {
    const client = scripted({ [SIGN_IN_ROUTES.start]: claudeFlow('starting') });

    await expect(startLoginSignIn(client, { loginId: 'Not A Slug' as never })).rejects.toThrow();
  });
});

describe('starting a sign-in over', () => {
  it('cancels the running one, then asks for a restart; with none running it only restarts', async () => {
    const calls: Call[] = [];
    const client = scripted(
      {
        [SIGN_IN_ROUTES.cancel]: new Error('gone'),
        [SIGN_IN_ROUTES.start]: claudeFlow('starting'),
      },
      calls,
    );

    await restartLoginSignIn(client, { loginId: CLAUDE_LOGIN_ID }, 'flow-one');
    await restartLoginSignIn(client, { loginId: CLAUDE_LOGIN_ID }, undefined);

    expect(calls.map(call => [call.route, call.body])).toEqual([
      ['DELETE /v1/logins/sign-in/:flowId', undefined],
      ['POST /v1/logins/sign-in', { loginId: CLAUDE_LOGIN_ID, restart: true }],
      ['POST /v1/logins/sign-in', { loginId: CLAUDE_LOGIN_ID, restart: true }],
    ]);
  });

  it('passes a refused restart through', async () => {
    const refusal = new Error('stopping');
    const client = scripted({ [SIGN_IN_ROUTES.start]: refusal });

    await expect(restartLoginSignIn(client, { loginId: CLAUDE_LOGIN_ID }, undefined)).rejects.toBe(refusal);
  });
});
