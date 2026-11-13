/**
 * The full program: the generated registry, the real world, one call. Everything but the invocations `bin/fy.ts` sends to
 * a slimmer root comes here, exactly as before the entry was split.
 */
import { clearYamlLogSwitches } from '@ferretry/std/yaml';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import root from '../../../package.json' with { type: 'json' };
import pkg from '../package.json' with { type: 'json' };
import { createWorld } from '../src/adapters/world.ts';
import { ConsoleIo } from '../src/adapters/terminal/console-io.ts';
import { registry } from '../src/generated/commands.ts';
import { runFy } from '../src/lib/run.ts';
import { assertSemver } from '../src/lib/version.ts';

/** Runs one invocation; `argv` is `process.argv`. Returns the exit code. */
export async function execute(argv: readonly string[]): Promise<number> {
  // FIRST: the yaml library prints what it parses when these are set, and a config may hold a credential.
  clearYamlLogSwitches();
  const declared = process.env.HOME;
  const world = createWorld({
    io: new ConsoleIo(),
    environment: process.env,
    userHome: declared !== undefined && isAbsolute(declared) ? declared : homedir(),
    identity: { binary: Object.keys(pkg.bin)[0] ?? pkg.name, version: assertSemver(pkg.version) },
    product: root.name,
    registry,
    selfPath: process.execPath,
  });
  return await runFy(argv.slice(2), world);
}
