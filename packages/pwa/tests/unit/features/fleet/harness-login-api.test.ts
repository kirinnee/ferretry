import { describe, expect, it } from 'bun:test';
import type { z } from 'zod';

import type { FleetClient } from '../../../../src/features/fleet/fleet-client.ts';
import {
  cancelCredentialSignIn,
  FLEET_LOGIN_PATH,
  readCredentialSignIn,
  startCredentialSignIn,
  submitCredentialSignInCode,
  switchCredentialSignInToLink,
} from '../../../../src/features/fleet/harness-login-api.ts';
import { CLAUDE_CREDENTIAL_ID, claudeFlow } from './harness-login-support.ts';

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

const clientFor = (answer: unknown): { client: FleetClient; calls: Call[] } => {
  const calls: Call[] = [];
  const client: FleetClient = {
    request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return schema.parse(answer);
    },
  };
  return { client, calls };
};

const bodyOf = (init: RequestInit | undefined): Record<string, unknown> =>
  JSON.parse(String(init?.body)) as Record<string, unknown>;

describe('signing in a credential', () => {
  it('starts with POST, naming the credential and nothing else', async () => {
    const { client, calls } = clientFor(claudeFlow('starting'));

    const flow = await startCredentialSignIn(client, { credentialId: CLAUDE_CREDENTIAL_ID });

    expect(flow.credentialId).toBe(CLAUDE_CREDENTIAL_ID);
    expect(calls[0]?.path).toBe(FLEET_LOGIN_PATH);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0]?.init)).toEqual({ credentialId: CLAUDE_CREDENTIAL_ID });
  });

  it('reads, cancels and submits on the flow path', async () => {
    const flow = claudeFlow('awaiting-code');
    const cases: readonly (readonly [unknown, (client: FleetClient) => Promise<unknown>, string | undefined])[] = [
      [flow, async client => await startCredentialSignIn(client, { credentialId: CLAUDE_CREDENTIAL_ID }), 'POST'],
      [flow, async client => await readCredentialSignIn(client, flow.flowId), undefined],
      [flow, async client => await cancelCredentialSignIn(client, flow.flowId), 'DELETE'],
      [
        { outcome: 'accepted', flow },
        async client => await submitCredentialSignInCode(client, flow.flowId, 'x'),
        'POST',
      ],
      [{ outcome: 'accepted', flow }, async client => await switchCredentialSignInToLink(client, flow.flowId), 'POST'],
    ];
    for (const [answer, call, method] of cases) {
      const { client, calls } = clientFor(answer);
      await call(client);
      expect(calls[0]?.init?.method).toBe(method);
      expect(calls[0]?.path.startsWith(FLEET_LOGIN_PATH)).toBe(true);
    }
  });

  it('reads one flow by id, percent-encoding it into the path', async () => {
    const { client, calls } = clientFor(claudeFlow('awaiting-code'));

    await readCredentialSignIn(client, 'flow/one');

    expect(calls[0]?.path).toBe(`${FLEET_LOGIN_PATH}/flow%2Fone`);
  });

  it('forwards the code with POST, in the body, and nowhere else', async () => {
    const { client, calls } = clientFor({ outcome: 'accepted', flow: claudeFlow('complete') });

    const outcome = await submitCredentialSignInCode(client, 'flow-one', 'pasted-code');

    expect(outcome).toMatchObject({ outcome: 'accepted', flow: { credentialId: CLAUDE_CREDENTIAL_ID } });
    expect(bodyOf(calls[0]?.init)).toEqual({ code: 'pasted-code' });
    expect(calls[0]?.path).not.toContain('pasted-code');
  });

  it('passes a refusal through unchanged rather than throwing on one', async () => {
    // `refused`, `conflict` and `unconfirmed` are answers, not failures: a Codex flow always refuses, and
    // a caller that treated that as an error would render it as a broken panel.
    const { client } = clientFor({ outcome: 'conflict', reason: 'this login is no longer running' });

    expect(await submitCredentialSignInCode(client, 'flow-one', 'x')).toEqual({
      outcome: 'conflict',
      reason: 'this login is no longer running',
    });
  });

  it('refuses a body the daemon would refuse, at the call rather than as a 400', async () => {
    const { client } = clientFor(claudeFlow('starting'));

    await expect(startCredentialSignIn(client, { credentialId: 'Not A Slug' })).rejects.toThrow();
  });
});

describe('switchCredentialSignInToLink', () => {
  it('asks the running flow for a link, in the body, with nothing else in it', async () => {
    const { client, calls } = clientFor({ outcome: 'refused', reason: 'Claude Code has one way to sign in' });

    const outcome = await switchCredentialSignInToLink(client, 'flow-one');

    expect(outcome).toEqual({ outcome: 'refused', reason: 'Claude Code has one way to sign in' });
    expect(calls[0]?.path).toBe(`${FLEET_LOGIN_PATH}/flow-one`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ method: 'link' });
  });
});
