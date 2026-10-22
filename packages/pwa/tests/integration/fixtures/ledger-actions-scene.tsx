/**
 * The browser entry for "make the retry etc button not so damn huge": the REAL `Transcript` over the REAL
 * `placeLedgerRows`, with one reader send in the state the query names. Nothing here reads a network.
 *
 * Parameters:
 *
 *   ?state=sending|typed|unconfirmed|revived|failed|cancelled   which send state to draw (default sending)
 *   ?theme=<family>-<mode>
 */

import { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { transcriptEntriesFromLog } from '../../../src/components/session-workspace-model.ts';
import { Transcript } from '../../../src/components/transcript.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { placeLedgerRows } from '../../../src/lib/ledger-placement.ts';
import type { LedgerSendRecord } from '../../../src/lib/send-ledger.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const state = params.get('state') ?? 'sending';

const SESSION = 'mvledger1-5e7d0b1e';
const daemon = daemonConnection({ daemonId: 'daemon-ledger', baseUrl: 'https://ledger.invalid', deviceId: 'd' });

const NOW = Date.now();
const MINUTE = 60_000;
const clock = (at: number): string => new Date(at).toISOString().slice(11, 19);
const logLine = (at: number, role: string, text: string): string => `[${clock(at)}] ${role}/message: ${text}`;
const iso = (at: number): string => new Date(at).toISOString();

const LOG = [
  logLine(NOW - 9 * MINUTE, 'user', 'Why is the build red?'),
  logLine(NOW - 8.5 * MINUTE, 'assistant', 'Two tests time out on CI. The retry flag should stabilise them.'),
].join('\n');

const SENT_AT = NOW - 40_000;
const base = {
  attachmentIds: [] as string[],
  path: 'direct' as const,
  sendId: 'send-ledger',
  acceptedAt: iso(SENT_AT),
  message: 'Ship the retry fix and re-run CI, then tell me when it is green',
};

const RECORDS: Readonly<Record<string, LedgerSendRecord>> = {
  sending: { ...base, fate: 'accepted' },
  typed: { ...base, fate: 'accepted', typedNotSent: true },
  unconfirmed: { ...base, fate: 'unaccounted', unaccountedReason: 'timeout', fateAt: iso(SENT_AT + 30_000) },
  // A peer message a revive carried, whose relaunch the transcript never proved.
  revived: {
    ...base,
    path: 'revive',
    fate: 'unaccounted',
    unaccountedReason: 'revive_unconfirmed',
    fateAt: iso(SENT_AT + 30_000),
  },
  failed: { ...base, fate: 'timed_out', retryable: true, fateAt: iso(SENT_AT + 30_000) },
  cancelled: { ...base, fate: 'cancelled', cancelEffect: 'cleared', fateAt: iso(SENT_AT + 20_000) },
};

const answered = async (): Promise<boolean> => true;
const record = RECORDS[state] ?? (RECORDS.sending as LedgerSendRecord);

function Scene() {
  const entries = useMemo(
    () =>
      placeLedgerRows(transcriptEntriesFromLog(LOG, NOW + 60_000), [record], NOW, {
        dismissed: new Set<string>(),
        expanded: new Set<string>(record.fate === 'accepted' ? [] : [record.sendId]),
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
