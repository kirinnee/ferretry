import { describe, expect, test } from 'bun:test';
import type { AuthorizedOutcome } from '@ferretry/core-vault/contract';
import type { Instant } from '@ferretry/std';
import { SPEEDUP_CATALOG } from '../../../daemon/lib/speedups/catalog.ts';
import { JevProbe, type JevProbeFailureCode } from '../../../daemon/lib/speedups/jev-probe.ts';
import { SpeedupsService } from '../../../daemon/lib/speedups/service.ts';
import type { OutboundAuthorizerPort } from '../../../daemon/lib/stt/ports.ts';

const AT = '2026-11-07T10:00:00.000Z' as Instant;

/** An authorizer that answers one outcome and records what was sent (never a key: only the name it names). */
function authorizer(outcome: AuthorizedOutcome) {
  const sent: { name: string; hosts: readonly string[]; method: string; url: string }[] = [];
  const port: OutboundAuthorizerPort = {
    send: async (name, hosts, request) => {
      sent.push({ name, hosts, method: request.method, url: request.url });
      return outcome;
    },
  };
  return { port, sent };
}

const status = (code: number): AuthorizedOutcome => ({ kind: 'status', status: code });
const choice = (triage: unknown): AuthorizedOutcome => ({ kind: 'completion', payload: { answers: { triage } } });

describe('the Jev connection Test', () => {
  const decide = async (outcome: AuthorizedOutcome): Promise<JevProbeFailureCode | undefined> =>
    new JevProbe(authorizer(outcome).port).decide();

  test('sends one tiny decision to the Jev endpoint under the Jev secret name', async () => {
    const { port, sent } = authorizer(choice({ choice: 'leave', confidence: 0.9 }));
    expect(await new JevProbe(port).decide()).toBeUndefined();
    expect(sent).toEqual([
      {
        name: SPEEDUP_CATALOG.jev.secretName,
        hosts: SPEEDUP_CATALOG.jev.hosts,
        method: 'POST',
        url: 'https://api.typesafe.ai/v1/systemone',
      },
    ]);
  });

  test('a readable choice is a key that works, by its own confidence or the chosen probability', async () => {
    expect(await decide(choice({ choice: 'leave', confidence: 0.5 }))).toBeUndefined();
    expect(await decide(choice({ choice: 'leave', probabilities: { leave: 1 } }))).toBeUndefined();
  });

  test('an answer that is not a readable choice is malformed', async () => {
    expect(await decide({ kind: 'completion', payload: 'text' })).toBe('malformed');
    expect(await decide({ kind: 'completion', payload: { answers: [] } })).toBe('malformed');
    expect(await decide(choice({ choice: 7, confidence: 0.5 }))).toBe('malformed');
    expect(await decide(choice({ choice: 'leave', confidence: 2 }))).toBe('malformed');
    expect(await decide(choice({ choice: 'leave', probabilities: { unsure: 1 } }))).toBe('malformed');
  });

  test('every provider status becomes the failure a screen can act on', async () => {
    expect(await decide(status(401))).toBe('rejected');
    expect(await decide(status(403))).toBe('rejected');
    expect(await decide(status(413))).toBe('too_large');
    expect(await decide(status(429))).toBe('rate_limited');
    expect(await decide(status(529))).toBe('overloaded');
    expect(await decide(status(503))).toBe('provider_error');
    expect(await decide(status(400))).toBe('invalid_request');
  });

  test('every way the call itself can fail becomes its own code', async () => {
    const kinds = {
      secret_missing: 'not_set',
      vault_damaged: 'vault_damaged',
      refused: 'misconfigured',
      timeout: 'timeout',
      unreachable: 'unreachable',
      oversized: 'malformed',
      unreadable: 'malformed',
    } as const;
    for (const [kind, code] of Object.entries(kinds)) expect(await decide({ kind } as AuthorizedOutcome)).toBe(code);
  });
});

describe('a Speed-ups Test', () => {
  function service(outcome: AuthorizedOutcome, guard?: JevProbeFailureCode) {
    const written: unknown[] = [];
    let tick = 0;
    const { port, sent } = authorizer(outcome);
    const speedups = new SpeedupsService({
      authorizer: port,
      secrets: { list: async () => [] },
      ledger: { read: async () => ({}), write: async document => void written.push(document) },
      clock: { monotonicMs: () => (tick += 5), now: () => AT },
      guard: { decide: async () => guard },
    });
    return { speedups, written, sent };
  }

  const codeOf = async (outcome: AuthorizedOutcome) => (await service(outcome).speedups.test('groq')).code;

  test('a model list that answers is a key that works, even when it is too big to read whole', async () => {
    expect(await codeOf({ kind: 'completion', payload: {} })).toBe('ok');
    expect(await codeOf({ kind: 'oversized' })).toBe('ok');
  });

  test('every way a model-list probe can fail says its own next step', async () => {
    expect(await codeOf({ kind: 'unreadable' })).toBe('malformed');
    expect(await codeOf({ kind: 'secret_missing' })).toBe('not_set');
    expect(await codeOf({ kind: 'vault_damaged' })).toBe('vault_damaged');
    expect(await codeOf({ kind: 'timeout' })).toBe('timeout');
    expect(await codeOf({ kind: 'unreachable' })).toBe('unreachable');
    expect(await codeOf({ kind: 'refused' })).toBe('provider_error');
    expect(await codeOf(status(401))).toBe('rejected');
    expect(await codeOf(status(403))).toBe('rejected');
    expect(await codeOf(status(429))).toBe('rate_limited');
    expect(await codeOf(status(500))).toBe('provider_error');
  });

  test('a model-list Test is a GET of the provider’s list under the provider’s secret name, and is remembered', async () => {
    const { speedups, written, sent } = service({ kind: 'completion', payload: {} });
    const result = await speedups.test('cerebras');
    expect(sent).toEqual([
      {
        name: SPEEDUP_CATALOG.cerebras.secretName,
        hosts: SPEEDUP_CATALOG.cerebras.hosts,
        method: 'GET',
        url: SPEEDUP_CATALOG.cerebras.probe.kind === 'model-list' ? SPEEDUP_CATALOG.cerebras.probe.url : '',
      },
    ]);
    expect(result).toMatchObject({ provider: 'cerebras', ok: true, code: 'ok', at: AT, latencyMs: 5 });
    expect(written).toEqual([{ results: { cerebras: result } }]);
  });

  test('the Jev Test asks the guard, and each of its failures maps to a Test code', async () => {
    const codes: Record<JevProbeFailureCode, string> = {
      not_set: 'not_set',
      vault_damaged: 'vault_damaged',
      rejected: 'rejected',
      rate_limited: 'rate_limited',
      overloaded: 'rate_limited',
      timeout: 'timeout',
      unreachable: 'unreachable',
      malformed: 'malformed',
      misconfigured: 'provider_error',
      invalid_request: 'provider_error',
      too_large: 'provider_error',
      provider_error: 'provider_error',
    };
    for (const [failure, code] of Object.entries(codes)) {
      const { speedups, sent } = service({ kind: 'completion', payload: {} }, failure as JevProbeFailureCode);
      expect((await speedups.test('jev')).code).toBe(code as never);
      expect(sent).toEqual([]);
    }
    const ok = service({ kind: 'completion', payload: {} });
    expect((await ok.speedups.test('jev')).ok).toBe(true);
  });
});
