import { afterAll, beforeAll, describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import should from 'should';
import pkg from '../../package.json' with { type: 'json' };
import { standInDaemon, HEALTH } from '../integration/support/stand-in-daemon.ts';
import { defaultCommand } from './driver.ts';

// SIT: `fy mcp serve` is a ferret's tools server and authenticates as that ferret ONLY: with the pane's own `fys_`
// credential, never the owner's. Every value below is synthetic. The owner's authority is offered three ways — `FY_TOKEN`
// in the environment, an admin token file in the home, and `--as-owner` — and none of them may reach the wire.
const binEntry = Object.values(pkg.bin)[0] ?? 'bin/fy.ts';
const command = defaultCommand(binEntry, join(dirname(import.meta.path), '..', '..'));

const OWNER_TOKEN = 'synthetic-owner-token-do-not-send';
const ADMIN_FILE_TOKEN = 'synthetic-admin-file-token-do-not-send';
const PANE_TOKEN = 'fys_synthetic-pane-credential';

let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'fy-sit-mcp-credential-'));
  await mkdir(join(home, 'fy-home', 'state', 'gate'), { recursive: true });
  await writeFile(join(home, 'fy-home', 'state', 'gate', 'admin-token'), `${ADMIN_FILE_TOKEN}\n`, { mode: 0o600 });
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
  standInDaemon((request, path) => {
    if (path === '/v1/health') return Response.json(HEALTH);
    if (path === '/v1/plugins') return Response.json(PLUGINS);
    if (path === '/v1/agent/tools' && request.method === 'POST') return Response.json({ text: 'ok' });
    return Response.json({ error: 'no' }, { status: 404 });
  });

const environment = (extra: Record<string, string>): Record<string, string> => {
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !name.startsWith('FY_')) base[name] = value;
  return { ...base, NO_COLOR: '1', HOME: home, FY_HOME: join(home, 'fy-home'), ...extra };
};

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Starts `fy <args>`, writes `lines` to its standard input, closes it, and reports how it ended. */
async function run(args: string[], env: Record<string, string>, lines: unknown[] = []): Promise<Run> {
  const proc = Bun.spawn([...command, ...args], {
    env: environment(env),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  for (const line of lines) proc.stdin.write(`${JSON.stringify(line)}\n`);
  await proc.stdin.end();
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

const CALL = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'terminal_list', arguments: {} } },
];

/** Whatever the daemon was sent, flattened: no request may carry an owner credential, in any header or body. */
const everythingSent = (seen: ReturnType<typeof daemon>['seen']): string => JSON.stringify(seen);

describe('fy mcp serve credential (SIT)', () => {
  it('sends the pane credential as the ferret’s bearer and never the owner’s, though FY_TOKEN and an admin token file are there', async () => {
    const { url, seen } = daemon();
    const result = await run(
      ['mcp', 'serve'],
      { FY_URL: url, FY_SESSION_TOKEN: PANE_TOKEN, FY_SESSION_ID: 'pane-1', FY_TOKEN: OWNER_TOKEN },
      CALL,
    );
    should(result.code).equal(0);
    const calls = seen.filter(request => request.path === '/v1/agent/tools');
    should(calls.length).equal(1);
    should(calls[0]?.headers).have.property('authorization', `Bearer ${PANE_TOKEN}`);
    should(everythingSent(seen)).not.containEql(OWNER_TOKEN);
    should(everythingSent(seen)).not.containEql(ADMIN_FILE_TOKEN);
  });

  it('takes the documented alias for the pane credential when FY_SESSION_TOKEN is absent', async () => {
    const { url, seen } = daemon();
    const result = await run(
      ['mcp', 'serve'],
      { FY_URL: url, FY_SESSION_BOARD_CAPABILITY: PANE_TOKEN, FY_SESSION_ID: 'pane-1', FY_TOKEN: OWNER_TOKEN },
      CALL,
    );
    should(result.code).equal(0);
    should(seen.find(request => request.path === '/v1/agent/tools')?.headers).have.property(
      'authorization',
      `Bearer ${PANE_TOKEN}`,
    );
    should(everythingSent(seen)).not.containEql(OWNER_TOKEN);
  });

  for (const [label, token] of [
    ['empty', ''],
    ['blank', '   '],
    ['not a pane credential', 'synthetic-not-a-pane-credential'],
    ['missing', undefined],
  ] as const) {
    it(`refuses loudly and sends nothing when FY_SESSION_TOKEN is ${label}, though FY_TOKEN is set`, async () => {
      const { url, seen } = daemon();
      const result = await run(
        ['mcp', 'serve'],
        {
          FY_URL: url,
          FY_SESSION_ID: 'pane-1',
          FY_TOKEN: OWNER_TOKEN,
          ...(token === undefined ? {} : { FY_SESSION_TOKEN: token }),
        },
        CALL,
      );
      should(result.code).not.equal(0);
      should(result.err).containEql('pane credential');
      should(result.err).containEql('does not fall back to the owner');
      should(result.out).equal('');
      should(seen).eql([]);
      should(result.err).not.containEql(OWNER_TOKEN);
    });
  }

  it('sends only the pane’s own bearer when that credential is well-formed but the daemon does not know it', async () => {
    const { url, seen } = standInDaemon((_request, path) =>
      path === '/v1/health' ? Response.json(HEALTH) : Response.json({ error: 'unknown credential' }, { status: 401 }),
    );
    const result = await run(
      ['mcp', 'serve'],
      { FY_URL: url, FY_SESSION_TOKEN: 'fys_synthetic-wrong', FY_SESSION_ID: 'pane-1', FY_TOKEN: OWNER_TOKEN },
      CALL,
    );
    should(result.code).equal(0);
    for (const request of seen)
      should(request.headers.authorization ?? 'Bearer fys_synthetic-wrong').equal('Bearer fys_synthetic-wrong');
    should(everythingSent(seen)).not.containEql(OWNER_TOKEN);
    should(everythingSent(seen)).not.containEql(ADMIN_FILE_TOKEN);
  });

  it('refuses --as-owner and sends nothing', async () => {
    const { url, seen } = daemon();
    const result = await run(
      ['--as-owner', 'mcp', 'serve'],
      { FY_URL: url, FY_SESSION_TOKEN: PANE_TOKEN, FY_SESSION_ID: 'pane-1', FY_TOKEN: OWNER_TOKEN },
      CALL,
    );
    should(result.code).equal(2);
    should(result.err).containEql('--as-owner is refused');
    should(result.out).equal('');
    should(seen).eql([]);
  });

  it('refuses --as-owner from a person’s shell too, rather than serving as the owner', async () => {
    const { url, seen } = daemon();
    const result = await run(['--as-owner', 'mcp', 'serve'], { FY_URL: url, FY_TOKEN: OWNER_TOKEN }, CALL);
    should(result.code).equal(2);
    should(seen).eql([]);
  });
});
