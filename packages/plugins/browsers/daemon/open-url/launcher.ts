import type { SpawnPort } from '@ferretry/kernel/contract';
import type { DetachedLauncherPort, OpenerCommand } from './service.ts';

/**
 * The only names of the daemon's environment the opener is given (lead ruling, guarantees-reown r2). An opener decides
 * which browser to open from the desktop session (`DISPLAY`, `WAYLAND_DISPLAY`, `XDG_*`, `DBUS_SESSION_BUS_ADDRESS`,
 * `BROWSER`) and how to speak from the locale; anything else the daemon holds (a token, `FY_HOME`) never reaches it.
 * Every `LC_*` name is allowed as well, and only the names that are present are passed.
 */
export const OPENER_ENVIRONMENT_NAMES = [
  'PATH',
  'HOME',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'XDG_CURRENT_DESKTOP',
  'XDG_SESSION_TYPE',
  'DBUS_SESSION_BUS_ADDRESS',
  'BROWSER',
  'LANG',
] as const;

/** The allow-listed, defined entries of `source`, and nothing else. */
export function openerEnvironment(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const allowed = new Set<string>(OPENER_ENVIRONMENT_NAMES);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source))
    if (value !== undefined && (allowed.has(name) || name.startsWith('LC_'))) result[name] = value;
  return result;
}

/**
 * Starting the operating system's opener and letting go of it (today's `BunDetachedLauncher`), through `kernel.spawn`
 * under the names `permissions.spawn` declares.
 *
 * NO SHELL: the command and its arguments are a vector. NO OUTPUT KEPT: both streams are read and dropped, so a chatty
 * opener cannot fill a pipe (nor be killed by a closed one) and a page's address cannot come back out through a log.
 * Nothing waits for the child. A program that cannot be started (`xdg-open` not installed) is the only failure
 * reported; whether the browser then shows the page is the opener's business.
 */
export class KernelDetachedLauncher implements DetachedLauncherPort {
  private readonly environment: Readonly<Record<string, string>>;

  /** `environment` is the daemon's own; only {@link OPENER_ENVIRONMENT_NAMES} (and `LC_*`) of it reach the opener. */
  constructor(
    private readonly spawn: Pick<SpawnPort, 'start'>,
    environment: Readonly<Record<string, string | undefined>>,
  ) {
    this.environment = openerEnvironment(environment);
  }

  async launch(command: OpenerCommand): Promise<void> {
    // An empty stdin is written and ended, so an opener that falls back to a text browser never waits on a pipe.
    const child = this.spawn.start(command.command, command.args, { env: this.environment, stdin: new Uint8Array() });
    for (const stream of [child.stdout, child.stderr]) void drop(stream);
    void child.exited.catch(() => undefined);
    await Promise.resolve();
  }
}

async function drop(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done);
  } catch {
    // The child is gone; nothing was wanted from it.
  }
}
