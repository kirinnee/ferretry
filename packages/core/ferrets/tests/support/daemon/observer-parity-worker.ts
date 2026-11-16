/**
 * The session-worker thread the parity scenarios spawn: Ferrets' own `serveSessionWorker` with the observer's
 * scripted peers and a refusing tmux client that runs the two reads a worker is allowed (`display-message`,
 * `capture-pane`) and nothing else.
 */
import { stat } from 'node:fs/promises';
import { serveSessionWorker, type SessionWorkerScope } from '../../../daemon/workers/session.worker.ts';
import type { FromSessionWorker } from '../../../daemon/lib/session/observer/protocol.ts';
import { tmuxPort } from './observer-parity-tmux.ts';
import {
  SCRIPTED_PANE_FRAMES,
  SCRIPTED_PANE_PARSERS,
  SCRIPTED_QUESTIONS,
  SCRIPTED_SEND_EVIDENCE,
  SCRIPTED_TAIL,
  scriptedReadAskedQuestion,
  scriptedTranscriptSource,
} from './observer-stand-ins.ts';

const ALLOWED = new Set(['display-message', 'capture-pane']);
const scope = self as unknown as SessionWorkerScope & { postMessage(message: FromSessionWorker): void };

serveSessionWorker(scope, message => scope.postMessage(message), {
  tmux: binding => {
    const port = tmuxPort(binding.executable, binding.socket);
    return {
      port: {
        execute: async (arguments_, stdin) =>
          ALLOWED.has(arguments_[0] ?? '')
            ? await port.execute(arguments_, stdin)
            : { code: 1, stdout: '', stderr: 'refused: not an allowlisted read' },
      },
      connected: true,
      watch: async () => true,
      onPaneWatch: () => () => undefined,
      stop: async () => undefined,
    };
  },
  transcripts: { claude: scriptedTranscriptSource('claude'), codex: scriptedTranscriptSource('codex') },
  stat: async file => {
    const info = await stat(file).catch(() => undefined);
    return info === undefined ? undefined : { size: info.size, mtimeMs: info.mtimeMs };
  },
  clock: { now: () => new Date().toISOString() },
  schedule: (delayMs, run) => {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  },
  asked: scriptedReadAskedQuestion,
  frames: SCRIPTED_PANE_FRAMES,
  tail: SCRIPTED_TAIL,
  sendEvidence: SCRIPTED_SEND_EVIDENCE,
  paneParsers: SCRIPTED_PANE_PARSERS,
  questions: SCRIPTED_QUESTIONS,
});
