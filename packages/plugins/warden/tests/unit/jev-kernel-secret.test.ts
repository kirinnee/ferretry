/**
 * D2 #19 (Q4): the Jev guard spends `JEV_API_KEY` only through `kernel.secrets.send`, so the Warden never holds it, and
 * only once the OWNER's `warden.yaml` names it as `jev.key: ${secret:JEV_API_KEY}` — an agent's write that adds that
 * line is held. Without it the guard answers `not_set` and nothing leaves the machine, exactly as before.
 */
import { describe, expect, test } from 'bun:test';
import type { ConfigPort, OutboundSecretOutcome, SecretsPort } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { owner, testHost } from '@ferretry/kernel/testing';
import {
  effectiveWardenConfig,
  WARDEN_CONFIG,
  WARDEN_JEV_KEY_REFERENCE,
  WardenFileSchema,
} from '../../contract/index.ts';
import { ConfigWardenConfigStore } from '../../daemon/adapters/config-store.ts';
import { authorizedOutcomeOf, kernelSecretSender } from '../../daemon/adapters/kernel-secret-sender.ts';
import { parseWardenConfigPatch } from '../../daemon/lib/config.ts';
import type { AuthorizedOutcome } from '../../daemon/lib/jev-ports.ts';
import { JevTriageGuard, type TriageSnapshot } from '../../daemon/lib/jev.ts';
import manifest from '../../manifest.ts';
import { realWardenConfig, wardenHost } from './parity/host.ts';

const VALUE = 'jev-planted-key-value-3c0d';
const snapshot: TriageSnapshot = {
  anomaly: 'unattended_question',
  summary: 'a ferret asked a question an hour ago',
  facts: { idleMinutes: 60 },
  recentTurns: ['asked: ship it?'],
};

/** A plugin with the Warden's own id, permissions and warden.yaml def, so `kernel.secrets` is the Warden's. */
async function wardenSecrets(file: unknown, vault?: Record<string, string>) {
  let secrets: SecretsPort | undefined;
  let config: ConfigPort | undefined;
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
        config = kernel.config;
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
  if (secrets === undefined || config === undefined) throw new Error('not built');
  const guard = new JevTriageGuard(kernelSecretSender(secrets), { monotonicMs: () => 0 });
  return { host, guard, sent, config };
}

describe('D2 #19 Q4 the Jev key is the kernel’s to place, named only by the owner’s warden.yaml', () => {
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
      {
        endpoint: 'https://elsewhere.test/v1/answers',
      },
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

  test('NN2: an agent’s write that adds jev.key is held for the owner, and the guard stays not_set', async () => {
    const real = realWardenConfig();
    const outcome = await real.port.write(WARDEN_CONFIG, undefined, {
      patch: { jev: { key: WARDEN_JEV_KEY_REFERENCE } },
    });
    expect(outcome.kind).toBe('held');
    expect(outcome.kind === 'held' ? outcome.sentences : []).toContain(
      'names the secret JEV_API_KEY, which only the owner may add to a configuration',
    );
    expect(real.port.file(WARDEN_CONFIG)?.jev).toBeUndefined();
    // even the owner's own hand edit waits for their confirmation before a new reference is in effect
    await real.handEdit(`jev:\n  key: ${WARDEN_JEV_KEY_REFERENCE}\n`);
    expect(real.port.fileState(WARDEN_CONFIG).state).toBe('held');
    expect(real.port.file(WARDEN_CONFIG)?.jev).toBeUndefined();
  });

  test('jev.key takes only the one reference: never a value, never another secret', () => {
    expect(WardenFileSchema.safeParse({ jev: { key: WARDEN_JEV_KEY_REFERENCE } }).success).toBe(true);
    expect(WardenFileSchema.safeParse({ jev: {} }).success).toBe(true);
    expect(WardenFileSchema.safeParse({ jev: { key: VALUE } }).success).toBe(false);
    expect(WardenFileSchema.safeParse({ jev: { key: '${secret:GITHUB_TOKEN}' } }).success).toBe(false);
    expect(WardenFileSchema.safeParse({ jev: { key: WARDEN_JEV_KEY_REFERENCE, url: 'x' } }).success).toBe(false);
  });

  test('jev is no setting: the settings read leaves it out and a settings save may not name it', () => {
    const settings = effectiveWardenConfig({ jev: { key: WARDEN_JEV_KEY_REFERENCE }, enabled: false });
    expect(settings.enabled).toBe(false);
    expect('jev' in settings).toBe(false);
    expect(() => parseWardenConfigPatch({ jev: { key: WARDEN_JEV_KEY_REFERENCE } })).toThrow();
    expect(parseWardenConfigPatch({ enabled: true })).toEqual({ enabled: true });
  });

  test('R-0232 the settings route refuses a change that names jev, and the view never shows it', async () => {
    const { host } = await wardenHost({ config: { jev: { key: WARDEN_JEV_KEY_REFERENCE } } });
    const named = await host.request('PATCH', '/v1/warden/config', {
      body: { jev: { key: WARDEN_JEV_KEY_REFERENCE } },
      as: owner(),
    });
    expect(named.status).toBe(400);
    const view = await host.request('GET', '/v1/warden/config', { as: owner() });
    expect(view.status).toBe(200);
    expect(view.body).not.toContain('JEV_API_KEY');
    await host.stop();
  });

  test('a settings save keeps the owner’s jev.key line', async () => {
    const { host, config } = await wardenSecrets({ enabled: true, jev: { key: WARDEN_JEV_KEY_REFERENCE } });
    const store = new ConfigWardenConfigStore(config);
    const next = { ...effectiveWardenConfig(config.file(WARDEN_CONFIG) ?? {}), enabled: false };
    expect(await store.write(next, { enabled: false })).toEqual([]);
    expect(config.file(WARDEN_CONFIG)).toEqual({ enabled: false, jev: { key: WARDEN_JEV_KEY_REFERENCE } });
    await host.stop();
  });
});
