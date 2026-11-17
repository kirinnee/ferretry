import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** What a v4 `terminal-pane.json` states about a ferret's pane: the whole identity v4's own reaper checks. */
export interface V4PaneClaim {
  readonly paneId: string;
  readonly tmuxSession: string;
  readonly pid: number;
  readonly processStartTicks: number;
}

/**
 * Is the pane a v4 record names provably live NOW? The proof is v4's `ExactTmuxPaneReaper`'s: the pane id, the session
 * that owns it, the pane's pid, and that pid's start (which tells a reused pid apart), every one as v4 recorded it. A
 * pane id alone proves nothing: ids restart at `%0` on a new tmux server (a slot taken down and up, a reboot), so a stale
 * `%N` names whatever pane some other ferret launched since. Never throws: a mismatch, or anything that cannot be
 * read, is "not live".
 */
export type PaneLive = (pane: V4PaneClaim, v4Home: string) => Promise<boolean>;

const run = (file: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string | undefined> =>
  new Promise(resolve => {
    execFile(
      file,
      [...args],
      { timeout: 5000, windowsHide: true, ...(env === undefined ? {} : { env: { ...process.env, ...env } }) },
      (error, stdout) => resolve(error === null ? stdout.trim() : undefined),
    );
  });

const positive = (value: number): number | undefined => (Number.isSafeInteger(value) && value > 0 ? value : undefined);

/** Field 22 of `/proc/<pid>/stat`, counted after the parenthesised command name (which may hold spaces). */
const linuxStartTicks = async (pid: number): Promise<number | undefined> => {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
  const close = text?.lastIndexOf(')') ?? -1;
  if (text === undefined || close < 1) return undefined;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  return fields.length < 20 ? undefined : positive(Number(fields[19]));
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** macOS: `ps -o lstart=` under `LC_ALL=C TZ=UTC0` (`Sat Sep  6 18:48:09 2026`) as epoch seconds, as v4 recorded it. */
const darwinStartSeconds = async (pid: number): Promise<number | undefined> => {
  const text = await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { LC_ALL: 'C', TZ: 'UTC0' });
  const match = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/u.exec(text ?? '');
  if (match === null) return undefined;
  const [, month, day, hour, minute, second, year] = match;
  const index = MONTHS.indexOf(month ?? '');
  return index < 0
    ? undefined
    : positive(Date.UTC(Number(year), index, Number(day), Number(hour), Number(minute), Number(second)) / 1000);
};

const startOf = (pid: number): Promise<number | undefined> =>
  process.platform === 'linux'
    ? linuxStartTicks(pid)
    : process.platform === 'darwin'
      ? darwinStartSeconds(pid)
      : Promise.resolve(undefined);

/**
 * The real, read-only probe: ask the tmux server v4 recorded (`<home>/tmux.sock`) for the pane and its owner, and the
 * kernel for the pid's start. It never falls back to the default tmux server, which could be anyone's. No socket, a
 * tmux that fails or is absent, an unknown pane, another session, another pid or another start all read as not live.
 */
export const tmuxPaneLive: PaneLive = async (pane, v4Home) => {
  if (!(pane.pid > 1) || !(pane.processStartTicks > 0)) return false;
  const socket = join(v4Home, 'tmux.sock');
  const info = await lstat(socket).catch(() => undefined);
  if (info === undefined || !info.isSocket()) return false;
  const seen = await run('tmux', [
    '-S',
    socket,
    'display-message',
    '-p',
    '-t',
    pane.paneId,
    '#{pane_id}|#{pane_pid}|#{session_name}',
  ]);
  const match = /^(%\d+)\|(\d+)\|(.+)$/u.exec(seen ?? '');
  if (match === null) return false;
  if (match[1] !== pane.paneId || Number(match[2]) !== pane.pid || match[3] !== pane.tmuxSession) return false;
  return (await startOf(pane.pid)) === pane.processStartTicks;
};
