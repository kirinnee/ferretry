import type { SpawnPort } from '@ferretry/kernel/contract';

/**
 * A spawn port that KEEPS the handle of every child it starts, so a test can end exactly those children and wait for
 * them to exit. A test that must not leave a wedged child behind ends it through its own handle: a handle cannot be
 * reused the way a pid number can, so this signals nothing it did not start (never a recorded pid).
 *
 * `run` honours `options.timeout` the way the host's spawn does (SIGKILL at the bound), which is what
 * `boundedSpawn` hands it. `runBytes` and `start` are not used by the callers and refuse.
 */
export class HeldSpawn implements SpawnPort {
  private readonly children: ReturnType<typeof Bun.spawn>[] = [];
  private ended = false;

  async run(program: string, args: readonly string[], options?: Parameters<SpawnPort['run']>[2]) {
    // Once the test has ended its children nothing may start another that no handle would end.
    if (this.ended) throw new Error('HeldSpawn has ended its children and starts no more');
    const child = Bun.spawn([program, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    this.children.push(child);
    const bound = options?.timeout === undefined ? undefined : Number(options.timeout);
    const timer = bound === undefined ? undefined : setTimeout(() => child.kill('SIGKILL'), bound);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout as ReadableStream<Uint8Array>).text(),
        new Response(child.stderr as ReadableStream<Uint8Array>).text(),
        child.exited,
      ]);
      return {
        exitCode: child.signalCode === null ? exitCode : null,
        signal: child.signalCode === null ? null : String(child.signalCode),
        stdout,
        stderr,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async runBytes(): Promise<never> {
    return await Promise.reject(new Error('HeldSpawn runs text commands only'));
  }

  start(): never {
    throw new Error('HeldSpawn runs text commands only');
  }

  /** SIGKILL every child this port started that is still running, and wait until each has exited. */
  async endAll(): Promise<void> {
    this.ended = true;
    for (const child of this.children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await child.exited;
    }
  }
}
