/**
 * bun migration/v4-to-v5/preview/main.ts <dry-run|prepare|wrapper> [--v4 <home>] [--target <home>]
 *
 * `dry-run` touches nothing. `prepare` makes the preview home (OWNER-run, after review). `wrapper` writes
 * `<target>/bin/fy5`. Nothing here starts a daemon, a service or a terminal.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { hostLockProbe } from '../src/preflight.ts';
import { dryRun, prepare, wrapperText } from './driver.ts';
import { PREVIEW } from './plan.ts';

const USAGE = 'usage: bun preview/main.ts <dry-run|prepare|wrapper> [--v4 <v4 home>] [--target <preview home>]';

async function main(argv: readonly string[]): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{ options: { v4: { type: 'string' }; target: { type: 'string' } }; allowPositionals: true }>
  >;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { v4: { type: 'string' }, target: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 64;
  }
  const v4Home = resolve(parsed.values.v4 ?? join(homedir(), '.ferretry'));
  const target = resolve(parsed.values.target ?? join(homedir(), PREVIEW.homeFolder));
  if (v4Home === target) {
    console.error('the preview home must not be the v4 home');
    return 64;
  }
  switch (parsed.positionals[0]) {
    case 'dry-run':
      console.log(await dryRun(v4Home, target));
      return 0;
    case 'prepare': {
      const done = await prepare({ v4Home, target, lock: hostLockProbe(), now: () => new Date() });
      console.log(done.summary);
      console.log(
        `copied while v4 was running: ${done.changedWhileCopying.length} file(s) changed between the two passes`,
      );
      for (const path of done.changedWhileCopying) console.log(`  changed: ${path}`);
      console.log(
        done.proof.unchanged
          ? 'v4 proof: unchanged'
          : `v4 proof: DIFFERENT\n${done.proof.changed.map(p => `  ${p}`).join('\n')}`,
      );
      return done.report?.complete === true && done.proof.unchanged ? 0 : 3;
    }
    case 'wrapper': {
      await mkdir(join(target, 'bin'), { recursive: true, mode: 0o700 });
      const path = join(target, 'bin', PREVIEW.wrapper);
      await writeFile(path, wrapperText(target), { mode: 0o755 });
      await chmod(path, 0o755);
      console.log(`wrote ${path}`);
      return 0;
    }
    default:
      console.error(USAGE);
      return 64;
  }
}

process.exitCode = await main(process.argv.slice(2));
