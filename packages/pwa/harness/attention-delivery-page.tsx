/**
 * The pinned Attention card as the owner sees where an answer stands, above a composer
 * (`attention-delivery-screenshot.ts` bundles this). Every component is the REAL one; only the data is
 * invented, and nothing leaves the page.
 *
 *   ?view=sending      the card, "Sending…" under its header (the daemon has the answer, the ferret not yet)
 *   ?view=undelivered  the card, "Your answer didn't reach <ferret>" with Retry
 *   ?view=discussing   one item in discussion as a slim line, one answered item still "Sending…"
 */

import type { AttentionId, AttentionItem, AttentionSnapshot, ResolvedAttentionItem } from '@ferretry/protocol';
import { type ReactElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown } from '../src/components/markdown.tsx';
import { AttentionPanel } from '../src/features/attention/attention-panel.tsx';
import { daemonConnection, daemonId } from '../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../src/lib/daemon-scope.ts';

const NOW = Date.parse('2026-10-23T09:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const CONNECTION = daemonConnection({
  daemonId: daemonId('studio'),
  baseUrl: 'https://studio.example.test',
  deviceId: 'harness',
});

const item = (id: string, minutes: number, patch: Partial<AttentionItem>): AttentionItem =>
  ({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}`,
    why: 'Needs a decision.',
    waitingSince: ago(minutes),
    howToResolve: 'Answer it.',
    raisedBy: 'agent',
    raisedBySession: 'fr',
    raisedByName: 'ottilie',
    ...patch,
  }) as AttentionItem;

const REBASE = item('A3', 2, {
  title: 'Rebase onto main now, or wait for the relay fix to merge?',
  subject: 'Rebase onto main now, or wait for the relay fix to merge?',
  why: 'main moved 14 commits since this branch was cut and two of them touch the attention store.',
  ask: { kind: 'multiple-choice', options: [{ label: 'Rebase now' }, { label: 'Wait' }, { label: 'Skip' }] },
});
const UNDELIVERED = item('A3', 2, {
  ...REBASE,
  undelivered: {
    at: ago(1),
    reply: { action: 'resolve', response: { kind: 'multiple-choice', choice: 'Rebase now' } },
    reason: 'Its message box held unsent text for two minutes.',
  },
} as Partial<AttentionItem>);
const DISCUSSED = item('A4', 9, {
  title: 'Restart the staging relay?',
  subject: 'Can I restart the staging relay?',
  waitingOn: 'ferret',
  waitingFor: 'discussion',
} as Partial<AttentionItem>);
const ANSWERED = {
  ...item('A5', 12, {
    title: 'Which login should the new runtime use?',
    subject: 'Which login should the new runtime use?',
  }),
  resolvedAt: ago(0),
  resolvedBy: 'human',
  resolvedBySession: null,
  resolvedByName: null,
  resolutionNote: null,
  disposition: 'resolved',
  response: { kind: 'multiple-choice', choice: 'Personal' },
} as unknown as ResolvedAttentionItem;

const board = (
  items: readonly AttentionItem[],
  extra: Partial<AttentionSnapshot> = {},
  resolved: readonly ResolvedAttentionItem[] = [],
): AttentionSnapshot => ({
  v: 1,
  sessionId: 'fr',
  items: [...items],
  resolved: [...resolved],
  count: items.length,
  parseErrors: 0,
  updatedAt: ago(0),
  ...extra,
});

const BOARDS: Record<string, AttentionSnapshot> = {
  sending: board([REBASE], { delivery: { sending: ['A3'] } }),
  undelivered: board([UNDELIVERED]),
  discussing: board([DISCUSSED], { delivery: { sending: ['A5'] } }, [ANSWERED]),
};

function Chat({ snapshot }: { readonly snapshot: AttentionSnapshot }): ReactElement {
  const [selected, setSelected] = useState<AttentionId | null>(null);
  const noop = async (): Promise<void> => undefined;
  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col bg-bg" data-fixture="">
      <div className="min-h-0 flex-1 overflow-y-auto p-panel">
        <article className="rounded-panel border border-border bg-surface p-panel text-cell">
          <p className="m-0 mb-xs text-meta text-faint">ottilie · 2m</p>
          <Markdown text="I raised a few questions — answer them whenever you are ready. Meanwhile I will keep going on the inbox wiring." />
        </article>
      </div>
      <div className="p-panel">
        <AttentionPanel
          chip={{ on: false, onChange: () => undefined }}
          client={{ respond: noop, resolve: noop, dismiss: noop, needsInfo: noop, discuss: noop, progress: noop }}
          connection={CONNECTION}
          ferret="ottilie"
          id="attention-panel"
          now={NOW}
          onSelect={setSelected}
          scope={daemonSessionScope(CONNECTION, 'fr')}
          selectedId={selected}
          snapshot={snapshot}
          status="ready"
        />
        <div className="rounded-panel border border-border bg-surface p-panel text-meta text-faint">
          Message ottilie…
        </div>
      </div>
    </div>
  );
}

const view = new URLSearchParams(location.search).get('view') ?? 'sending';
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(<Chat snapshot={BOARDS[view] ?? BOARDS.sending ?? board([])} />);
