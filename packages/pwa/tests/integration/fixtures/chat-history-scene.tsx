/**
 * The browser entry for "I can't scroll up further": the REAL `Transcript` and the REAL chat refresh
 * (`startSessionWorkspaceRefresh`), over a daemon that pages a long conversation exactly as `log-page`
 * does — whole records, the newest `limit` before a byte, a `start` to ask before next time.
 *
 * The conversation is `TOTAL` records: questions, answers, and runs of tool calls that collapse into one
 * row, so many pages add only a few rows to see. Every older page takes `DELAY_MS`, as a relay would.
 * `window.__holdOlder()` holds the next older page until `window.__releaseOlder()`, so the loading state
 * can be seen; `window.__appendMessages(n)` lands `n` new records at the tail while older ones are held.
 *
 *   ?theme=<family>-<mode>
 */

import type { LogPageOptions, SessionLogPage, SessionView } from '@ferretry/protocol';
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { startSessionWorkspaceRefresh } from '../../../src/components/session-workspace-model.ts';
import { Transcript } from '../../../src/components/transcript.tsx';
import type { TranscriptHistoryControl } from '../../../src/components/transcript-history-row.tsx';
import type { TranscriptEntry } from '../../../src/lib/session-screens.ts';
import type { TranscriptHistoryStatus } from '../../../src/lib/transcript-history.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

declare global {
  interface Window {
    __holdOlder: () => void;
    __releaseOlder: () => void;
    __appendMessages: (count: number) => void;
    __historyStatus: TranscriptHistoryStatus;
    __pagesRead: number;
  }
}

const TOTAL = 1_500;
const STRIDE = 100;
const DELAY_MS = 60;
let count = TOTAL;

const clock = (index: number): string =>
  new Date(Date.UTC(2026, 9, 18, 0, 0, 0) + index * 7_000).toISOString().slice(11, 19);

/** Record `index`: a question, an answer, or one of a run of tool calls and their results. */
const record = (index: number): string => {
  const at = `[${clock(index)}]`;
  const turn = index % 10;
  if (turn === 0) return `${at} user/message: Question ${String(index)}: what does step ${String(index)} change?`;
  if (turn < 7)
    return turn % 2 === 1
      ? `${at} assistant/tool-call: Bash({"command":"rg -n step${String(index)} packages"})`
      : `${at} tool/tool-result: ok`;
  return `${at} assistant/message: Answer ${String(index)}. Step ${String(index)} changes the parser, and here is why it matters for the page it sits on.`;
};

let hold: { promise: Promise<void>; release: () => void } | undefined;
/** The release of the last hold, kept after the page has taken the hold itself. */
let release: () => void = () => undefined;
window.__holdOlder = () => {
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  hold = { promise, release };
};
window.__releaseOlder = () => release();
window.__pagesRead = 0;

const logPage = async (_id: string, options: LogPageOptions = {}): Promise<SessionLogPage> => {
  if (options.before !== undefined) {
    window.__pagesRead += 1;
    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    if (options.from === undefined && hold !== undefined) {
      const held = hold;
      hold = undefined;
      await held.promise;
    }
  }
  const limit = options.limit ?? 200;
  const size = count * STRIDE;
  const before = Math.min(options.before ?? size, size);
  const from = options.from ?? 0;
  const first = Math.ceil(from / STRIDE);
  const end = Math.ceil(before / STRIDE);
  const kept = Math.max(first, end - limit);
  const lines: string[] = [];
  for (let index = kept; index < end; index += 1) lines.push(record(index));
  return {
    v: 1,
    sessionId: 's',
    log: lines.join('\n'),
    start: options.before === undefined || kept > first ? kept * STRIDE : from,
    file: 'f1',
  };
};

function Scene() {
  const [entries, setEntries] = useState<readonly TranscriptEntry[]>([]);
  const [status, setStatus] = useState<TranscriptHistoryStatus>('unavailable');
  const [control, setControl] = useState<ReturnType<typeof startSessionWorkspaceRefresh> | null>(null);
  useEffect(() => {
    const refresh = startSessionWorkspaceRefresh({
      api: {
        logs: async () => '',
        logPage,
        get: async () => ({ config: { id: 's' } }) as SessionView,
      },
      sessionId: 's',
      environment: {
        visible: () => true,
        setInterval: () => 0,
        clearInterval: () => undefined,
        onVisibility: () => () => undefined,
      },
      onTranscript: setEntries,
      onHistory: next => {
        window.__historyStatus = next;
        setStatus(next);
      },
      onSession: () => undefined,
      onError: () => undefined,
    });
    setControl(refresh);
    window.__appendMessages = added => {
      count += added;
      void refresh.refresh(true);
    };
    return () => refresh.stop();
  }, []);
  const history = useMemo<TranscriptHistoryControl>(
    () => ({ status, loadOlder: () => void control?.loadOlder() }),
    [control, status],
  );
  return (
    <div className="kt-chat-surface scene-chat">
      <Transcript agentName="Lizzette" daemonId="d" entries={entries} history={history} sessionId="s" />
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
