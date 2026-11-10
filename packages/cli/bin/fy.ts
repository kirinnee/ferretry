#!/usr/bin/env bun
/**
 * The `fy` host file (≤150 lines, names no subsystem): identity, the generated registry, the real world, one call.
 * The BINARY name is this package's `bin` key and the PRODUCT name is the root package's `name`; neither is written
 * anywhere else.
 */
import { clearYamlLogSwitches } from '@ferretry/std/yaml';
import root from '../../../package.json' with { type: 'json' };
import pkg from '../package.json' with { type: 'json' };
import { createWorld } from '../src/adapters/world.ts';
import { ConsoleIo } from '../src/adapters/terminal/console-io.ts';
import { registry } from '../src/generated/commands.ts';
import { runFy } from '../src/lib/run.ts';
import { assertSemver } from '../src/lib/version.ts';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';

if (import.meta.main) {
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
  process.exitCode = await runFy(process.argv.slice(2), world);
}
