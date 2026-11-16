import { afterAll, beforeAll, describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import should from 'should';
import pkg from '../../package.json' with { type: 'json' };
import { standInDaemon, HEALTH } from '../integration/support/stand-in-daemon.ts';
import { defaultCommand } from './driver.ts';

// SIT: `fy mcp serve` as a separate process, spoken to over its standard input and output like a harness does.
const binEntry = Object.values(pkg.bin)[0] ?? 'bin/fy.ts';
const command = defaultCommand(binEntry, join(dirname(import.meta.path), '..', '..'));

let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'fy-sit-mcp-'));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

/** The inventory a daemon of this very build answers: every plugin on, with the hash this `fy` was generated with. */
const generated = readFileSync(join(dirname(import.meta.path), '..', '..', 'src', 'generated', 'commands.ts'), 'utf8');
const kernelContract = /^\s*kernel: \{ manifest: \w+, contract: "([0-9a-f]+)" \}/mu.exec(generated)?.[1];
if (kernelContract === undefined) throw new Error('the generated registry has no kernel line: regenerate it');
const PLUGINS = {
  protocol: 1,
  plugins: [
    { id: 'kernel', on: true, contract: kernelContract },
    ...[...generated.matchAll(/\{ id: "([^"]+)", manifest: \w+, contract: "([0-9a-f]+)"/gu)].map(
      ([, id, contract]) => ({ id, on: true, contract }),
    ),
  ],
};

const daemon = () =>
  standInDaemon((request, path) =>
    path === '/v1/health'
      ? Response.json(HEALTH)
      : path === '/v1/plugins'
        ? Response.json(PLUGINS)
        : path === '/v1/agent/tools' && request.method === 'POST'
          ? Response.json({ text: 'Open: %terminal:dev', data: { surfaces: [{ id: 't1', title: 'dev' }] } })
          : Response.json({ error: 'no' }, { status: 404 }),
  );

const environment = (extra: Record<string, string>): Record<string, string> => {
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !name.startsWith('FY_')) base[name] = value;
  return { ...base, NO_COLOR: '1', HOME: home, FY_HOME: join(home, 'fy-home'), ...extra };
};

describe('fy mcp serve (SIT)', () => {
  it('speaks MCP over stdio as the ferret whose credential it holds, and writes nothing but protocol to stdout', async () => {
    const { url, seen } = daemon();
    const proc = Bun.spawn([...command, 'mcp', 'serve'], {
      env: environment({ FY_URL: url, FY_SESSION_TOKEN: 'fys_pane-credential', FY_SESSION_ID: 'pane-1' }),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    const lines: unknown[] = [];
    const reader = (async () => {
      let buffer = '';
      for await (const chunk of proc.stdout) {
        buffer += new TextDecoder().decode(chunk);
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline === -1) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          // Anything on stdout that is not one JSON-RPC message would break the harness: parsing it here fails the test.
          lines.push(JSON.parse(line) as unknown);
        }
      }
      should(buffer).equal('');
    })();
    const waitFor = async (count: number): Promise<void> => {
      const deadline = Date.now() + 40_000;
      while (lines.length < count && Date.now() < deadline) await Bun.sleep(25);
      should(lines.length).be.aboveOrEqual(count);
    };
    const send = (message: unknown): void => {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
      proc.stdin.flush();
    };

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'terminal_list', arguments: {} } });
    await waitFor(3);
    // Measured while idle: three answers written, stdin still open.
    const status = await readFile(`/proc/${String(proc.pid)}/status`, 'utf8').catch(() => '');
    const rssKb = Number(/^VmRSS:\s+(\d+) kB/mu.exec(status)?.[1] ?? 0);
    if (rssKb > 0) console.log(`mcp serve idle RSS: ${String(Math.round(rssKb / 1024))} MiB`);
    proc.stdin.end();
    should(await proc.exited).equal(0);
    await reader;

    const byId = (id: number) =>
      lines.find(line => (line as { id?: number }).id === id) as { result: Record<string, unknown> };
    should(byId(1).result).match({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'ferretry' },
      instructions:
        "Ferretry's tools: terminals, browser pages, configuration and lessons. How to use them is in your system prompt.",
    });
    const names = (byId(2).result.tools as { name: string }[]).map(tool => tool.name);
    for (const name of ['terminal_open', 'instructions', 'card_progress', 'config_read'])
      should(names).containEql(name);
    for (const name of ['secure_copy', 'secure_list', 'secure_discard', 'secure_paste']) should(names).containEql(name);
    for (const name of ['task_plan', 'account_propose']) should(names).not.containEql(name);
    should(byId(3).result).match({ content: [{ type: 'text', text: 'Open: %terminal:dev' }] });

    const call = seen.find(request => request.path === '/v1/agent/tools');
    should(call?.method).equal('POST');
    should(call?.headers).have.property('authorization', 'Bearer fys_pane-credential');
    should(JSON.parse(call?.body ?? '')).eql({ tool: 'terminal_list', input: {} });
  });
});
