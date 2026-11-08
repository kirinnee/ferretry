/**
 * Access's daemon half on the kernel's test host: the daemon identity comes from `kernel.identity` (the one the host
 * hands every plugin), so `POST /v1/pair/code` mints against the daemon's own id and name. A damaged device file
 * still fails the half closed. Codes are read to be checked, never printed.
 */
import { describe, expect, test } from 'bun:test';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { DevicesFile, PairingCodeMintResponseSchema } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';

/** The owner at the machine, the caller of `fy pair`. */
const atTheMachine = () => new StandInAdmission(() => ownerStanding());

const IDENTITY = {
  daemonId: `fy_daemon_${'B'.repeat(43)}`,
  daemonName: 'Studio',
  binaries: { client: 'fy', daemon: 'fyd' },
} as const;

describe('Access takes the daemon identity from kernel.identity', () => {
  test('POST /v1/pair/code mints a code for this daemon’s own id and name', async () => {
    const h = await testHost({
      plugins: [daemon],
      gate: atTheMachine(),
      fakes: { gate: new FakeGate() },
      identity: IDENTITY,
    });
    const response = await h.request('POST', '/v1/pair/code');
    expect(response.status).toBe(201);
    const minted = PairingCodeMintResponseSchema.parse(response.json());
    expect(minted.daemonId).toBe(IDENTITY.daemonId);
    expect(minted.daemonName).toBe(IDENTITY.daemonName);
    expect(minted.code.length).toBeGreaterThan(0);
    await h.stop();
  });

  test('the host’s default throwaway identity pairs too: the route no longer answers 503', async () => {
    const h = await testHost({ plugins: [daemon], gate: atTheMachine(), fakes: { gate: new FakeGate() } });
    const response = await h.request('POST', '/v1/pair/code');
    expect(response.status).toBe(201);
    expect(PairingCodeMintResponseSchema.parse(response.json()).daemonId).toBe(h.identity.daemonId);
    await h.stop();
  });

  test('a damaged device file still fails closed: the mint answers an error and never a code', async () => {
    const h = await testHost({
      plugins: [daemon],
      gate: atTheMachine(),
      fakes: { gate: new FakeGate() },
      identity: IDENTITY,
    });
    h.state('access').plant(DevicesFile, '{broken');
    const response = await h.request('POST', '/v1/pair/code');
    expect(response.status).toBe(503);
    expect(response.json<{ code: string }>().code).toBe('plugin_failed');
    expect(response.body).not.toContain('pairingId');
    await h.stop();
  });
});
