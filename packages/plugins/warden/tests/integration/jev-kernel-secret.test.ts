/**
 * The Jev guard's outbound seam over the kernel's REAL `kernel.secrets.send` (the Warden's own id, permissions and
 * warden.yaml def): the kernel places `JEV_API_KEY`, and only once the owner's warden.yaml names it. The wire is the only
 * stand-in, because the guard speaks https to a named host and a loopback server cannot be that host.
 */
import { describe, expect, test } from 'bun:test';
import type { OutboundSecretOutcome, SecretsPort } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { WARDEN_CONFIG, WARDEN_JEV_KEY_REFERENCE } from '../../contract/index.ts';
import { authorizedOutcomeOf, kernelSecretSender } from '../../daemon/adapters/kernel-secret-sender.ts';
import type { AuthorizedOutcome } from '../../daemon/lib/jev-ports.ts';
import { JevTriageGuard, type TriageSnapshot } from '../../daemon/lib/jev.ts';
import manifest from '../../manifest.ts';

const VALUE = 'jev-planted-key-value-3c0d';
const snapshot: TriageSnapshot = {
  anomaly: 'unattended_question',
  summary: 'a ferret asked a question an hour ago',
  facts: { idleMinutes: 60 },
  recentTurns: ['asked: ship it?'],
};

async function wardenSecrets(file: unknown, vault?: Record<string, string>) {
  let secrets: SecretsPort | undefined;
  const sent: { url: string; headers: Record<string, string> }[] = [];
  const half = implementDaemon(
    definePlugin({
      id: 'warden',
      title: 'Warden',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: manifest.permissions,
      data: { config: [WARDEN_CONFIG] },
    }),
    {
      build: ({ kernel }) => {
        secrets = kernel.secrets;
        return {};
      },
    },
  );
  const host = await testHost({
    plugins: [half],
    config: { 'warden.yaml': file },
    ...(vault === undefined ? {} : { vault }),
    fetch: async (url, init) => {
      sent.push({ url: url.href, headers: { ...(init?.headers as Record<string, string>) } });
      return Response.json({ answers: { triage: { choice: 'leave', confidence: 0.9 } }, model: 'jev-latest' });
    },
  });
  if (secrets === undefined) throw new Error('not built');
  const guard = new JevTriageGuard(kernelSecretSender(secrets), { monotonicMs: () => 0 });
  return { host, guard, sent };
}

describe('the Jev key is the kernel’s to place, named only by the owner’s warden.yaml', () => {
  test('with no jev.key line the guard is not_set and no request leaves the machine, whatever the Vault holds', async () => {
    const { host, guard, sent } = await wardenSecrets({ layers: { jev: true } }, { JEV_API_KEY: VALUE });

    expect((await guard.decide(snapshot)).failure).toEqual({ code: 'not_set' });
    expect(sent).toEqual([]);
    await host.stop();
  });

  test('with jev.key the kernel puts the key on the request to api.typesafe.ai; the Warden sees only the reply', async () => {
    const { host, guard, sent } = await wardenSecrets(
      { jev: { key: WARDEN_JEV_KEY_REFERENCE } },
      { JEV_API_KEY: VALUE },
    );

    const decision = await guard.decide(snapshot);

    expect(decision.failure).toBeUndefined();
    expect(decision.verdict).toBe('leave');
    expect(sent.map(entry => new URL(entry.url).host)).toEqual(['api.typesafe.ai']);
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${VALUE}`);
    expect(JSON.stringify(decision)).not.toContain(VALUE);
    expect(JSON.stringify(host.logs)).not.toContain(VALUE);
    await host.stop();
  });

  test('a named key the Vault does not hold is still not_set, and nothing is sent', async () => {
    const { host, guard, sent } = await wardenSecrets({ jev: { key: WARDEN_JEV_KEY_REFERENCE } });

    expect((await guard.decide(snapshot)).failure).toEqual({ code: 'not_set' });
    expect(sent).toEqual([]);
    await host.stop();
  });

  test('the adapter only narrows: a URL outside the guard’s own hosts is refused before the kernel is asked', async () => {
    const asked: string[] = [];
    const secrets: SecretsPort = {
      resolve: async () => ({ refused: 'unknown' }),
      send: async name => {
        asked.push(name);
        return { kind: 'completion', status: 200, payload: {} };
      },
    };
    const guard = new JevTriageGuard(
      kernelSecretSender(secrets),
      { monotonicMs: () => 0 },
      { endpoint: 'https://elsewhere.test/v1/answers' },
    );

    expect((await guard.decide(snapshot)).failure).toEqual({ code: 'misconfigured' });
    expect(asked).toEqual([]);
  });

  test('every kernel outcome reads as the guard’s own words', () => {
    const cases: [OutboundSecretOutcome, AuthorizedOutcome][] = [
      [
        { kind: 'completion', status: 200, payload: { a: 1 } },
        { kind: 'completion', payload: { a: 1 } },
      ],
      [
        { kind: 'status', status: 401 },
        { kind: 'status', status: 401 },
      ],
      [
        { kind: 'status', status: 429, retryAfterSeconds: 2 },
        { kind: 'status', status: 429, retryAfterSeconds: 2 },
      ],
      [{ kind: 'timeout' }, { kind: 'timeout' }],
      [{ kind: 'network' }, { kind: 'unreachable' }],
      [{ kind: 'too_large' }, { kind: 'oversized' }],
      [{ kind: 'unreadable' }, { kind: 'unreadable' }],
      [{ kind: 'vault_damaged' }, { kind: 'vault_damaged' }],
      [{ kind: 'refused', refused: 'not_declared' }, { kind: 'secret_missing' }],
      [{ kind: 'refused', refused: 'not_configured' }, { kind: 'secret_missing' }],
      [{ kind: 'refused', refused: 'unknown' }, { kind: 'secret_missing' }],
      [{ kind: 'refused', refused: 'destination' }, { kind: 'refused' }],
      [{ kind: 'refused', refused: 'placement' }, { kind: 'refused' }],
    ];

    for (const [outcome, expected] of cases) expect(authorizedOutcomeOf(outcome)).toEqual(expected);
  });
});
