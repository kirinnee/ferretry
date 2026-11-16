import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * macOS smoke died before any code ran (run 43797081874): `source`ing nix's printed environment under /bin/bash 3.2
 * is "syntax error near unexpected token `;'" — the stdenv setup.sh has `;&` and `local -n`. The script must hand
 * itself to the bash the environment names (its own `BASH=` line) before it sources anything. A Linux test cannot
 * run bash 3.2, so it pins the mechanism instead: the environment is sourced by the bash it names, which a sourced
 * `$BASH` reports. (A symlink to the real bash stands in for the store's bash: bash reports the path it was run by.)
 */
const script = join(import.meta.dir, 'in-devshell.sh');
const scratch: string[] = [];
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

const realBash = Bun.which('bash') ?? '/bin/bash';

function fixture(environment: (namedBash: string) => string): { env: string; namedBash: string } {
  const dir = mkdtempSync(join(tmpdir(), 'in-devshell-'));
  scratch.push(dir);
  const namedBash = join(dir, 'named-bash');
  symlinkSync(realBash, namedBash);
  const env = join(dir, 'devshell-env.sh');
  writeFileSync(env, environment(namedBash));
  return { env, namedBash };
}

function run(env: string, command: readonly string[]) {
  const result = Bun.spawnSync([realBash, script, ...command], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FY_DEVSHELL_ENV: env },
  });
  return { status: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

describe('scripts/ci/in-devshell.sh', () => {
  test('sources the printed environment under the bash that environment names, never the caller’s', () => {
    const { env, namedBash } = fixture(
      named => `declare -x SOURCED_BY="$BASH"\nBASH='${named}'\ncase x in x) FELL=1 ;& y) FELL=2 ;; esac\n`,
    );
    const result = run(env, ['sh', '-c', 'echo "$SOURCED_BY"']);
    expect(result.err).toBe('');
    expect(result.out).toBe(`${namedBash}\n`);
  });

  test('does not hand over again once it already runs under that bash (no exec loop)', () => {
    const { env } = fixture(() => 'true\n');
    writeFileSync(env, `declare -x SOURCED_BY="$BASH"\nBASH='${realBash}'\n`);
    const result = run(env, ['sh', '-c', 'echo "$SOURCED_BY"']);
    expect(result.out).toBe(`${realBash}\n`);
  });

  test('an environment that names a bash which is not there fails loudly instead of sourcing under the wrong one', () => {
    const { env } = fixture(() => "BASH='/nonexistent/store/bash'\n");
    const result = run(env, ['true']);
    expect(result.status).toBe(1);
    expect(result.err).toContain('names /nonexistent/store/bash as its bash');
  });

  test('an environment with no BASH line is sourced as before', () => {
    const { env } = fixture(() => "declare -x FROM_DEVSHELL='plain'\n");
    const result = run(env, ['sh', '-c', 'echo "$FROM_DEVSHELL"']);
    expect(result.out).toBe('plain\n');
  });
});
