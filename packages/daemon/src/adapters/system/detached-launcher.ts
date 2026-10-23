import type { DetachedLauncherPort, OpenerCommand } from '../../lib/system/open-url.ts';

/**
 * Starting the operating system's opener and letting go of it.
 *
 * NO SHELL: the command and its arguments are a vector. NO OUTPUT: all three streams are ignored, so
 * a chatty opener cannot fill a pipe and a page's address cannot come back out through a log. THE
 * CHILD IS DETACHED AND UNREFERENCED, so it outlives neither a daemon restart's wait nor the request.
 * A program that cannot be started (`xdg-open` not installed) is the only failure reported; whether
 * the browser then shows the page is the opener's business.
 */
export class BunDetachedLauncher implements DetachedLauncherPort {
  async launch(command: OpenerCommand): Promise<void> {
    const child = Bun.spawn([command.command, ...command.args], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      detached: true,
    });
    child.unref();
    await Promise.resolve();
  }
}
