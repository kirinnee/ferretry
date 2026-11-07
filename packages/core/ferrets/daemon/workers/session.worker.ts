/**
 * A SESSION WORKER: the session observer's turn part, for the sessions this thread hosts.
 *
 * Wiring only — the program is `SessionWorkerRuntime`. It holds no storage, opens no database and writes
 * no file: it reads its sessions' panes through their own attached observe-only tmux clients and their
 * transcripts from disk, and posts turn patches the main thread applies (`docs/design/session-workers.md`).
 * Kept lean on purpose — no zod, no protocol schemas, no storage, no vault — and held so by the diet test.
 */
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { SessionWorkerRuntime } from '../src/adapters/session/observer/session-worker-runtime.ts';
import { countWorkerChildren } from '../src/adapters/session/observer/worker-children.ts';
import { BunTmuxProcess } from '../src/adapters/tmux/bun-tmux-process.ts';
import { ControlModeTmuxProcess } from '../src/adapters/tmux/control-tmux-process.ts';
import { readAskedQuestion } from '../src/adapters/session/question/asked-question-file.ts';
import { NodeTranscriptSource } from '../src/adapters/transcript/file-source.ts';
import { SessionObserver } from '../src/lib/session/observer/observer.ts';
import type { FromSessionWorker, ToSessionWorker } from '../src/lib/session/observer/protocol.ts';
import { PANE_WATCH, PANE_WATCH_FORMAT, SESSION_WORKER_ATTACH_FLAGS } from '../src/lib/tmux/control-protocol.ts';
import { ClaudeTranscriptParser } from '../src/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../src/lib/transcript/codex.ts';

declare const self: { onmessage: ((event: MessageEvent<ToSessionWorker>) => void) | null };

const post = (message: FromSessionWorker): void => postMessage(message);
const nowMs = (): number => performance.timeOrigin + performance.now();
const children = countWorkerChildren(Bun, nowMs);

const runtime = new SessionWorkerRuntime({
  post,
  // ATTACHED, REFUSING: the session's own control client answers reads in-band, and anything that is not
  // an allowlisted read is refused without running — that refusal is what keeps a worker from typing. NOT
  // tmux's `read-only`: from 3.7 a read-only client refuses the daemon's own `send-keys` whenever tmux
  // picks it as their target client. `no-output`: the pane's bytes are never streamed here; a subscription
  // to its `#{pane_dead} #{window_activity}` says when it drew, at most once a second, all a look needs.
  tmux: ({ executable, socket, target }) => {
    const port = new ControlModeTmuxProcess(executable, socket, new BunTmuxProcess(executable, socket), {
      attach: { target, flags: SESSION_WORKER_ATTACH_FLAGS },
      mutations: 'refuse',
    });
    return {
      port,
      get connected() {
        return port.connected;
      },
      watch: async () => await port.watch(PANE_WATCH, PANE_WATCH_FORMAT),
      onPaneWatch: listener =>
        port.subscribe(notification => {
          if (notification.kind === 'subscription-changed' && notification.name === PANE_WATCH)
            listener(notification.value);
        }),
      stop: async () => await port.stop(),
    };
  },
  transcripts: {
    claude: new NodeTranscriptSource(new ClaudeTranscriptParser()),
    codex: new NodeTranscriptSource(new CodexTranscriptParser()),
  },
  stat: async file => {
    const info = await stat(file);
    return { size: info.size, mtimeMs: info.mtimeMs };
  },
  asked: readAskedQuestion,
  clock: { now: () => new Date().toISOString() },
  nowMs,
  schedule: (delayMs, run) => {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  },
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
