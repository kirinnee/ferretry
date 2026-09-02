import { describe, expect, it } from 'bun:test';
import { OPERATOR_UNLOCK_HEADER } from '@ferretry/protocol';
import type { z } from 'zod';

import type { FleetClient } from '../../../../src/features/fleet/fleet-api.ts';
import {
  cancelHarnessLogin,
  FLEET_LOGIN_PATH,
  readDaemonUsageFeed,
  readFleetLoginReadiness,
  readHarnessLoginFlow,
  renewFleetCredential,
  FLEET_RENEW_PATH,
  startHarnessLogin,
  submitHarnessLoginCode,
  USAGE_FEED_PATH,
  usageByWrapper,
} from '../../../../src/features/fleet/harness-login-api.ts';
import { CLAUDE_ACCOUNT_ID, claudeFlow, readiness, usageRow } from './harness-login-support.ts';

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

/** An unlock token that satisfies the shared grammar, so a fixture cannot be laxer than the daemon. */
const TOKEN = `fy_unlock_${'A'.repeat(22)}`;

/** What a renewal answers with. `ran` is not a success, which is why the assertions read `status`. */
const RENEWAL = {
  identity: 'claude:studio',
  status: 'renewed',
  accountId: CLAUDE_ACCOUNT_ID,
  reason: 'the harness renewed it, and no browser was opened',
  ran: true,
} as const;

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

