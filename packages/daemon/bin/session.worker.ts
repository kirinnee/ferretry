/**
 * A SESSION WORKER: the session observer's turn part, for the sessions this thread hosts.
 *
 * Wiring only — the program is `SessionWorkerRuntime`. It holds no storage, opens no database and writes
 * no file: it reads its sessions' panes through their own read-only attached tmux clients and their
 * transcripts from disk, and posts turn patches the main thread applies (`docs/design/session-workers.md`).
 * Kept lean on purpose — no zod, no protocol schemas, no storage, no vault — and held so by the diet test.
 */
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { SessionWorkerRuntime } from '../src/adapters/session/observer/session-worker-runtime.ts';
import { countWorkerChildren } from '../src/adapters/session/observer/worker-children.ts';
import { BunTmuxProcess } from '../src/adapters/tmux/bun-tmux-process.ts';
import { ControlModeTmuxProcess } from '../src/adapters/tmux/control-tmux-process.ts';
import { NodeTranscriptSource } from '../src/adapters/transcript/file-source.ts';
import { SessionObserver } from '../src/lib/session/observer/observer.ts';
import type { FromSessionWorker, ToSessionWorker } from '../src/lib/session/observer/protocol.ts';
import { ClaudeTranscriptParser } from '../src/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../src/lib/transcript/codex.ts';

declare const self: { onmessage: ((event: MessageEvent<ToSessionWorker>) => void) | null };

const post = (message: FromSessionWorker): void => postMessage(message);
const nowMs = (): number => performance.timeOrigin + performance.now();
const children = countWorkerChildren(Bun, nowMs);

const runtime = new SessionWorkerRuntime({
  post,
  // READ-ONLY, ATTACHED, REFUSING: the session's own control client answers reads in-band, and anything
  // that is not an allowlisted read is refused without running — tmux's `read-only` does not stop an
  // in-band `send-keys`. `no-output` until stage 3c reacts to `%output`.
  tmux: ({ executable, socket, target }) => {
    const port = new ControlModeTmuxProcess(executable, socket, new BunTmuxProcess(executable, socket), {
      attach: { target, flags: 'ignore-size,read-only,no-output' },
      mutations: 'refuse',
    });
    return { port, close: () => port.close() };
  },
  transcripts: {
    claude: new NodeTranscriptSource(new ClaudeTranscriptParser()),
    codex: new NodeTranscriptSource(new CodexTranscriptParser()),
  },
  stat: async file => {
    const info = await stat(file);
    return { size: info.size, mtimeMs: info.mtimeMs };
  },
  clock: { now: () => new Date().toISOString() },
  nowMs,
  children,
  observer: new SessionObserver(text => createHash('sha256').update(text, 'utf8').digest('hex')),
});

self.onmessage = event => {
  void runtime
    .handle(event.data)
    .catch((error: unknown) =>
      post({ kind: 'fault', message: error instanceof Error ? error.message : String(error), fatal: false }),
    );
};
