/**
 * The browser entry for the honest copy of a HELD send: the REAL `Transcript` over the REAL `placeLedgerRows`, with
 * FIXED fake data and a fixed clock (2026-11-12T09:00Z), so a capture is the same every run. Three sends, one of each
 * kind a person can meet: an ordinary held row, a held row the update marked, and a plain sending one for company.
 * The held rows' explanation is opened (as a tap on the clock mark opens it), because for the ordinary one it is
 * the only place the sentence is drawn.
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

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const SESSION = 'mvheldcopy-5e7d0b1e';
const daemon = daemonConnection('daemon-held-copy');

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

const base = {
  attachmentIds: [] as string[],
  path: 'revive-queue' as const,
  fate: 'accepted' as const,
  held: true as const,
};

const RECORDS: readonly LedgerSendRecord[] = [
  { ...base, sendId: 'held-ordinary', acceptedAt: iso(NOW - 20 * MINUTE), message: 'Ship the retry fix and re-run CI' },
  {
    ...base,
    sendId: 'held-marked',
    acceptedAt: iso(NOW - 15 * MINUTE),
    message: 'Then tell me when it is green',
    unaccountedReason: 'update_unconfirmed',
  },
  {
    sendId: 'sending',
    path: 'direct',
    fate: 'accepted',
    acceptedAt: iso(NOW - 40_000),
    attachmentIds: [],
    message: 'Thanks',
  },
];

const answered = async (): Promise<boolean> => true;

function Scene() {
  const entries = useMemo(
    () =>
      placeLedgerRows(transcriptEntriesFromLog(LOG, NOW), [...RECORDS], NOW, {
        dismissed: new Set<string>(),
        expanded: new Set<string>(),
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
        onRetry={answered}
        onSubmit={answered}
        sessionId={SESSION}
      />
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Scene />);
