import { describe, expect, test } from 'bun:test';
import { FakeGate } from '@ferretry/core-gate/contract/testing';
import { ferret, owner, testHost } from '@ferretry/kernel/testing';
import { PAIRING_MINT_PATH } from '@ferretry/std/pairing-screen';
import { PAIRING_CODE_PATH } from '../../../app/features/settings/add-device-api.ts';
import { PAIRING_CODE_PATH as CLI_PAIRING_CODE_PATH } from '../../../cli/lib/pair/gateway.ts';
import daemon from '../../../daemon/index.ts';
import manifest from '../../../manifest.ts';

/**
 * A PAIRING CODE IS NEVER AN AGENT'S TO MINT OR READ (docs/pairing.md, "Never show it to an agent"): minting is a person's
 * route, no agent TOOL of Access returns one, and the browser worker that hides a mint's response body spells the same
 * path Access serves. A ferret is refused before the handler runs, so no code is minted by these tests.
 */
describe('minting a pairing code is a person’s alone', () => {
  test('a ferret asking the mint route is refused as owner-only, with no code in the answer', async () => {
    const host = await testHost({ plugins: [daemon], fakes: { gate: new FakeGate() } });
    try {
      const refused = await host.request('POST', PAIRING_MINT_PATH, { body: {}, as: ferret('F1') });

      expect(refused.status).toBe(403);
      expect(refused.json<{ code: string }>().code).toBe('owner_only');
      // A boolean, so a failure can never print a body that held a live code.
      expect(/pairingId|"code":"[0-9A-Z]{4}-/u.test(refused.body)).toBe(false);
    } finally {
      await host.stop();
    }
  });

  test('the same holds for reading a minted code back and for revoking one', async () => {
    const host = await testHost({ plugins: [daemon], fakes: { gate: new FakeGate() } });
    try {
      const read = await host.request('GET', `${PAIRING_MINT_PATH}/fy_pair_x`, { as: ferret('F1') });
      const revoked = await host.request('DELETE', `${PAIRING_MINT_PATH}/fy_pair_x`, { as: ferret('F1') });

      expect(read.status).toBe(403);
      expect(revoked.status).toBe(403);
    } finally {
      await host.stop();
    }
  });

  test('Access offers no agent tool at all, so no tool can return a mint', () => {
    expect('agentTools' in manifest.actions).toBe(false);
  });

  test('every route under the mint path is a person route', () => {
    const minting = manifest.actions.routes.filter(route => String(route.key).includes(PAIRING_MINT_PATH));
    expect(minting.length).toBeGreaterThan(0);
    expect(minting.every(route => route.caller === 'person')).toBe(true);
  });

  test('the path the browser worker hides is the path every Access caller uses', () => {
    expect(PAIRING_MINT_PATH).toBe(PAIRING_CODE_PATH);
    expect(PAIRING_MINT_PATH).toBe(CLI_PAIRING_CODE_PATH);
    expect(owner().kind).toBe('owner');
  });
});
