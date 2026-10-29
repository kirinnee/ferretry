/**
 * The pinned Attention card, expanded and folded to its one line, above a composer
 * (`attention-collapse-screenshot.ts` bundles this). Every component is the REAL one; only the data is
 * invented, and nothing leaves the page.
 */

import type { AttentionId, AttentionItem, AttentionSnapshot } from '@ferretry/protocol';
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
  context: 'I am halfway through the inbox wiring; a rebase now costs ~5 minutes, later maybe more.',
  ask: { kind: 'multiple-choice', options: [{ label: 'Rebase now' }, { label: 'Wait' }, { label: 'Skip' }] },
});
const RELAY = item('A4', 9, {
  title: 'Restart the staging relay?',
  subject: 'Can I restart the staging relay?',
  why: 'The relay is serving a stale advertisement; a restart drops live sessions for ~10 seconds.',
});
const LOGIN = item('A5', 41, {
  title: 'Which login should the new runtime use?',
  subject: 'Which login should the new runtime use?',
  why: 'Two logins can run this harness and they bill differently.',
  ask: { kind: 'open-question' },
});

const board = (items: readonly AttentionItem[]): AttentionSnapshot => ({
  v: 1,
  sessionId: 'fr',
  items: [...items],
  resolved: [],
  count: items.length,
  parseErrors: 0,
  updatedAt: ago(0),
});

function Chat({ items }: { readonly items: readonly AttentionItem[] }): ReactElement {
  const [selected, setSelected] = useState<AttentionId | null>(null);
  const [chip, setChip] = useState(true);
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
          chip={{ on: chip, onChange: setChip }}
          client={{ respond: noop, resolve: noop, dismiss: noop, needsInfo: noop, discuss: noop, progress: noop }}
          connection={CONNECTION}
          id="attention-panel"
          now={NOW}
          onSelect={setSelected}
          scope={daemonSessionScope(CONNECTION, 'fr')}
          selectedId={selected}
          snapshot={board(items)}
          status="ready"
        />
        <div className="rounded-panel border border-border bg-surface p-panel text-meta text-faint" data-chip={chip}>
          Message ottilie…
        </div>
      </div>
    </div>
  );
}

const view = new URLSearchParams(location.search).get('view') ?? 'several';
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(<Chat items={view === 'one' ? [REBASE] : [REBASE, RELAY, LOGIN]} />);
