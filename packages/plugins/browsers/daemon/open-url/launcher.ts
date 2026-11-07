import type { SpawnPort } from '@ferretry/kernel/contract';
import type { DetachedLauncherPort, OpenerCommand } from './service.ts';

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
  constructor(private readonly spawn: Pick<SpawnPort, 'start'>) {}

  async launch(command: OpenerCommand): Promise<void> {
    const child = this.spawn.start(command.command, command.args);
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
