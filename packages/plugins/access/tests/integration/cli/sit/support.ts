/**
 * What the Access SIT journeys share in 5.0. SIT TIER: they spawn `fy` as a separate process — the compiled binary
 * when `CLI_BIN` names one, else `bun packages/cli/<bin entry>` — so they need the built CLI and its generated
 * command registry.
 *
 * A plugin does not import the `fy` package (`context-imports`), so this reads what it needs from `packages/cli` as
 * FILES: the binary name and entry from its `package.json`, and the contract hashes from its generated registry. The
 * 5.0 client reads the plugin inventory before every call and refuses a plugin whose hash differs, so a daemon double
 * answers `/v1/health` and `/v1/plugins` with exactly those hashes. The driver is a short copy of
 * `packages/cli/tests/sit/driver.ts`.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PROTOCOL } from '@ferretry/kernel/contract';

export interface CliResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export interface CliDriver {
  run(args: string[], env?: Record<string, string>): Promise<CliResult>;
}

const cliPackage = join(dirname(import.meta.path), '..', '..', '..', '..', '..', '..', 'cli');
const pkg = JSON.parse(readFileSync(join(cliPackage, 'package.json'), 'utf8')) as {
  readonly name: string;
  readonly bin: Readonly<Record<string, string>>;
};

export const binaryName = Object.keys(pkg.bin)[0] ?? pkg.name;
const binEntry = Object.values(pkg.bin)[0] ?? 'bin/fy.ts';

/** The ambient environment minus every `FY_*` variable: a journey must not inherit this machine's daemon or credential. */
function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !name.startsWith('FY_')) base[name] = value;
  return { ...base, NO_COLOR: '1', ...extra };
}

/** Spawns `fy` once per journey: the compiled binary when `CLI_BIN` names one, else the bun entry it is built from. */
export const sitDriver = (): CliDriver => {
  const compiled = process.env.CLI_BIN;
  const command = compiled !== undefined && compiled !== '' ? [compiled] : ['bun', join(cliPackage, binEntry)];
  return {
    async run(args, env = {}) {
      const proc = Bun.spawn([...command, ...args], {
        env: cleanEnvironment(env),
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, out, err };
    },
  };
};

/** A private HOME and FY_HOME per run, so a journey never reads this machine's daemon or token. */
const home = mkdtempSync(join(tmpdir(), 'fy-access-sit-'));
export const sitEnvironment = (extra: Record<string, string>): Record<string, string> => ({
  HOME: home,
  FY_HOME: join(home, 'fy-home'),
  FY_SESSION_ID: '',
  ...extra,
});

/**
 * Every package's contract hash as this `fy` was generated with it, read from the generated registry's text: the
 * kernel's own `kernel:` line first (it is not in the `plugins` array, but the guard requires it before any call),
 * then every plugin line, in the registry's order.
 */
const inventory = (): readonly { readonly id: string; readonly on: true; readonly contract: string }[] => {
  const generated = readFileSync(join(cliPackage, 'src', 'generated', 'commands.ts'), 'utf8');
  const kernel = /^\s*kernel: \{ manifest: \w+, contract: "([0-9a-f]+)" \}/mu.exec(generated)?.[1];
  if (kernel === undefined) throw new Error('the generated registry has no kernel line: regenerate it');
  const plugins = [...generated.matchAll(/\{ id: "([^"]+)", manifest: \w+, contract: "([0-9a-f]+)"/gu)].map(
    ([, id, contract]) => ({ id: id as string, on: true as const, contract: contract as string }),
  );
  return [{ id: 'kernel', on: true, contract: kernel }, ...plugins];
};

/** The kernel's two bootstrap reads, or `undefined` for any other route. */
export function bootstrapAnswer(request: Request): Response | undefined {
  const path = new URL(request.url).pathname;
  if (request.method === 'GET' && path === '/v1/health') return Response.json({ protocol: PROTOCOL, version: '5.0.0' });
  if (request.method === 'GET' && path === '/v1/plugins')
    return Response.json({ protocol: PROTOCOL, plugins: inventory() });
  return undefined;
}
