import { afterEach, describe, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnPort, SpawnResult } from '@ferretry/kernel/contract';
import should from 'should';
import type { KeptJob } from '../../../../contract/job-keeping.ts';
import {
  KernelProcessProbe,
  PaneProcessInventory,
  type ProcessHostFacts,
} from '../../../../daemon/adapters/moves/process-inventory.ts';
import { restartInPlace } from '../../../../daemon/modules/restart-in-place.ts';
import { detachAttachments } from '../../../../daemon/lib/moves/detach-attachments.ts';
import { jobsHandover, runJobBackstop } from '../../../../daemon/lib/moves/jobs-handover.ts';
import { MovePreflight } from '../../../../daemon/lib/moves/preflight-service.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../../../daemon/lib/session/peers/tmux-lifecycle.ts';

/**
 * A kept job survives a move, on a REAL tmux (a private socket, `tmux -L <unique>`) and real processes: a stand-in harness
 * whose tool shells are shaped like Claude Code's own (the wrapper, the `tasks/<id>.output` stdout), one holding an
 * attachment to a job the keeper runs in its own tmux session and one running a background command nobody keeps.
 *
 * The keeper is a small stand-in over the same host (the real one is covered in Terminals' own integration tests, where
 * `fy job attach` really exits 75): what is proven HERE is the move's side — the gate, the detach before the kill, the
 * hand-over and the completion backstop — against processes that really exist.
 */
const live: Array<() => void> = [];
afterEach(() => {
  for (const undo of live.splice(0).reverse()) undo();
});

const sleep = async (ms: number) => await new Promise<void>(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T | undefined> | T | undefined, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const realSpawn: Pick<SpawnPort, 'run'> = {
  run: async (program, args): Promise<SpawnResult> => {
    const child = Bun.spawn([Bun.which(program) ?? program, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, signal: null, stdout, stderr };
  },
};
const host: ProcessHostFacts = {
  platform: 'linux',
  procFile: async (pid, file) => await readFile(`/proc/${pid}/${file}`, 'utf8'),
  procSystemFile: async file => await readFile(`/proc/${file}`, 'utf8'),
  procTasks: async pid => await readdir(`/proc/${pid}/task`),
  procTaskChildren: async (pid, task) => await readFile(`/proc/${pid}/task/${task}/children`, 'utf8'),
  procFds: async pid => await readdir(`/proc/${pid}/fd`),
  procFdLink: async (pid, fd) => await readlink(`/proc/${pid}/fd/${fd}`),
  procWorkingDirectory: async pid => await readlink(`/proc/${pid}/cwd`),
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Everything the test builds: a folder, a private tmux, the stand-in harness and the job. */
async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'fy-move-'));
  const socket = `fy-move-${process.pid}-${Date.now()}`;
  live.push(() => {
    Bun.spawnSync(['tmux', '-L', socket, 'kill-server']);
    rmSync(dir, { recursive: true, force: true });
  });
  const tmux = (...args: string[]): TmuxCommandResult => {
    const run = Bun.spawnSync(['tmux', '-L', socket, '-f', '/dev/null', ...args]);
    return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
  };
  const port: TmuxCommandPort = { execute: async args => tmux(...args) };

  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'tasks'));
  mkdirSync(join(dir, '.claude', 'shell-snapshots'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'shell-snapshots', 's.sh'), '');
  symlinkSync(Bun.which('bash') ?? '/bin/bash', join(dir, 'bin', 'zsh'));
  const events = join(dir, 'events.log');
  // The attachment: on SIGTERM it says it detached and exits 75, as `fy job attach` does.
  writeFileSync(
    join(dir, 'fy.ts'),
    `import { appendFileSync } from 'node:fs';
process.on('SIGTERM', () => { appendFileSync(${JSON.stringify(events)}, 'attachment detached ' + Date.now() + '\\n'); process.exit(75); });
setInterval(() => undefined, 1000);
`,
  );
  const wrapper = (command: string): string =>
    `source ${dir}/.claude/shell-snapshots/s.sh 2>/dev/null || true && eval '${command}' < /dev/null && pwd -P >| ${dir}/claude-1a2b-cwd`;
  // The stand-in harness: two tool shells shaped like Claude Code's, each with its stdout in tasks/<id>.output.
  writeFileSync(
    join(dir, 'claude.ts'),
    `import { appendFileSync, openSync } from 'node:fs';
const shell = (id: string, command: string) => {
  const out = openSync(${JSON.stringify(join(dir, 'tasks'))} + '/' + id + '.output', 'w');
  const child = Bun.spawn([${JSON.stringify(join(dir, 'bin', 'zsh'))}, '-c', ${JSON.stringify(wrapper('\u0000'))}.replace('\\u0000', command)], { stdout: out, stderr: out, stdin: 'ignore' });
  child.exited.then(code => appendFileSync(${JSON.stringify(events)}, 'shell ' + id + ' exited ' + code + ' ' + Date.now() + '\\n'));
};
shell('t-attach', 'bun ${dir}/fy.ts job attach abc123abc123');
shell('t-background', 'sleep 300');
setInterval(() => undefined, 1000);
`,
  );
  chmodSync(join(dir, 'claude.ts'), 0o644);
  const bun = Bun.which('bun') ?? 'bun';
  const started = tmux('new-session', '-d', '-s', 'ferret', '-x', '200', '-y', '50', `${bun} ${dir}/claude.ts`);
  if (started.code !== 0) throw new Error(`tmux refused: ${started.stderr}`);
  // The keeper's job: its own tmux session, which a kill of the ferret's pane does not reach.
  const jobStart = tmux('new-session', '-d', '-s', 'job-build', 'sleep 300');
  if (jobStart.code !== 0) throw new Error(`tmux refused the job: ${jobStart.stderr}`);
  const jobPid = Number(tmux('display-message', '-p', '-t', 'job-build', '#{pane_pid}').stdout.trim());
  const probe = new KernelProcessProbe(realSpawn, host, { nowMs: () => Date.now() });
  const panePid = Number(tmux('display-message', '-p', '-t', 'ferret', '#{pane_pid}').stdout.trim());
  const rows = async () => (await probe.descendants(panePid)) ?? [];
  const attachmentPid = await until(
    async () =>
      (await rows()).find(row => row.argv.startsWith('bun ') && row.argv.endsWith('fy.ts job attach abc123abc123'))
        ?.pid,
    'the attachment process',
  );
  await until(
    async () => ((await rows()).some(row => row.argv.includes('sleep 300')) ? true : undefined),
    'the background job',
  );
  return { dir, tmux, port, probe, events, jobPid, attachmentPid, panePid };
}

