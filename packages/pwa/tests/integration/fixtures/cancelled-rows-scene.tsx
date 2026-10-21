/**
 * The browser entry for "messages stuck at the bottom (cancelled) block the whole experience": the REAL
 * `Transcript` over the REAL `placeLedgerRows`, with a conversation that has a few sends that never
 * arrived — one cancelled a few minutes ago, one given up on, and one that was cancelled but did reach
 * the agent. Nothing here reads a network; the transcript is a daemon log string and the ledger is
 * records in memory.
 *
 * Parameters (all optional):
 *
 *   ?open=1       the reader opened the given-up note
 *   ?dismissed=1  the reader dismissed the cancelled note
 *   ?theme=<family>-<mode>
 */

import { useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { transcriptEntriesFromLog } from '../../../src/components/session-workspace-model.ts';
import { Transcript } from '../../../src/components/transcript.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { placeLedgerRows } from '../../../src/lib/ledger-placement.ts';
import type { LedgerSendRecord } from '../../../src/lib/send-ledger.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const SESSION = 'mvcance1-5e7d0b1e';
const daemon = daemonConnection({ daemonId: 'daemon-cancelled', baseUrl: 'https://cancelled.invalid', deviceId: 'd' });

const NOW = Date.now();
const MINUTE = 60_000;
const clock = (at: number): string => new Date(at).toISOString().slice(11, 19);
const logLine = (at: number, role: string, text: string): string => `[${clock(at)}] ${role}/message: ${text}`;
const iso = (at: number): string => new Date(at).toISOString();

const CANCELLED_AT = NOW - 6 * MINUTE;
const GIVEN_UP_AT = NOW - 4 * MINUTE;
const REACHED_AT = NOW - 2 * MINUTE;

const LOG = [
  logLine(NOW - 9 * MINUTE, 'user', 'Why is the build red?'),
  logLine(NOW - 8.5 * MINUTE, 'assistant', 'Two tests time out on CI. The retry flag should stabilise them.'),
  logLine(NOW - 5 * MINUTE, 'user', 'Ship the retry fix and re-run CI'),
  logLine(NOW - 4.5 * MINUTE, 'assistant', 'Done — the fix is pushed and CI is re-running on the branch.'),
  logLine(REACHED_AT + 5_000, 'user', 'Thanks, tell me when it is green'),
  logLine(REACHED_AT + 12_000, 'assistant', 'Will do. I am watching the checks and will report back here.'),
].join('\n');

const base = { attachmentIds: [] as string[], path: 'direct' as const };
const SENDS: readonly LedgerSendRecord[] = [
  {
    ...base,
    sendId: 'send-cancelled',
    acceptedAt: iso(CANCELLED_AT),
    message: 'hi',
    fate: 'cancelled',
    fateAt: iso(CANCELLED_AT + 20_000),
  },
  {
    ...base,
    sendId: 'send-given-up',
    acceptedAt: iso(GIVEN_UP_AT),
    message: 'Can you also bump the retry count to 3?',
    fate: 'timed_out',
    fateAt: iso(GIVEN_UP_AT + 30_000),
  },
  {
    ...base,
    sendId: 'send-reached',
    acceptedAt: iso(REACHED_AT),
    message: 'Thanks, tell me when it is green',
    fate: 'delivered',
    fateAt: iso(REACHED_AT + 6_000),
    evidence: { key: 'proof-reached', harness: 'claude', observedAt: iso(REACHED_AT + 5_000), tier: 'exact-text' },
  },
];

const answered = async (): Promise<boolean> => true;

function Scene() {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(
    new Set(params.get('dismissed') === '1' ? ['send-cancelled'] : []),
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    new Set(params.get('open') === '1' ? ['send-given-up'] : []),
  );
  const onDismiss = useCallback(
    (record: LedgerSendRecord) => setDismissed(current => new Set([...current, record.sendId])),
    [],
  );
  const onExpand = useCallback(
    (record: LedgerSendRecord, open: boolean) =>
      setExpanded(current => {
        const next = new Set(current);
        if (open) next.add(record.sendId);
        else next.delete(record.sendId);
        return next;
      }),
    [],
  );
  const entries = useMemo(
    () => placeLedgerRows(transcriptEntriesFromLog(LOG, NOW + 60_000), SENDS, NOW, { dismissed, expanded }),
    [dismissed, expanded],
  );
  return (
    <div className="scene-chat">
      <Transcript
        agentName="Janella"
        daemonId={daemon.daemonId}
        entries={entries}
        onCancel={answered}
        onDismiss={onDismiss}
        onExpand={onExpand}
        onRetry={answered}
        onSubmit={answered}
        sessionId={SESSION}
      />
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Scene />);
