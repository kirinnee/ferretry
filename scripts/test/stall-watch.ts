#!/usr/bin/env bun
/**
 * Runs a test command and ends it, loudly, once it has printed nothing for `<seconds>`.
 *
 * WHY. Every test prints a line when it finishes, and none may run longer than the tier's per-test
 * `--timeout`. So a run that has said nothing for several times that budget is wedged: a test whose main
 * thread is stuck in a synchronous call (where its own timeout cannot fire, because the timer runs on
 * that thread), or a finished run that does not exit because something still holds the process open. On
 * 2026-10-29 the daemon integration group did the first, three runs in a row, and held each runner for
 * two hours saying nothing at all.
 *
 * WHAT IT SAYS. The last line the command printed (the test that was running or the summary it reached),
 * the command's live child processes, and every thread of every process in its tree with its state and
 * what it waits in — a `Worker` is a thread, so a test that hosts one shows it. With `gdb` on the PATH it
 * also prints every thread's stack. Then it kills the whole tree and exits 124.
 *
 * Usage: `stall-watch.ts <seconds> -- <command> [args...]` — exits with the command's own status otherwise.
 */
import { readdirSync, readFileSync } from 'node:fs';

const [limitArgument, separator, ...command] = process.argv.slice(2);
const limitSeconds = Number(limitArgument);
if (!Number.isFinite(limitSeconds) || limitSeconds <= 0 || separator !== '--' || command.length === 0) {
  process.stderr.write('usage: stall-watch.ts <seconds> -- <command> [args...]\n');
  process.exit(2);
}

const child = Bun.spawn(command, { stdin: 'inherit', stdout: 'pipe', stderr: 'pipe' });
let lastOutputMs = Date.now();
let lastLine = '';

async function relay(stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    lastOutputMs = Date.now();
    sink.write(chunk);
    const lines = decoder
      .decode(chunk, { stream: true })
      .split('\n')
      .filter(line => line.trim() !== '');
    lastLine = lines.at(-1) ?? lastLine;
  }
}

const read = (file: string): string => {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '?';
  }
};

/** `pid` and every process under it, parents first: just `pid` where there is no `/proc` (macOS). */
function tree(pid: number): number[] {
  const parents = new Map<number, number[]>();
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [pid];
  }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    // The parent is the field after the parenthesised name, which may itself hold spaces.
    const parent = Number(read(`/proc/${entry}/stat`).split(') ')[1]?.split(' ')[1]);
    parents.set(parent, [...(parents.get(parent) ?? []), Number(entry)]);
  }
  const found = [pid];
  for (let index = 0; index < found.length; index += 1) found.push(...(parents.get(found[index] as number) ?? []));
  return found;
}

/** What the wedged run looks like from outside, for the log: processes, then each one's threads. */
function describe(pids: readonly number[]): string {
  const lines: string[] = [];
  for (const pid of pids) {
    const argv = read(`/proc/${String(pid)}/cmdline`).replaceAll('\0', ' ');
    lines.push(`  process ${String(pid)}: ${argv.slice(0, 300)}`);
    let threads: string[] = [];
    try {
      threads = readdirSync(`/proc/${String(pid)}/task`);
    } catch {
      continue;
    }
    for (const tid of threads) {
      const base = `/proc/${String(pid)}/task/${tid}`;
      const state = read(`${base}/stat`).split(') ')[1]?.split(' ')[0] ?? '?';
      lines.push(`    thread ${tid} ${read(`${base}/comm`)} state=${state} wchan=${read(`${base}/wchan`)}`);
    }
  }
  return lines.join('\n');
}

/** Every thread's stack from `gdb`, when the runner has one. Its own deadline: a diagnosis must not hang. */
async function stacks(pid: number): Promise<string> {
  if (Bun.which('gdb') === null) return '  (no gdb on the PATH, so no stacks)';
  const gdb = Bun.spawn(['gdb', '-p', String(pid), '-batch', '-ex', 'thread apply all bt 30'], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  const [out, err] = await Promise.all([new Response(gdb.stdout).text(), new Response(gdb.stderr).text(), gdb.exited]);
  return `${out}\n${err}`.trim();
}

let stalled = false;
const watch = setInterval(() => {
  if (stalled || Date.now() - lastOutputMs < limitSeconds * 1000) return;
  stalled = true;
  void (async () => {
    const pids = tree(child.pid);
    process.stderr.write(
      [
        '',
        `❌ STALLED: ${command.join(' ')} printed nothing for ${String(limitSeconds)} s, so it is killed.`,
        '   A test is wedged on a synchronous call (its own timeout cannot fire) or the finished run does not exit.',
        `   Last line it printed: ${lastLine}`,
        '   Its processes and threads:',
        describe(pids),
        '   Stacks of the test process:',
        await stacks(child.pid),
        '',
      ].join('\n'),
    );
    for (const pid of pids.reverse()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  })();
}, 1000);

const [code] = await Promise.all([
  child.exited,
  relay(child.stdout, process.stdout),
  relay(child.stderr, process.stderr),
]);
clearInterval(watch);
process.exit(stalled ? 124 : code);