const JOB: KeptJob = {
  id: 'abc123abc123',
  name: 'build',
  state: 'running',
  startedAt: new Date(Date.now() - 125_000).toISOString(),
  unreported: false,
};

describe('a move with a kept job, on a real tmux', () => {
  it('should know the attachment, name the un-kept background job, detach before the kill and leave the job running', async () => {
    // Arrange
    const w = await world();
    let attachmentPids: number[] = [w.attachmentPid];
    const keeper = {
      attachments: async () => attachmentPids.filter(alive).map(pid => ({ pid, jobId: JOB.id, jobName: JOB.name })),
      // The keeper's detach: the attachment is asked to let go; it prints and exits 75.
      detach: async () => {
        for (const pid of attachmentPids) process.kill(pid, 'SIGTERM');
        return attachmentPids.length;
      },
      jobs: async () => [{ ...JOB, state: alive(w.jobPid) ? ('running' as const) : ('exited' as const), exitCode: 0 }],
    };
    const inventory = new PaneProcessInventory(w.probe, {
      binaryName: 'fy',
      toolsServerArguments: ['mcp', 'serve'],
      statuslineSubcommand: 'statusline',
      servers: { read: async () => [] },
      attachments: async () => await keeper.attachments(),
    });
    const preflight = new MovePreflight(inventory);

    // Act — the gate looks at the pane, mid-turn. PRODUCTION SHAPE: the state records no open tool calls (`undefined`), so the
    // shell Claude wrote its stdout to `tasks/<id>.output` for may be a foreground call and is NOT called a background job.
    const look = async (openTools: readonly string[] | undefined) =>
      await preflight.inspect({
        sessionId: 'ferret-a',
        harness: 'claude',
        // The ferret's pane, as its runner names it: the root process the stand-in harness runs under.
        pane: { identify: async () => ({ handle: 'pane-1' as never, pid: w.panePid }), screen: async () => undefined },
        status: 'running',
        turnState: 'working',
        turn: 3,
        openTools,
      });
    const report = await look(undefined);
    const card = preflight.describe(report);

    // Assert — the card names both
    const kept = card.items.find(item => item.title.startsWith('attachment to job build'));
    should(kept).be.ok();
    should(kept?.title).equal('attachment to job build (kept; re-attach after the move)');
    should(kept?.blocks).be.false();
    should(card.items.some(item => item.title.includes('a background job Ferretry is not keeping'))).be.false();
    const neutral = card.items.find(item => item.title.startsWith('sleep 300 — '));
    should(neutral?.title).equal('sleep 300 — a command the agent is running; it stops when the ferret moves.');
    // The state DOES record its open tools and none is open: now the same shell is positively a background job.
    const recorded = await look([]);
    const recordedCard = preflight.describe(recorded);
    const unkept = recordedCard.items.find(item => item.title.includes('a background job Ferretry is not keeping'));
    should(unkept?.title).startWith('sleep 300 — a background job Ferretry is not keeping');
    should(unkept?.title).endWith('Start long jobs with `fy job run` so they survive.');
    should(
      preflight.document(recorded, {
        sessionId: 'ferret-a',
        targetAgent: 'x',
        forced: false,
        at: '2026-11-16T00:00:00Z',
      }),
    ).containEql('### Background jobs Ferretry is not keeping');

    // Act — the move: detach first, THEN the kill
    const gone = await detachAttachments(keeper, 'ferret-a', {
      sleep,
      nowMs: () => Date.now(),
      log: { warn: () => undefined },
    });
    const detachedAt = Date.now();
    const log = readFileSync(w.events, 'utf8');
    w.tmux('kill-session', '-t', 'ferret');
    await until(() => (alive(w.attachmentPid) ? undefined : true), 'the ferret’s processes to end');
    const handover = jobsHandover(await keeper.jobs(), recorded, Date.now());
    const unrecorded = jobsHandover(await keeper.jobs(), report, Date.now());

    // Assert — the attachment exited 75 before the kill, and the job never noticed
    should(gone).be.true();
    should(log).containEql('attachment detached');
    should(log).containEql('shell t-attach exited 75');
    should(Number(/attachment detached (\d+)/u.exec(log)?.[1])).be.belowOrEqual(detachedAt);
    should(alive(w.jobPid)).be.true();
    should(handover).containEql('re-attach: run `fy job attach abc123abc123` as a background Bash');
    should(handover).containEql('- `sleep 300`: re-run it with `fy job run …` if you still need it');
    // an unrecorded foreground shell is never listed as a stopped background job, nor does the section say nothing was stopped
    should(unrecorded).not.containEql('sleep 300');
    should(unrecorded).not.match(/nothing was stopped/iu);
    attachmentPids = [];
  }, 60_000);

  it('should send the completion backstop exactly once when the job ends with nobody attached', async () => {
    // Arrange
    const w = await world();
    w.tmux('kill-session', '-t', 'ferret');
    const told = new Set<string>();
    const queue: string[] = [];
    const ports = {
      keeper: {
        backstopCutOver: async () => 0,
        endedUnattached: async () =>
          alive(w.jobPid) || told.has(JOB.id)
            ? []
            : [{ ferret: 'ferret-a', job: { ...JOB, state: 'exited' as const, exitCode: 0, unreported: true } }],
        markReported: async (_ferret: string, ids: readonly string[]) => {
          for (const id of ids) told.add(id);
        },
      },
      askAgent: async (_ferret: string, message: { id: string; text: string }) => {
        if (queue.includes(message.id)) return false;
        queue.push(message.id);
        return true;
      },
      log: { warn: () => undefined },
    };

    // Act — the job is still running: nothing to say. It ends: one message, however often the sweep runs.
    const early = await runJobBackstop(ports);
    process.kill(w.jobPid, 'SIGKILL');
    await until(() => (alive(w.jobPid) ? undefined : true), 'the job to end');
    const first = await runJobBackstop(ports);
    const again = await runJobBackstop(ports);

    // Assert
    should([early, first, again]).deepEqual([0, 1, 0]);
    should(queue).deepEqual(['job-ended-abc123abc123']);
  }, 60_000);
  it('should do all of it through the REAL Restart CLI path: detach before the kill, the job kept, "Your jobs" in the new session’s first message, then marked told', async () => {
    // Arrange — the gate, the restart and the keeper's side are the real ones; the relaunch kills the pane as the runner does.
    const w = await world();
    const finished: KeptJob = {
      id: 'fin123fin123',
      name: 'lint',
      state: 'exited',
      exitCode: 4,
      startedAt: JOB.startedAt,
      unreported: true,
    };
    const calls: string[] = [];
    const told: string[] = [];
    const attachmentPids = [w.attachmentPid];
    const keeper = {
      attachments: async () => attachmentPids.filter(alive).map(pid => ({ pid, jobId: JOB.id, jobName: JOB.name })),
      detach: async () => {
        calls.push('detach');
        for (const pid of attachmentPids) process.kill(pid, 'SIGTERM');
        return attachmentPids.length;
      },
      jobs: async () => [{ ...JOB }, finished],
      markReported: async (_ferret: string, ids: readonly string[]) => {
        calls.push('markReported');
        told.push(...ids);
      },
    };
    const preflight = new MovePreflight(
      new PaneProcessInventory(w.probe, {
        binaryName: 'fy',
        toolsServerArguments: ['mcp', 'serve'],
        statuslineSubcommand: 'statusline',
        servers: { read: async () => [] },
        attachments: async () => await keeper.attachments(),
      }),
    );
    let message: string | undefined;
    let attachmentGoneAtKill: boolean | undefined;
    let logAtKill = '';
    const ctx = {
      storage: { append: async () => undefined, updateConfig: async () => undefined },
      clock: { now: () => '2026-11-16T00:00:00.000Z' },
      reports: { write: async () => '/state/move-inflight.md', append: async () => undefined },
      preflight,
      restart: {
        record: () => ({ runtime: 'rt', handle: 'pane-1' }),
        relaunch: async (request: { message: string | undefined }) => {
          // The kill: by now the attachment must already have exited 75 and the job must be untouched.
          attachmentGoneAtKill = !alive(w.attachmentPid);
          logAtKill = readFileSync(w.events, 'utf8');
          calls.push('relaunch');
          message = request.message;
          w.tmux('kill-session', '-t', 'ferret');
          return { disposition: 'revived' };
        },
      },
      jobs: { keeper: () => keeper, sleep, nowMs: () => Date.now(), log: { warn: () => undefined } },
      paneIdentity: async () => 'pane-1',
      inspect: async () =>
        await preflight.inspect({
          sessionId: 'ferret-a',
          harness: 'claude',
          pane: {
            identify: async () => ({ handle: 'pane-1' as never, pid: w.panePid }),
            screen: async () => undefined,
          },
          status: 'running',
          turnState: 'working',
          turn: 3,
          openTools: undefined,
        }),
      refused: async () => undefined,
      view: async () => ({}) as never,
      observed: async () => undefined,
    };

    // Act
    await restartInPlace(
      ctx as never,
      'ferret-a' as never,
      { agent: 'rt', origin: 'owner', movedBy: 'owner' } as never,
      { runtimeGeneration: 0, mode: 'auto' } as never,
    );

    // Assert — the attachment let go (exit 75) BEFORE the relaunch killed the pane; the job lives on
    should(calls).deepEqual(['detach', 'relaunch', 'markReported']);
    should(attachmentGoneAtKill).be.true();
    should(logAtKill).containEql('shell t-attach exited 75');
    should(alive(w.jobPid)).be.true();
    // the new session's turn message carries the section with the exact re-attach line, and what finished
    should(message).containEql('Your jobs');
    should(message).containEql('re-attach: run `fy job attach abc123abc123` as a background Bash');
    should(message).containEql('- `lint` (id fin123fin123) ended with exit code 4; `fy job logs fin123fin123`');
    // only what the message told is recorded as told, and only after the relaunch revived
    should(told).deepEqual([finished.id]);
  }, 60_000);
});
