import { commandLabel, type PathRoots, pathShape, type SyscallTrace } from '@ferretry/protocol';

/**
 * WHAT AN OUTSIDE TRACER SAW, REDUCED TO A SHAREABLE TABLE.
 *
 * A process cannot trace its own system calls, and the daemon's own file ports see only the calls that
 * go through them. So `fy daemon profile --trace-syscalls` runs the platform's tracer over the same
 * window — `strace` on Linux, `fs_usage` on macOS — and this module folds its raw output into counts by
 * call and path SHAPE, plus the programs started by program and subcommand. The raw output, which
 * names every file and every argument, never leaves this function.
 */

/** How many call shapes a trace keeps. */
const TRACE_TOP = 40;

interface Tally {
  readonly calls: Map<string, number>;
  readonly executions: Map<string, number>;
  total: number;
}

function tally(): Tally {
  return { calls: new Map(), executions: new Map(), total: 0 };
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function finish(tool: SyscallTrace['tool'], seconds: number, counted: Tally): SyscallTrace {
  const perSecond = (count: number): number => Math.round((count / seconds) * 100) / 100;
  return {
    tool,
    seconds,
    total: counted.total,
    perSecond: perSecond(counted.total),
    top: [...counted.calls]
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .slice(0, TRACE_TOP)
      .map(([key, count]) => {
        const [call = '', path = ''] = key.split('\u0000');
        return { call, path, count, perSecond: perSecond(count) };
      }),
    executions: [...counted.executions]
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .map(([command, count]) => ({ command, count })),
  };
}

/** The quoted strings of an `strace` argument list, unescaped enough to name a path or an argument. */
function quoted(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map(match => (match[1] ?? '').replace(/\\(.)/gu, '$1'));
}

/**
 * `strace -f -qq -s 256 -e trace=%file,execve` output: `PID call(args) = result`, with a call split
 * across threads as `call(args <unfinished ...>` and later `<... call resumed>`. The call is counted
 * where it STARTS, because that line carries its arguments; resumptions, signals and exits are skipped.
 */
export function parseStraceTrace(text: string, seconds: number, roots: PathRoots): SyscallTrace {
  const counted = tally();
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^\[pid\s+\d+\]\s*/u, '')
      .replace(/^\d+\s+/u, '')
      .replace(/^\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+/u, '');
    const match = /^([a-z_][a-z0-9_]*)\((.*)$/u.exec(line);
    if (match === null) continue;
    const call = match[1] ?? '';
    const args = match[2] ?? '';
    counted.total += 1;
    if (call === 'execve') {
      const argv = /\[(.*?)\]/u.exec(args)?.[1];
      const [program] = quoted(args);
      bump(
        counted.executions,
        commandLabel(argv === undefined ? [program ?? ''] : [program ?? '', ...quoted(argv).slice(1)]),
      );
      continue;
    }
    const path = quoted(args)[0];
    bump(counted.calls, `${call}\u0000${path === undefined ? '<fd>' : pathShape(path, roots)}`);
  }
  return finish('strace', seconds, counted);
}

/**
 * `fs_usage -w -f filesys -f exec <pid>` output: `time  call  [F=fd] [(mode)]  [path]  elapsed  process`.
 * The path is the first field that starts with `/`; a call with none (`fstat64 F=4`) is counted on its
 * descriptor. An `execve` or `posix_spawn` names the program it started, and only the program.
 */
export function parseFsUsageTrace(text: string, seconds: number, roots: PathRoots): SyscallTrace {
  const counted = tally();
  for (const raw of text.split('\n')) {
    const fields = raw.trim().split(/\s+/u);
    if (fields.length < 3 || !/^\d{2}:\d{2}:\d{2}/u.test(fields[0] ?? '')) continue;
    const call = fields[1] ?? '';
    if (!/^[A-Za-z_][\w]*$/u.test(call)) continue;
    counted.total += 1;
    const path = fields.find(field => field.startsWith('/'));
    if (call === 'execve' || call === 'posix_spawn' || call === 'exec') {
      bump(counted.executions, commandLabel([path ?? '<unknown>']));
      continue;
    }
    bump(counted.calls, `${call}\u0000${path === undefined ? '<fd>' : pathShape(path, roots)}`);
  }
  return finish('fs_usage', seconds, counted);
}
