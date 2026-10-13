import { FilePassiveUsageStore } from '@ferretry/fleet/adapters';
import { resolveFleetLayout } from '../../lib/fleet/layout.ts';
import { StatuslineController } from '../../lib/statusline/controller.ts';

/** The most of stdin a status line reads. Claude's payload is a few kilobytes. */
export const STATUSLINE_INPUT_LIMIT = 1024 * 1024;

/** Read a stream to its end, keeping at most {@link STATUSLINE_INPUT_LIMIT} bytes. */
export async function readBounded(stream: ReadableStream<Uint8Array>, limit = STATUSLINE_INPUT_LIMIT): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  let kept = 0;
  for await (const chunk of stream) {
    if (kept >= limit) continue;
    const slice = chunk.byteLength > limit - kept ? chunk.slice(0, limit - kept) : chunk;
    kept += slice.byteLength;
    text += decoder.decode(slice, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Run the person's own statusLine command through `sh -c`, as Claude itself would, with the same
 * stdin. Its stdout and stderr are this process's, so what it prints is what the status line shows.
 */
export async function runChainedStatusline(command: string, stdin: string): Promise<number> {
  const child = Bun.spawn({ cmd: ['sh', '-c', command], stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' });
  try {
    child.stdin.write(stdin);
    await child.stdin.end();
  } catch {
    /* a command that never reads its input closed the pipe; its output still stands */
  }
  return await child.exited;
}

export interface StatuslineWorld {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  /** The product name, so the default state home is single-sourced. */
  readonly product: string;
  readonly io: { setExitCode(code: number): void };
  readonly stdin?: ReadableStream<Uint8Array>;
}

/** The composition of `fy statusline`: one construction the composition root calls. */
export function createStatuslineController(world: StatuslineWorld): StatuslineController {
  const layout = resolveFleetLayout({
    stateHome: world.environment.FY_HOME,
    userHome: world.homeDirectory,
    product: world.product,
  });
  const store = new FilePassiveUsageStore(layout.fleetDirectory);
  return new StatuslineController({
    input: { read: async () => await readBounded(world.stdin ?? Bun.stdin.stream()) },
    sink: { write: async (id, record) => await store.write(id, record) },
    chain: { run: runChainedStatusline },
    environment: world.environment,
    now: () => Date.now(),
    setExitCode: code => world.io.setExitCode(code),
  });
}
