#!/usr/bin/env bun
/**
 * Refresh `packages/fleet/codex/default-instructions.txt` from the installed Codex.
 *
 * That file is the system prompt Codex sends for a model it has no catalog entry for, and a Codex model
 * catalog entry Ferretry writes (`packages/fleet/src/lib/models/codex-catalog.ts`) repeats it so a model
 * on a third-party provider keeps exactly the prompt it had before it had an entry.
 *
 * How it is measured: run `codex exec` once against a local server that answers every request with an
 * error, on a throwaway Codex home whose provider points at that server and whose model is one Codex has
 * never heard of, and keep the `instructions` of the request it sent. No account, no network, no key.
 *
 *   bun scripts/local/refresh-codex-default-instructions.ts [--codex <path-to-codex>]
 *
 * Run it after bumping Codex, then run the fleet tests and commit the file if it changed.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const OUTPUT = resolve(import.meta.dir, '../../packages/fleet/codex/default-instructions.txt');
const UNKNOWN_MODEL = 'ferretry-no-such-model';

const flag = Bun.argv.indexOf('--codex');
const codex = flag > 0 ? (Bun.argv[flag + 1] ?? 'codex') : 'codex';

const home = await mkdtemp(join(tmpdir(), 'fy-codex-instructions-'));
let instructions: string | undefined;
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const body = (await request.json().catch(() => undefined)) as { instructions?: unknown } | undefined;
    if (typeof body?.instructions === 'string') instructions ??= body.instructions;
    return Response.json({ error: { message: 'stop' } }, { status: 400 });
  },
});

try {
  await writeFile(
    join(home, 'config.toml'),
    [
      'model_provider = "probe"',
      `model = "${UNKNOWN_MODEL}"`,
      '[model_providers.probe]',
      'name = "Probe"',
      `base_url = "http://127.0.0.1:${server.port}/v1"`,
      'env_key = "FY_PROBE_KEY"',
      'wire_api = "responses"',
      '',
    ].join('\n'),
  );
  const child = Bun.spawn([codex, 'exec', '--skip-git-repo-check', 'hi'], {
    cwd: home,
    env: { PATH: Bun.env.PATH ?? '', HOME: home, CODEX_HOME: home, FY_PROBE_KEY: 'unused' },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const timer = setTimeout(() => child.kill(), 60_000);
  await child.exited;
  clearTimeout(timer);
} finally {
  await server.stop(true);
  await rm(home, { recursive: true, force: true });
}

if (instructions === undefined || instructions.length < 10_000) {
  console.error('Codex sent no system prompt to the probe server; nothing was written.');
  process.exit(1);
}
await Bun.write(OUTPUT, instructions);
console.log(`wrote ${instructions.length} characters to ${OUTPUT}`);
