import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keeper, type Keeper } from './job-keeper.ts';
import { waitForValue } from './wait-for.ts';

/** Whether the process is a live one (a zombie waiting to be reaped is already dead). */
export const alive = async (pid: number): Promise<boolean> => {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  return stat !== '' && !/\) [ZX] /u.test(stat);
};

/** A `pgrep` that takes 0.4 s, the way every process lookup does on a loaded host: the wrapper must not depend on its speed. */
async function slowPgrepPath(folder: string): Promise<string> {
  const real = Bun.which('pgrep');
  if (real === null) throw new Error('pgrep is required for the slow-host job coverage');
  const bin = join(folder, 'slow-bin');
  await mkdir(bin);
  await writeFile(join(bin, 'pgrep'), `#!/bin/sh\nsleep 0.4\nexec ${real} "$@"\n`, { mode: 0o755 });
  return `${bin}:${process.env.PATH ?? ''}`;
}

/** One level of a tree: ignores TERM and HUP, records its pid, starts the next level, and waits for it. */
export const level = (pids: string, next: string | undefined): string =>
  `trap '' TERM HUP\necho $$ >> ${pids}\n${next === undefined ? 'while :; do sleep 1; done' : `/bin/sh ${next} &\nwait`}\n`;

export interface TreeStop {
  readonly stoppedState: string;
  readonly exitCode: number | undefined;
  readonly tookMs: number;
  /** The three descendants' pids. */
  readonly tree: readonly number[];
  /** Which of them were still alive the first time `exit.json` could be read. */
  readonly aliveAtExit: readonly number[];
  /** Which of them are alive once `stop` returned. */
  readonly aliveAfter: readonly number[];
  /** The tmux commands that took a session down: the service's fallback is the only thing that sends one. */
  readonly killSessions: readonly (readonly string[])[];
}

/**
 * The slow-host scenario of the job stop: the job shell dies on TERM and three plain descendants (no setsid, no double fork)
 * ignore TERM and HUP, on a host where every `pgrep` takes 0.4 s. Runs the real JobService on a private tmux server.
 */
export async function stopThreeDeepTree(kept: Keeper[], homes: string[]): Promise<TreeStop> {
  const probe = await mkdtemp(join(tmpdir(), 'fy-slow-'));
  homes.push(probe);
  const one = await keeper({ environment: { PATH: await slowPgrepPath(probe) }, realProof: true });
  kept.push(one);
  const issued: string[][] = [];
  const execute = one.tmux.execute.bind(one.tmux);
  one.tmux.execute = async (arguments_, stdin) => {
    // The adapter calls itself with a script and its stdin: the spy must hand both on.
    if (stdin === undefined) issued.push([...arguments_]);
    return await execute(arguments_, stdin);
  };
  const jobs = one.service();
  const pids = join(one.home, 'pids');
  await writeFile(join(one.home, 'l1.sh'), level(pids, join(one.home, 'l2.sh')));
  await writeFile(join(one.home, 'l2.sh'), level(pids, join(one.home, 'l3.sh')));
  await writeFile(join(one.home, 'l3.sh'), level(pids, undefined));
  const job = await jobs.start('ferret-a', { command: `/bin/sh ${join(one.home, 'l1.sh')} & wait` }, { by: 'person' });
  const tree = await waitForValue(async () => {
    const found = (await readFile(pids, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number);
    return found.length === 3 ? found : undefined;
  }, 'the three levels');
  const exitFile = join(one.home, 'jobs', 'ferret-a', job.id, 'exit.json');
  const aliveAtExit = (async () => {
    for (;;) {
      if (await Bun.file(exitFile).exists())
        return (await Promise.all(tree.map(async pid => ((await alive(pid)) ? pid : 0)))).filter(Boolean);
      await Bun.sleep(5);
    }
  })();
  try {
    const began = performance.now();
    const stopped = await jobs.stop('ferret-a', job.id);
    const tookMs = performance.now() - began;
    return {
      stoppedState: stopped.state,
      exitCode: stopped.exitCode,
      tookMs,
      tree,
      aliveAtExit: await aliveAtExit,
      aliveAfter: (await Promise.all(tree.map(async pid => ((await alive(pid)) ? pid : 0)))).filter(Boolean),
      killSessions: issued.filter(command => command[0] === 'kill-session'),
    };
  } finally {
    for (const pid of tree) if (await alive(pid)) process.kill(pid, 'SIGKILL');
  }
}