describe('the harness login wire client', () => {
  it('reads readiness from the fleet login path, on the verb a read uses', async () => {
    const { client, calls } = clientFor(readiness());

    const answer = await readFleetLoginReadiness(client);

    expect(answer.identities).toHaveLength(1);
    expect(calls[0]?.path).toBe(FLEET_LOGIN_PATH);
    expect(calls[0]?.init?.method).toBeUndefined();
  });

  it('starts a sign-in with POST, naming an account and nothing else', async () => {
    const { client, calls } = clientFor(claudeFlow('starting'));

    await startHarnessLogin(client, { accountId: CLAUDE_ACCOUNT_ID });

    expect(calls[0]?.path).toBe(FLEET_LOGIN_PATH);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0]?.init)).toEqual({ accountId: CLAUDE_ACCOUNT_ID });
  });

  it('sends the operator password in the BODY, never in the path', async () => {
    // A query parameter reaches every proxy's access log, and this one is the machine's own password.
    const { client, calls } = clientFor(claudeFlow('starting'));

    await startHarnessLogin(client, { accountId: CLAUDE_ACCOUNT_ID, operatorPassword: 'the password' });

    expect(bodyOf(calls[0]?.init).operatorPassword).toBe('the password');
    expect(calls[0]?.path).not.toContain('the password');
  });

  it('carries the unlock in the header the dispatcher reads, on every call', async () => {
    const flow = claudeFlow('awaiting-code');
    // Each call gets the answer ITS OWN schema accepts: every one of the five parses on the way in, so a
    // shared fixture would fail on the parse rather than on the header this test is about.
    const cases: readonly (readonly [unknown, (client: FleetClient) => Promise<unknown>])[] = [
      [readiness(), async client => await readFleetLoginReadiness(client, TOKEN)],
      [flow, async client => await startHarnessLogin(client, { accountId: CLAUDE_ACCOUNT_ID }, TOKEN)],
      [flow, async client => await readHarnessLoginFlow(client, flow.flowId, TOKEN)],
      [flow, async client => await cancelHarnessLogin(client, flow.flowId, TOKEN)],
      [{ outcome: 'accepted', flow }, async client => await submitHarnessLoginCode(client, flow.flowId, 'x', TOKEN)],
      [RENEWAL, async client => await renewFleetCredential(client, { accountId: CLAUDE_ACCOUNT_ID }, TOKEN)],
    ];
    for (const [answer, call] of cases) {
      const { client, calls } = clientFor(answer);
      await call(client);
      const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
      expect(headers[OPERATOR_UNLOCK_HEADER]).toBe(TOKEN);
    }
  });

  it('renews on its OWN path with POST, naming an account and nothing else', async () => {
    // NOT under `/v1/fleet/login/`: every path there is a flow id, so a literal segment beside them
    // would be dialled as the id of a flow that does not exist.
    const { client, calls } = clientFor(RENEWAL);

    const outcome = await renewFleetCredential(client, { accountId: CLAUDE_ACCOUNT_ID });

    expect(calls[0]?.path).toBe(FLEET_RENEW_PATH);
    expect(calls[0]?.path).not.toContain(FLEET_LOGIN_PATH);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0]?.init)).toEqual({ accountId: CLAUDE_ACCOUNT_ID });
    expect(outcome.status).toBe('renewed');
  });

  it('sends a renewal’s operator password in the BODY, never in the path', async () => {
    const { client, calls } = clientFor(RENEWAL);

    await renewFleetCredential(client, { accountId: CLAUDE_ACCOUNT_ID, operatorPassword: 'the password' });

    expect(bodyOf(calls[0]?.init).operatorPassword).toBe('the password');
    expect(calls[0]?.path).not.toContain('the password');
  });

  it('parses a renewal that refused rather than throwing on one', async () => {
    // EVERY ENDING IS A VALUE. A renewal that correctly declined to spend a rotating refresh token is
    // a `200` with a reason, and a client that treated it as an error would show a failure for exactly
    // the case the host's gate exists to produce.
    const { client } = clientFor({
      identity: 'claude:studio',
      status: 'not-expired',
      reason: 'a home in this identity already holds a valid access token',
      ran: false,
    });

    const outcome = await renewFleetCredential(client, { accountId: CLAUDE_ACCOUNT_ID });

    expect(outcome).toMatchObject({ status: 'not-expired', ran: false });
    expect(outcome).not.toHaveProperty('accountId');
  });

  it('sends no unlock header at all when there is no unlock to send', async () => {
    const { client, calls } = clientFor(readiness());

    await readFleetLoginReadiness(client);

    expect(calls[0]?.init?.headers).toEqual({});
  });

  it('reads one flow by id, percent-encoding it into the path', async () => {
    const { client, calls } = clientFor(claudeFlow('awaiting-code'));

    await readHarnessLoginFlow(client, 'flow/one');

    expect(calls[0]?.path).toBe(`${FLEET_LOGIN_PATH}/flow%2Fone`);
  });

  it('forwards the code with POST, in the body, and nowhere else', async () => {
    const { client, calls } = clientFor({ outcome: 'accepted', flow: claudeFlow('awaiting-code') });

    const outcome = await submitHarnessLoginCode(client, 'flow-one', 'pasted-code');

    expect(outcome.outcome).toBe('accepted');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0]?.init)).toEqual({ code: 'pasted-code' });
    expect(calls[0]?.path).not.toContain('pasted-code');
  });

  it('parses a refusal outcome rather than throwing on one', async () => {
    // `refused`, `conflict` and `unconfirmed` are answers, not failures: a Codex flow always refuses, and
    // a caller that treated that as an error would render it as a broken panel.
    const { client } = clientFor({ outcome: 'refused', reason: 'Codex has nothing to bring back' });

    expect((await submitHarnessLoginCode(client, 'flow-one', 'x')).outcome).toBe('refused');
  });

  it('ends a sign-in with DELETE', async () => {
    const { client, calls } = clientFor(claudeFlow('failed'));

    await cancelHarnessLogin(client, 'flow-one');

    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(calls[0]?.path).toBe(`${FLEET_LOGIN_PATH}/flow-one`);
  });

  it('refuses a body the daemon would refuse, at the call rather than as a 400', async () => {
    const { client } = clientFor(claudeFlow('starting'));

    await expect(startHarnessLogin(client, { accountId: 'not-a-uuid' })).rejects.toThrow();
  });

  it('reads the usage feed from its own path and keys it by the wrapper name', async () => {
    const { client, calls } = clientFor({
      stale: false,
      accounts: [usageRow({ agent: 'claude-studio', usageBased: true, fiveHourPercent: 42 })],
    });

    const feed = await readDaemonUsageFeed(client);
    const byWrapper = usageByWrapper(feed);

    expect(calls[0]?.path).toBe(USAGE_FEED_PATH);
    expect(byWrapper.get('claude-studio')?.fiveHourPercent).toBe(42);
    expect(byWrapper.get('claude-auto')).toBeUndefined();
  });
});
