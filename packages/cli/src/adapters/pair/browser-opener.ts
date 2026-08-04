import { spawn } from 'node:child_process';

import type { IBrowserOpener } from '../../lib/pair/ports.ts';

/**
 * Hands a URL to the desktop's own "open this" command.
 *
 * THERE IS NO CROSS-PLATFORM API FOR THIS, so there is a per-platform launcher
 * and nothing clever: macOS has `open`, Linux desktops have `xdg-open`, Windows
 * reaches it through `cmd /c start`. No dependency for three lines of table, and
 * no shell — the URL is passed as an argument, never interpolated into a command
 * string, so a link cannot become a command however it was minted.
 *
 * IT IS DETACHED AND ITS OUTPUT IS THROWN AWAY. A browser launched from a
 * terminal outlives the terminal, and `fy pair` then stays for two minutes
 * watching for the scan — a child holding the event loop or writing over the
 * countdown would break both. `unref` is what lets this process exit when its
 * own work is done rather than waiting on a browser somebody may leave open all
 * day.
 *
 * FAILURE IS A `false`, NOT A THROW. Every reason this fails is an ordinary
 * place to run the command: a headless server, an SSH session, a container, a
 * desktop with no handler registered. The QR and the link are already on the
 * screen, so the caller has something true to say; an exception would turn a
 * fallback into an error report.
 *
 * WHAT IT DOES NOT CLAIM: that a browser actually rendered anything. A zero exit
 * from `xdg-open` means the handler was invoked, not that a window appeared, and
 * this reports exactly that much.
 */

/** The launcher for a platform, or nothing when this host has no documented one. */
const launcher = (platform: string): { readonly command: string; readonly leading: readonly string[] } | undefined => {
  if (platform === 'darwin') return { command: 'open', leading: [] };
  /*
   * `start` is a `cmd` builtin rather than an executable, and its FIRST quoted
   * argument is taken as the new window's title. The empty string is that title
   * — without it, a quoted URL would be swallowed as one and nothing would open.
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
}

export class DesktopBrowserOpener implements IBrowserOpener {
  constructor(private readonly environment: BrowserOpenerEnvironment) {}

  async open(url: string): Promise<boolean> {
    const target = launcher(this.environment.platform);
    if (target === undefined) return false;
    try {
      const child = this.environment.spawn(target.command, [...target.leading, url], {
        detached: true,
        stdio: 'ignore',
      });
      /*
       * A launcher that is not installed fails ASYNCHRONOUSLY — `spawn` returns a
       * child and then emits `error`. Unhandled, that is a process-killing event
       * on a host whose only sin is having no `xdg-open`, so it is swallowed
       * here; the caller has already been told this may not work.
       */
      child.on('error', () => undefined);
      child.unref();
      return true;
    } catch {
      return false;
    }
  }
}

/** The shipped opener, bound to this host. */
export const desktopBrowserOpener = (): IBrowserOpener =>
  new DesktopBrowserOpener({ platform: process.platform, spawn });
