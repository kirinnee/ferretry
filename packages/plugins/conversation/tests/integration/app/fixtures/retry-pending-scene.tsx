/**
 * The browser entry for the honest copy of a send's Retry: the REAL `Transcript` (no `onRetry`, as the chat screen
 * mounts it) over the REAL `placeLedgerRows`, then the REAL `UnconfirmedSendNotice` under it. FIXED fake data and a
 * fixed clock (2026-11-12T09:00Z), so a capture is the same every run. Two flagged sends are drawn open: one the agent
 * never showed and one proven absent. Neither offers a Retry, and each says typing it again is not in 5.0 yet.
 *
 *   ?theme=<family>-<mode>
 */

import { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { transcriptEntriesFromLog } from '../../../../app/chat/chat-refresh.ts';
import { Transcript } from '../../../../app/chat/transcript.tsx';
import { daemonConnection } from '../../../../app/composer/seam.ts';
import { placeLedgerRows } from '../../../../app/chat/ledger-placement.ts';
import type { LedgerSendRecord } from '../../../../app/chat/send-ledger.ts';
import { UnconfirmedSendNotice } from '../../../../app/composer/unconfirmed-send-notice.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const SESSION = 'mvretrypend-5e7d0b1e';
const daemon = daemonConnection('daemon-retry-pending');

/** 2026-11-12T09:00:00Z. */
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);
const MINUTE = 60_000;
const clock = (at: number): string => new Date(at).toISOString().slice(11, 19);
const logLine = (at: number, role: string, text: string): string => `[${clock(at)}] ${role}/message: ${text}`;
const iso = (at: number): string => new Date(at).toISOString();

const LOG = [
  logLine(NOW - 30 * MINUTE, 'user', 'Why is the build red?'),
  logLine(NOW - 29 * MINUTE, 'assistant', 'Two tests time out on CI. The retry flag should stabilise them.'),
].join('\n');

const base = { attachmentIds: [] as string[], path: 'direct' as const };

const RECORDS: readonly LedgerSendRecord[] = [
  {
    ...base,
    sendId: 'unconfirmed',
    acceptedAt: iso(NOW - 20 * MINUTE),
    message: 'Ship the retry fix and re-run CI',
    fate: 'unaccounted',
    unaccountedReason: 'timeout',
    fateAt: iso(NOW - 19 * MINUTE),
  },
  {
    ...base,
    sendId: 'absent',
    acceptedAt: iso(NOW - 10 * MINUTE),
    message: 'Then tell me when it is green',
    fate: 'timed_out',
    retryable: true,
    fateAt: iso(NOW - 9 * MINUTE),
  },
];

const answered = async (): Promise<boolean> => true;

function Scene() {
  const entries = useMemo(
    () =>
      placeLedgerRows(transcriptEntriesFromLog(LOG, NOW), [...RECORDS], NOW, {
        dismissed: new Set<string>(),
        expanded: new Set<string>(RECORDS.map(record => record.sendId)),
      }),
    [],
  );
  return (
    <div className="scene-chat">
      <Transcript
        agentName="Janella"
        daemonId={daemon.daemonId}
        entries={entries}
        onCancel={answered}
        onDismiss={() => {}}
        onExpand={() => {}}
        onSubmit={answered}
        sessionId={SESSION}
      />
      <div className="scene-notice">
        <UnconfirmedSendNotice actions={['submit', 'clear']} busy={false} onAct={() => {}} />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Scene />);
