import { expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate } from '@ferretry/core-gate/contract/testing';
import { device, ferret, owner, testHost } from '@ferretry/kernel/testing';
import daemon from '../../../daemon/index.ts';
import { GrantAuditFile } from '../../../contract/index.ts';
test('E-24 the mounted failure route accepts only fixed classifications from a proved device and grants no unlock', async () => {
  const host = await testHost({ plugins: [daemon], fakes: { gate: new FakeGate(), asks: new FakeAsks() } });
  const id = `fy_device_id_${'a'.repeat(22)}`;
  try {
    const report = { ceremony: 'unlock', reason: 'cancelled' };
    expect((await host.request('POST', '/v1/passkeys/failure', { as: ferret('synthetic'), body: report })).status).toBe(
      403,
    );
    expect((await host.request('POST', '/v1/passkeys/failure', { as: owner(), body: report })).status).toBe(400);
    const bad = await host.request('POST', '/v1/passkeys/failure', {
      as: device(id),
      body: { ...report, exception: 'synthetic sensitive text' },
    });
    expect(bad.status).toBe(400);
    const good = await host.request('POST', '/v1/passkeys/failure', { as: device(id), body: report });
    expect(good.status).toBe(200);
    const journal = host.state('access').raw(GrantAuditFile) ?? '';
    expect(journal).toContain('passkey.browser-failed=unlock:cancelled');
    expect(journal).not.toContain('synthetic sensitive text');
  } finally {
    await host.stop();
  }
});
