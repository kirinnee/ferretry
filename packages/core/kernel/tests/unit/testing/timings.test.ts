import { describe, expect, test } from 'bun:test';
import type { DaemonTimings } from '../../../contract/ports.ts';
import { DEFAULT_DAEMON_TIMINGS, parseDaemonTimings } from '../../../host/session/timings.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

const manifest = definePlugin({ id: 'access', title: 'Access', version: '5.0.0', api: 5, core: true, kinds: [] });

describe('RR R247 kernel.timings: the parsed timings reach a daemon half', () => {
  test('the shipped numbers by default, and FYD_TEST_TIMINGS’ shorter idle day when given', async () => {
    const seen: DaemonTimings[] = [];
    const half = implementDaemon(manifest, {
      build: ctx => {
        seen.push(ctx.kernel.timings);
        return {};
      },
    });
    const shipped = await testHost({ plugins: [half] });
    await shipped.stop();
    const short = parseDaemonTimings('{"leaseSeconds": 6, "renewLeadSeconds": 2, "idleDaySeconds": 5}');
    const shortened = await testHost({ plugins: [half], timings: short });
    await shortened.stop();
    expect(seen[0]).toBe(DEFAULT_DAEMON_TIMINGS);
    expect(seen[1]?.idleDayMs).toBe(5_000);
    expect(seen[1]?.lease.leaseMs).toBe(6_000);
  });
});
