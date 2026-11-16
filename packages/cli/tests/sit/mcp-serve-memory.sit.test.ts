import { afterAll, beforeAll, describe, it } from 'bun:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import should from 'should';
import pkg from '../../package.json' with { type: 'json' };
import { HEALTH, standInDaemon } from '../integration/support/stand-in-daemon.ts';
import { defaultCommand } from './driver.ts';

// SIT: the idle memory of `fy mcp serve`. Every agent runtime starts one and keeps it for the life of its pane, so a
// machine running thirty ferrets runs thirty of these; loading the whole command registry made each 170 MiB (about 5 GB
// for thirty). The slim entry (`bin/mcp-serve.ts`) loads only what serve needs.
//
// HOW IT IS MEASURED: the child this test spawned, nobody else's process. Once it has answered `initialize` and sat idle
// for a moment, its `VmRSS` is read from `/proc/<its pid>/status` (Linux only; elsewhere the test has nothing to read
// and says so). Local measurement on 2026-11-11, linux x64, bun 1.4.4: 47–48 MiB running `bin/fy.ts` and 46 MiB for
// the compiled binary (`CLI_BIN`), both with the slim entry, against 171 MiB before it (`mcp-serve.sit.test.ts` printed
// that number; it reads 62 MiB there now because it has also listed tools and made a call, which loads the HTTP stack). What holds the 47: the bun runtime
// (about 16), then zod and `@ferretry/kernel/contract` (the guard's inventory schema and refusal table, the run-record
// schema, the route parser), then the serve module. The budget leaves headroom for a slower CI runner, not for loading
// a plugin again: a regression to the registry is 3x over it.
const MEMORY_BUDGET_MIB = 60;

const binEntry = Object.values(pkg.bin)[0] ?? 'bin/fy.ts';
const command = defaultCommand(binEntry, join(dirname(import.meta.path), '..', '..'));

let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'fy-sit-mcp-memory-'));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

const environment = (extra: Record<string, string>): Record<string, string> => {
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !name.startsWith('FY_')) base[name] = value;
  return { ...base, NO_COLOR: '1', HOME: home, FY_HOME: join(home, 'fy-home'), ...extra };
};

describe('fy mcp serve memory (SIT)', () => {
  it.skipIf(process.platform !== 'linux')(
    `holds under ${String(MEMORY_BUDGET_MIB)} MiB resident while idle after it answered initialize`,
    async () => {
      const { url } = standInDaemon((_request, path) =>
        path === '/v1/health' ? Response.json(HEALTH) : Response.json({ error: 'no' }, { status: 404 }),
      );
      const proc = Bun.spawn([...command, 'mcp', 'serve'], {
        env: environment({ FY_URL: url, FY_SESSION_TOKEN: 'fys_pane-credential', FY_SESSION_ID: 'pane-1' }),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      try {
        proc.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } })}\n`,
        );
        proc.stdin.flush();
        const reader = proc.stdout.getReader();
        let buffer = '';
        while (!buffer.includes('\n')) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += new TextDecoder().decode(chunk.value);
        }
        should(JSON.parse(buffer.split('\n')[0] ?? '')).match({ id: 1, result: { serverInfo: { name: 'ferretry' } } });
        // Idle: the answer is written and stdin is still open. Give the runtime a moment to settle.
        await Bun.sleep(500);
        const status = await readFile(`/proc/${String(proc.pid)}/status`, 'utf8');
        const rssKb = Number(/^VmRSS:\s+(\d+) kB/mu.exec(status)?.[1] ?? 0);
        should(rssKb).be.above(0);
        const rssMib = rssKb / 1024;
        console.log(`mcp serve idle RSS: ${rssMib.toFixed(1)} MiB (budget ${String(MEMORY_BUDGET_MIB)})`);
        should(rssMib).be.below(MEMORY_BUDGET_MIB);
      } finally {
        proc.kill('SIGKILL');
        await proc.exited;
      }
    },
  );
});
