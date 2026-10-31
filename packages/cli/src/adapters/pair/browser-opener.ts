import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IBrowserOpener } from '../../lib/pair/ports.ts';
import { renderPairingRedirectPage } from '../../lib/pair/redirect-page.ts';

/**
 * Hands a pairing link to the desktop's own "open this" command — WITHOUT PUTTING IT IN ANY ARGV.
 *
 * THE LINK IS A LIVE CREDENTIAL. Its fragment carries the pairing code, and a command-line argument is
 * world-readable on a shared host (`/proc/<pid>/cmdline` on Linux, `ps` elsewhere) — for this process,
 * for `xdg-open`, and for the browser it starts. So the launcher is never given the link. It is given
 * the path of a page this adapter just wrote, whose one script replaces itself with the link
 * (`renderPairingRedirectPage`); a path carries nothing worth reading.
 *
 * THE PAGE IS PRIVATE AND SHORT-LIVED, because it holds the code for as long as it exists. It is made
 * inside a fresh `0700` directory under the user's state home — never the shared `/tmp`, where a
 * neighbour could pre-create the name or watch the directory — and written `0600` with `O_EXCL`, so it
 * is either ours or the write fails. It is deleted `retentionMs` after the launcher was started, and
 * also when this process exits or is told to stop. That is the contract `docs/pairing.md` states: the
 * code is never persisted beyond the seconds a browser needs to read the page.
 *
 * THE TIMER KEEPS THE PROCESS ALIVE ON PURPOSE. `fy pair --no-wait` would otherwise exit the moment
 * the launcher started and take the page with it before a cold browser had read it. Waiting a few
 * seconds is the price of the browser actually arriving.
 *
 * There is no cross-platform API for the launcher itself, so there is a per-platform one and nothing
 * clever: macOS has `open`, Linux desktops have `xdg-open`, Windows reaches it through `cmd /c start`.
 * No shell is involved — the path is passed as an argument, never interpolated into a command string.
 *
 * IT IS DETACHED AND ITS OUTPUT IS THROWN AWAY. A browser launched from a terminal outlives the
 * terminal, and `fy pair` then stays for two minutes watching for the scan — a child holding the event
 * loop or writing over the countdown would break both. `unref` is what lets this process exit when its
 * own work is done rather than waiting on a browser somebody may leave open all day.
 *
 * FAILURE IS A `false`, NOT A THROW. Every reason this fails is an ordinary place to run the command: a
 * headless server, an SSH session, a container, a desktop with no handler registered, a state home
 * that cannot be written. The QR and the link are already on the screen, so the caller has something
 * true to say; an exception would turn a fallback into an error report.
 *
 * WHAT IT DOES NOT CLAIM: that a browser actually rendered anything. A zero exit from `xdg-open` means
 * the handler was invoked, not that a window appeared, and this reports exactly that much.
 */

/**
 * How long the page outlives the launcher.
 *
 * Long enough for a browser that is not running yet to start and read a local file, short enough that
 * the code is on disk for a fraction of its own two-minute life.
 */
const REDIRECT_PAGE_LIFETIME_MS = 10_000;

/** The launcher for a platform, or nothing when this host has no documented one. */
const launcher = (platform: string): { readonly command: string; readonly leading: readonly string[] } | undefined => {
  if (platform === 'darwin') return { command: 'open', leading: [] };
  /*
   * `start` is a `cmd` builtin rather than an executable, and its FIRST quoted
   * argument is taken as the new window's title. The empty string is that title
   * — without it, a quoted path would be swallowed as one and nothing would open.
   */
  if (platform === 'win32') return { command: 'cmd', leading: ['/c', 'start', ''] };
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    return { command: 'xdg-open', leading: [] };
  }
  return undefined;
};

export interface BrowserOpenerEnvironment {
  /** `process.platform`, injected so every branch is provable on one host. */
  readonly platform: string;
  /** `spawn`, injected so no suite ever launches a real browser. */
  readonly spawn: typeof spawn;
  /** The user's state home, where the page's private directory is made — never a shared temp directory. */
  readonly stateHome: string;
  /** How long the page outlives the launcher. */
  readonly retentionMs: number;
  /** Runs `run` after `ms`, holding the process open until it has — injected so no suite waits on a clock. */
  readonly schedule: (run: () => void, ms: number) => void;
  /** Runs `run` when this process exits or is told to stop — injected so no suite touches `process`. */
  readonly onExit: (run: () => void) => void;
}

export class DesktopBrowserOpener implements IBrowserOpener {
  constructor(private readonly environment: BrowserOpenerEnvironment) {}

  async open(link: string): Promise<boolean> {
    const target = launcher(this.environment.platform);
    if (target === undefined) return false;
    let directory: string | undefined;
    const discard = (): void => {
      if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    };
    try {
      const page = renderPairingRedirectPage(link);
      directory = mkdtempSync(join(this.environment.stateHome, 'pair-open-'));
      const file = join(directory, 'pairing.html');
      writeFileSync(file, page, { flag: 'wx', mode: 0o600 });
      // Registered before the launcher starts, so there is no window in which the page exists unguarded.
      this.environment.onExit(discard);
      this.environment.schedule(discard, this.environment.retentionMs);
      const child = this.environment.spawn(target.command, [...target.leading, file], {
        detached: true,
        stdio: 'ignore',
      });
      /*
       * A launcher that is not installed fails ASYNCHRONOUSLY — `spawn` returns a
       * child and then emits `error`. Unhandled, that is a process-killing event
       * on a host whose only sin is having no `xdg-open`, so it is swallowed
       * here; the caller has already been told this may not work. The page has no
       * reader then, so it goes at once rather than waiting out its lifetime.
       */
      child.on('error', discard);
      child.unref();
      return true;
    } catch {
      discard();
      return false;
    }
  }
}

/** The part of `process` the exit hook touches, so a suite can answer it without ending the test runner. */
export interface ExitingProcess {
  once(event: 'exit' | 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  exit(code: number): never;
}

/**
 * Removes the page when the process is stopped, as well as when it ends by itself.
 *
 * A signal's default action ends the process without an `exit` event, so Ctrl-C mid-countdown would
 * leave the page behind; handling it here means catching it, which is why it then exits with the
 * conventional `128 + signal` status the default action would have produced.
 */
export const onProcessExit = (host: ExitingProcess, run: () => void): void => {
  host.once('exit', run);
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    host.once(signal, () => {
      run();
      host.exit(code);
    });
  }
};

/** Runs `run` after `ms`, on a timer that holds the process open — see the note on `--no-wait` above. */
export const holdProcessOpen = (run: () => void, ms: number): void => {
  setTimeout(run, ms);
};

/** The shipped opener, bound to this host and to the state home the daemon owns. */
export const desktopBrowserOpener = (stateHome: string): IBrowserOpener =>
  new DesktopBrowserOpener({
    platform: process.platform,
    spawn,
    stateHome,
    retentionMs: REDIRECT_PAGE_LIFETIME_MS,
    schedule: holdProcessOpen,
    onExit: onProcessExit.bind(undefined, process),
  });
