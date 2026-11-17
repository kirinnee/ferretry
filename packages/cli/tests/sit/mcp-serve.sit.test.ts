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

/** What `fy mcp serve` said and what it asked the daemon, for one run of the SIT. */
interface ServeRun {
  readonly byId: (id: number) => { result: Record<string, unknown> };
  readonly seen: ReturnType<typeof daemon>['seen'];
}

/** Runs `fy mcp serve` as a separate process (the launch's channel marker given or not) through the standard exchange. */
async function serveOnce(extra: Record<string, string>, settleMs = 0): Promise<ServeRun> {
  {
    const { url, seen } = daemon();
    const proc = Bun.spawn([...command, 'mcp', 'serve'], {
      env: environment({ FY_URL: url, FY_SESSION_TOKEN: 'fys_pane-credential', FY_SESSION_ID: 'pane-1', ...extra }),
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
    // A server that polls does so as soon as the client is initialized; give it the time to be seen when it should.
    if (settleMs > 0) await Bun.sleep(settleMs);
    // Measured while idle: three answers written, stdin still open.
    const status = await readFile(`/proc/${String(proc.pid)}/status`, 'utf8').catch(() => '');
    const rssKb = Number(/^VmRSS:\s+(\d+) kB/mu.exec(status)?.[1] ?? 0);
    if (rssKb > 0) console.log(`mcp serve idle RSS: ${String(Math.round(rssKb / 1024))} MiB`);
    proc.stdin.end();
    should(await proc.exited).equal(0);
    await reader;

    const byId = (id: number) =>
      lines.find(line => (line as { id?: number }).id === id) as { result: Record<string, unknown> };
    return { byId, seen };
  }
}

describe('fy mcp serve (SIT)', () => {
  it('speaks MCP over stdio as the ferret whose credential it holds, and writes nothing but protocol to stdout', async () => {
    const { byId, seen } = await serveOnce({}, 1_500);
    // WITHOUT the launch marker (the channel flag was not passed) this is a plain tools server: no channel capability,
    // the one-line instructions only, and it never polls the daemon.
    should(byId(1).result).match({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'ferretry' },
      capabilities: { tools: { listChanged: false } },
      instructions:
        "Ferretry's tools: terminals, browser pages, configuration and lessons. How to use them is in your system prompt.",
    });
    should(JSON.stringify(byId(1).result)).not.containEql('claude/channel');
    should(seen.filter(request => request.body.includes('channel_'))).eql([]);
    const names = (byId(2).result.tools as { name: string }[]).map(tool => tool.name);
    for (const name of ['terminal_open', 'instructions', 'task_progress', 'card_progress', 'config_read'])
      should(names).containEql(name);
    for (const name of ['secure_copy', 'secure_list', 'secure_discard', 'secure_paste']) should(names).containEql(name);
    for (const name of ['signin_plan', 'task_plan', 'account_propose']) should(names).containEql(name);
    should(byId(3).result).match({ content: [{ type: 'text', text: 'Open: %terminal:dev' }] });

    const call = seen.find(request => request.path === '/v1/agent/tools');
    should(call?.method).equal('POST');
    should(call?.headers).have.property('authorization', 'Bearer fys_pane-credential');
    should(JSON.parse(call?.body ?? '')).eql({ tool: 'terminal_list', input: {} });
  });

  it('with the launch marker FERRETRY_CHANNEL=1 declares the claude/channel capability, says whose messages they are, and polls as a subscriber', async () => {
    const { byId, seen } = await serveOnce({ FERRETRY_CHANNEL: '1' }, 1_500);

    should(byId(1).result).match({
      capabilities: { tools: { listChanged: false }, experimental: { 'claude/channel': {} } },
    });
    const instructions = String(byId(1).result.instructions);
    should(instructions).startWith("Ferretry's tools: terminals, browser pages, configuration and lessons.");
    should(instructions).containEql(
      'Messages inside <channel source="ferretry"> come from Ferretry and from other ferrets',
    );
    should(instructions).containEql('never through the channel');
    const poll = seen
      .map(
        request =>
          JSON.parse(request.body || '{}') as { tool?: string; input?: { generation?: string; waitMs?: number } },
      )
      .find(body => body.tool === 'channel_poll');
    should(poll?.input?.waitMs).equal(20_000);
    should(typeof poll?.input?.generation).equal('string');
    should((poll?.input?.generation ?? '').length).be.above(8);
  });
});
