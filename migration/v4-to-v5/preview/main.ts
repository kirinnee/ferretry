/**
 * bun migration/v4-to-v5/preview/main.ts <guard|dry-run|prepare|wrapper|start-checks|wait-serving|terminal-check|proof|clean|stop> [--v4 <home>] [--target <home>]
 *
 * `guard` prints the resolved preview home after refusing one that could reach v4. `dry-run` touches nothing.
 * `start-checks` asks the host two read-only questions with the preview's exact environments and exits non-zero when either
 * fails (see start-checks.ts). `wait-serving` waits (with a stated deadline) for the preview port's `GET /healthz` to answer
 * 200, the daemon's own "serving" (see wait-serving.ts). `prepare` makes the preview home (OWNER-run, after review). `wrapper` writes `<target>/bin/fy5` and the `fy`, `fyd` and `fyd-browser-worker` shims. `proof` compares v4 with the snapshot `prepare` took. `clean` removes a
 * marked preview home. `stop` SIGTERMs the process that holds the preview home's daemon lock. Nothing here starts a
 * daemon, a service or a terminal.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { hostLockProbe } from '../src/preflight.ts';
import { clearYamlLogSwitches } from '@ferretry/std/yaml';
import { cleanPreview, dryRun, PREVIEW_PROGRAMS, prepare, proofNow, shimText, wrapperText } from './driver.ts';
import { guardTarget } from './paths.ts';
import { PREVIEW } from './plan.ts';
import { realRun } from './real-run.ts';
import { startChecks, terminalCheck } from './start-checks.ts';
import { pidsHolding, stopPreview } from './stop.ts';
import { waitServing } from './wait-serving.ts';

const USAGE =
  'usage: bun preview/main.ts <guard|dry-run|prepare|wrapper|start-checks|wait-serving|terminal-check|proof|clean|stop> [--v4 <v4 home>] [--target <preview home>]';

async function main(argv: readonly string[]): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        v4: { type: 'string' };
        target: { type: 'string' };
        owner: { type: 'boolean' };
        'drop-uncarried': { type: 'boolean' };
      };
      allowPositionals: true;
    }>
  >;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        v4: { type: 'string' },
        target: { type: 'string' },
        owner: { type: 'boolean' },
        'drop-uncarried': { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 64;
  }
  let guarded: ReturnType<typeof guardTarget>;
  try {
    guarded = guardTarget(
      parsed.values.v4 ?? join(homedir(), '.ferretry'),
      parsed.values.target ?? join(homedir(), PREVIEW.homeFolder),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 64;
  }
  const { v4Home, target } = guarded;
  switch (parsed.positionals[0]) {
    case 'guard':
      console.log(`${v4Home}\n${target}`);
      return 0;
    case 'dry-run':
      console.log(
        await dryRun(v4Home, target, homedir(), { v4Given: parsed.values.v4, homeGiven: [process.env.HOME ?? ''] }),
      );
      return 0;
    case 'prepare': {
      const done = await prepare({
        v4Home,
        target,
        lock: hostLockProbe(),
        now: () => new Date(),
        ...(parsed.values.owner === true ? { owner: true } : {}),
        ...(parsed.values['drop-uncarried'] === true ? { dropUncarried: true } : {}),
        ...(parsed.values.v4 === undefined ? {} : { v4Given: parsed.values.v4 }),
      });
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
      if (done.proof.v4Wrote.length > 0)
        console.log(
          `v4 rewrote these credential files by itself while it ran (stat only, not counted as damage):\n${done.proof.v4Wrote.map(p => `  ${p}`).join('\n')}`,
        );
      return done.report?.complete === true && done.proof.unchanged && done.gate.length === 0 ? 0 : 3;
    }
    case 'wrapper': {
      await mkdir(join(target, 'bin'), { recursive: true, mode: 0o700 });
      const path = join(target, 'bin', PREVIEW.wrapper);
      await writeFile(path, wrapperText(target, v4Home), { mode: 0o755 });
      await chmod(path, 0o755);
      console.log(`wrote ${path}`);
      for (const name of PREVIEW_PROGRAMS) {
        const shim = join(target, 'bin', name);
        await writeFile(shim, shimText(target, name), { mode: 0o755 });
        await chmod(shim, 0o755);
        console.log(`wrote ${shim}`);
      }
      return 0;
    }
    case 'start-checks': {
      const done = await startChecks({ target, v4Home, callerEnv: process.env, run: realRun });
      for (const line of done.passed) console.log(`ok: ${line}`);
      for (const line of done.problems) console.error(line);
      return done.ok ? 0 : 1;
    }
    case 'wait-serving': {
      const done = await waitServing({
        port: PREVIEW.port,
        fetch: async (url, init) => await fetch(url, init),
        sleep: ms => Bun.sleep(ms),
        nowMs: () => Date.now(),
      });
      (done.ok ? console.log : console.error)(done.sentence);
      return done.ok ? 0 : 1;
    }
    case 'terminal-check': {
      const done = await terminalCheck({
        target,
        v4Home,
        callerEnv: process.env,
        run: realRun,
        sleep: ms => Bun.sleep(ms),
        readText: async path => {
          try {
            return await readFile(path, 'utf8');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
          }
        },
      });
      for (const line of done.passed) console.log(`ok: ${line}`);
      for (const line of done.problems) console.error(line);
      return done.ok ? 0 : 1;
    }
    case 'proof':
      try {
        const verdict = await proofNow(v4Home, target);
        console.log(
          verdict.unchanged
            ? 'v4 proof: unchanged since prepare'
            : `v4 proof: DIFFERENT since prepare (a config file you edited in v4 yourself also shows here)\n${verdict.changed.map(p => `  ${p}`).join('\n')}`,
        );
        if (verdict.v4Wrote.length > 0)
          console.log(
            `v4 rewrote these credential files by itself (stat only):\n${verdict.v4Wrote.map(p => `  ${p}`).join('\n')}`,
          );
        return verdict.unchanged ? 0 : 3;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    case 'clean':
      try {
        console.log(await cleanPreview(v4Home, target));
        return 0;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    case 'stop': {
      const done = await stopPreview(target, {
        holders: pidsHolding,
        kill: (pid, signal) => process.kill(pid, signal),
        sleep: ms => Bun.sleep(ms),
      });
      console.log(done.said);
      return done.stopped ? 0 : 1;
    }
    default:
      console.error(USAGE);
      return 64;
  }
}

clearYamlLogSwitches();
process.exitCode = await main(process.argv.slice(2));
