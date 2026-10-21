/**
 * THE `cloudflared` CHILD, AS A PROCESS — the supervisor's port, over `Bun.spawn`.
 *
 * THE TOKEN IS IN THE CHILD'S ENVIRONMENT AND NOWHERE ELSE. The argument vector is exactly what the
 * domain built (a constant with no slot for a token), the environment is the daemon's own plus the
 * domain's additions for this one child, and nothing here writes either anywhere. stdout is discarded
 * and stderr is read line by line only to be handed to the supervisor, which looks for registration.
 *
 * A child asked to stop gets SIGTERM, and SIGKILL if it is still there after a grace period: a
 * connector that ignored its stop would hold a claim on the hostname past the daemon's own life.
 */

import type { ConnectorCommand, ConnectorProcess, ConnectorProcessPort } from '../../lib/tunnel/index.ts';

/** How long a connector asked to stop has before it is killed. */
export const CONNECTOR_STOP_GRACE_MS = 5_000;

export class BunConnectorProcesses implements ConnectorProcessPort {
  constructor(
    private readonly baseEnvironment: Readonly<Record<string, string | undefined>>,
    private readonly graceMs: number = CONNECTOR_STOP_GRACE_MS,
  ) {}

  spawn(command: ConnectorCommand, onLine: (line: string) => void): ConnectorProcess {
    const child = Bun.spawn([command.executable, ...command.args], {
      env: { ...this.baseEnvironment, ...command.environment },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    });
    void forEachLine(child.stderr, onLine);
    let kill: ReturnType<typeof setTimeout> | undefined;
    const exited = child.exited.then(code => {
      clearTimeout(kill);
      return child.signalCode === null ? code : null;
    });
    return {
      exited,
      terminate: () => {
        if (kill !== undefined || child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        kill = setTimeout(() => child.kill('SIGKILL'), this.graceMs);
        kill.unref();
      },
    };
  }
}

/** Every complete line of a stream, in order; a final unterminated line is delivered at the end. */
export async function forEachLine(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  }
  pending += decoder.decode();
  if (pending !== '') onLine(pending);
}
