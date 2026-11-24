import type { WorkersPort } from '@ferretry/kernel/contract';
import { fileURLToPath } from 'node:url';
import type { HostCommand } from './child-speech-thread.ts';
import type { SpeechReply, SpeechRequest } from '../lib/engine/protocol.ts';
import type { ReplyReply, ReplyRequest } from '../lib/reply/protocol.ts';
import type { RequestThread, ReplyThread, SpeechThread } from '../lib/engine/ports.ts';

/** The speech worker's program: a module of this package, embedded by name in a compiled `fyd` (manifest `workers`). */
export const SPEECH_WORKER_URL = new URL('../worker/speech.worker.ts', import.meta.url);
/** The reply voice's own thread, so listening never waits for speaking. */
export const REPLY_WORKER_URL = new URL('../worker/reply.worker.ts', import.meta.url);

const isReply = (value: unknown): value is { id: number; ok: boolean; sentence?: string } =>
  typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'number';

/** One worker thread behind `call`: replies are matched to requests by id, and a thread that ends fails what waits. */
function startThread<Call extends object, Answer extends { id: number; ok: boolean }>(
  workers: Pick<WorkersPort, 'start'>,
  url: URL,
  name: string,
  words: string,
): RequestThread<Call, Answer & { ok: true }> {
  const handle = workers.start(url, { name, env: {} });
  const waiting = new Map<
    number,
    { resolve: (reply: Answer & { ok: true }) => void; reject: (error: Error) => void }
  >();
  const ended: (() => void)[] = [];
  let next = 1;
  let over = false;
  const finish = (reason: string): void => {
    over = true;
    for (const [, pending] of waiting) pending.reject(new Error(reason));
    waiting.clear();
    for (const listener of ended) listener();
  };
  handle.onMessage(message => {
    if (!isReply(message)) return;
    const pending = waiting.get(message.id);
    if (pending === undefined) return;
    waiting.delete(message.id);
    if (message.ok) pending.resolve(message as unknown as Answer & { ok: true });
    else pending.reject(new Error(message.sentence));
  });
  handle.onExit(() => finish(`The ${words} worker stopped.`));
  return {
    call: (request, transfer = []) =>
      new Promise((resolve, reject) => {
        if (over) {
          reject(new Error(`The ${words} worker stopped.`));
          return;
        }
        const id = next++;
        waiting.set(id, { resolve, reject });
        handle.post({ ...request, id }, transfer);
      }),
    terminate: async () => {
      await handle.terminate();
      if (!over) finish(`The ${words} worker was stopped.`);
    },
    onEnd: listener => void ended.push(listener),
  };
}

export const startSpeechThread = (workers: Pick<WorkersPort, 'start'>): SpeechThread =>
  startThread<Omit<SpeechRequest, 'id'>, SpeechReply & { id: number; ok: boolean }>(
    workers,
    SPEECH_WORKER_URL,
    'speech',
    'speech',
  ) as SpeechThread;

export const startReplyThread = (workers: Pick<WorkersPort, 'start'>): ReplyThread =>
  startThread<Omit<ReplyRequest, 'id'>, ReplyReply & { id: number; ok: boolean }>(
    workers,
    REPLY_WORKER_URL,
    'reply',
    'reply voice',
  ) as ReplyThread;

/** The native host's program: the same module a compiled `fyd` embeds beside its entry as `speech-host.js`. */
export const SPEECH_HOST_URL = new URL('../worker/speech-host.ts', import.meta.url);

/**
 * What to run for one native engine's host. From source the daemon's own runtime (`bun`) runs the module; compiled, the
 * executable is `fyd` itself and its `--plugin-child` mode runs the embedded program (`packages/core/kernel/host/plugin-child.ts`).
 * Either way the program is `process.execPath`, which the manifest's `$daemon` spawn permission allows and nothing else.
 */
export function nativeHostCommand(engine: 'speech' | 'reply'): HostCommand {
  return import.meta.url.endsWith('.ts')
    ? { program: process.execPath, args: [fileURLToPath(SPEECH_HOST_URL), engine] }
    : { program: process.execPath, args: ['--plugin-child', 'speech-host', engine] };
}
