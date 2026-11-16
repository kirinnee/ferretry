/**
 * Voice's two adapters: the ledger of each speed-up key's last Test, over the kernel's REAL state port and a temp folder,
 * and the one holder a speed-up key is spent through, over the Vault's own contract stand-in (which passes the same
 * conformance suite as the real Vault). Voice names the secret and the hosts and receives only what came back.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OutboundHttpRequest, SecretName } from '@ferretry/core-vault/contract';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { state } from '@ferretry/kernel/host';
import { SPEEDUP_TESTS_STATE } from '../../../contract/index.ts';
import { OutboundProviderAuthorizer } from '../../../daemon/adapters/outbound-provider-authorizer.ts';
import { StateSpeedupTestLedger } from '../../../daemon/adapters/state-speedup-test-ledger.ts';
import manifest from '../../../manifest.ts';

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe('the speed-up Test ledger on disk', () => {
  async function ledger() {
    const home = await mkdtemp(join(tmpdir(), 'fy-voice-state-'));
    homes.push(home);
    const port = state.createStatePort({
      home,
      pluginId: 'voice',
      files: manifest.data.state,
      fs: state.createNodeHostFs(),
    });
    return { ledger: new StateSpeedupTestLedger(port), file: join(home, 'state', 'voice', SPEEDUP_TESTS_STATE.path) };
  }

  test('a ledger never written reads as never tested, and what was written reads back', async () => {
    const { ledger: store } = await ledger();
    const results = { results: { groq: { ok: true, at: '2026-10-18T08:00:00.000Z' } } };

    const before = await store.read();
    await store.write(results);
    const after = await store.read();

    expect(before).toBeUndefined();
    expect(after).toEqual(results);
  });

  test('a damaged ledger reads as never tested, so the keys themselves are unaffected', async () => {
    const { ledger: store, file } = await ledger();
    await store.write({ results: { groq: { ok: true } } });
    await writeFile(file, '{ not json');

    expect(await store.read()).toBeUndefined();
  });
});

describe('the one holder a speed-up key is spent through', () => {
  const NAME = 'GROQ_API_KEY' as SecretName;
  const request: OutboundHttpRequest = {
    method: 'POST',
    url: 'https://api.groq.test/v1/chat',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    timeoutMs: 1_000,
    maxResponseBytes: 10_000,
  };

  test('puts the named secret on a request to an allowed host and answers only what came back', async () => {
    const seen: OutboundHttpRequest[] = [];
    const vault = new FakeVault(undefined, sent => {
      seen.push(sent);
      return { kind: 'completion', payload: { ok: true } };
    });
    await vault.put(NAME, 'gsk_test_0123456789abcdef');

    const answer = await new OutboundProviderAuthorizer(vault).send(NAME, ['api.groq.test'], request);

    expect(answer).toEqual({ kind: 'completion', payload: { ok: true } });
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(answer)).not.toContain('gsk_test');
  });

  test('refuses a host the secret is not allowed to reach, and a secret it does not hold', async () => {
    const vault = new FakeVault(undefined, () => ({ kind: 'completion', payload: {} }));
    await vault.put(NAME, 'gsk_test_0123456789abcdef');
    const holder = new OutboundProviderAuthorizer(vault);

    expect(await holder.send(NAME, ['somewhere.else.test'], request)).toEqual({ kind: 'refused' });
    expect(await holder.send('MISSING_KEY' as SecretName, ['api.groq.test'], request)).toEqual({
      kind: 'secret_missing',
    });
  });

  test('hands a credential placement through to the Vault', async () => {
    const seen: OutboundHttpRequest[] = [];
    const vault = new FakeVault(undefined, sent => {
      seen.push(sent);
      return { kind: 'completion', payload: {} };
    });
    await vault.put(NAME, 'gsk_test_0123456789abcdef');

    const answer = await new OutboundProviderAuthorizer(vault).send(NAME, ['api.groq.test'], request, {
      header: 'x-api-key',
    });

    expect(answer.kind).toBe('completion');
    expect(seen).toHaveLength(1);
  });
});
