/**
 * `fy daemon profile` on the composed Usage daemon (ledger V-0235): the report carries the read/write system-call counters
 * (from `/proc/self/io` through the kernel's host facts) that v4 printed.
 */
import { expect, test } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { HostFactsPort } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { renderPerformanceReport } from '../../contract/performance-render.ts';
import type { PerformanceProfileView } from '../../contract/index.ts';
import usage from '../../daemon/index.ts';

let syscr = 1_000;
const hostFacts = {
  platform: 'linux',
  procFile: async (_pid: number | 'self', file: string) => {
    if (file === 'io') {
      syscr += 500;
      return `syscr: ${String(syscr)}\nsyscw: ${String(syscr / 2)}\n`;
    }
    return '1 (fyd) S 1 1 1 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 1 1 1 1';
  },
} as unknown as HostFactsPort;

test('the profile report carries the system calls the window counted', async () => {
  const h = await testHost({
    plugins: [usage],
    hostFacts,
    fakes: {
      ferrets: new FakeFerrets(),
      conversation: fakeConversation(),
      logins: fakeLogins([sampleLogin('work')]),
      vault: new FakeVault(),
    },
  });
  const started = (await h.request('POST', '/v1/diagnostics/profile', { body: { seconds: 5 } })).json<{ id: string }>();
  // The window arms its timers after its first gauge reading; let that settle before time moves.
  await Bun.sleep(5);
  await h.clock.advance(5_000);
  const read = async () =>
    (await h.request('GET', `/v1/diagnostics/profile/${started.id}`)).json<PerformanceProfileView>();
  let view = await read();
  for (let attempt = 0; attempt < 50 && view.state !== 'finished'; attempt += 1) {
    await Bun.sleep(5);
    view = await read();
  }
  expect(view.state).toBe('finished');
  if (view.state !== 'finished') throw new Error('unreachable');
  expect(view.report.resources.syscalls?.reads).toBeGreaterThan(0);
  expect(renderPerformanceReport(view.report)).toContain('Syscalls');
  await h.stop();
});
