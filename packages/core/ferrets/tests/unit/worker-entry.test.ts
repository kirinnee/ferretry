import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import {
  serveSessionWorker,
  type SessionWorkerScope,
  type SessionWorkerPeers,
} from '../../daemon/workers/session.worker.ts';
import type { FromSessionWorker, ToSessionWorker } from '../../daemon/lib/session/observer/protocol.ts';
import {
  INERT_PANE_PARSERS,
  INERT_QUESTIONS,
  UNWIRED_SEND_EVIDENCE,
  UNWIRED_TAIL,
  unwiredTranscriptSource,
} from '../support/daemon/observer-peers.ts';

test('the worker entry uses its host metadata peer and performs no filesystem IO', async () => {
  const source = await readFile(new URL('../../daemon/workers/session.worker.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/from ["\x27]node:fs/u);
  const scope: SessionWorkerScope = { onmessage: null };
  const paths: string[] = [];
  const posted: FromSessionWorker[] = [];
  const spawn = Bun.spawn;
  const spawnSync = Bun.spawnSync;
  const peers: SessionWorkerPeers & { stat: (file: string) => Promise<undefined> } = {
    stat: async file => {
      paths.push(file);
      return undefined;
    },
    tmux: () => ({
      port: { execute: async () => ({ code: 1, stdout: '', stderr: 'unavailable' }) },
      connected: true,
      watch: async () => true,
      onPaneWatch: () => () => {},
      stop: async () => {},
    }),
    transcripts: { claude: unwiredTranscriptSource('claude'), codex: unwiredTranscriptSource('codex') },
    frames: () => ({ state: async () => undefined, invalidate: () => {}, forget: () => {} }),
    clock: { now: () => new Date().toISOString() },
    schedule: (delayMs, run) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    },
    tail: UNWIRED_TAIL,
    sendEvidence: UNWIRED_SEND_EVIDENCE,
    paneParsers: INERT_PANE_PARSERS,
    questions: INERT_QUESTIONS,
  };
  const send = (data: ToSessionWorker) => scope.onmessage?.({ data } as MessageEvent<ToSessionWorker>);
  try {
    serveSessionWorker(scope, message => posted.push(message), peers);
    send({
      kind: 'attach',
      session: 's',
      generation: 1,
      facts: { status: 'running', turn: 1 },
      binding: {
        tmux: { executable: '/fixture/tmux', socket: '/fixture/socket', target: 's' },
        transcript: { file: '/confined/transcript', harness: 'claude' },
      },
    });
    send({ kind: 'request', session: 's', generation: 1, request: 1, ask: { kind: 'observe' } });
    for (let i = 0; i < 100 && !posted.some(message => 'kind' in message && message.kind === 'answered'); i++)
      await new Promise<void>(resolve => setImmediate(resolve));
    expect(paths).toContain('/confined/transcript');
    expect(posted.some(message => 'kind' in message && message.kind === 'answered')).toBe(true);
  } finally {
    send({ kind: 'stop' });
    await new Promise<void>(resolve => setImmediate(resolve));
    Bun.spawn = spawn;
    Bun.spawnSync = spawnSync;
  }
});
