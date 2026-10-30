/**
 * Every `!A` opens the same item view, whatever state the item is in (#B76), one view per URL
 * (`agenda-settled-screenshot.ts` bundles this and drives it):
 *
 *   ?target=A89      the owner's !A89: replied to, so PARKED — the view says so and offers "Back to my list"
 *   ?target=A70      snoozed until this afternoon
 *   ?target=A1       resolved: read-only, how it ended
 *   ?target=A5       open: the quick replies, as before
 *   &mode=off        the ferret is not in agenda mode: no agenda line, and the proved id still opens
 *
 * Every component is the REAL one (`useAgenda` through `AgendaChatHarness`); only the data is invented.
 */

import type { AgendaId, AgendaItem, AgendaSnapshot, ResolvedAgendaItem } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import { AgendaChatHarness } from './agenda-chat.tsx';

const NOW = Date.parse('2026-10-30T22:15:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const ahead = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

const item = (id: string, minutes: number, patch: Partial<AgendaItem>): AgendaItem =>
  ({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}`,
    why: 'Needs a decision.',
    waitingSince: ago(minutes),
    howToResolve: 'Answer it.',
    raisedBy: 'agent',
    raisedBySession: 'lead',
    raisedByName: 'lizzette',
    ...patch,
  }) as AgendaItem;

// THE ITEM THE OWNER CLICKED: a task, replied to at 22:10 — so parked, waiting on the ferret.
const A89 = item('A89', 29, {
  title: 'Update the Liftoff MBP',
  subject: 'Run fy daemon update --yes on the Liftoff MBP so snooze (and tonight’s other fixes) work there',
  premise: "- Snooze failed with 'Invalid discriminator value' because that chat lives on the Liftoff MBP",
  context: '- Casen is also making the app hide or grey out snooze on machines that don’t support it',
  terms: [
    { term: 'MBP', meaning: 'MacBook Pro, your laptop machine' },
    { term: 'EC2', meaning: 'The cloud machine this chat runs on' },
  ],
  steps: [
    'On the Liftoff MBP, open a terminal and run `fy daemon update --yes`',
    'Tap **Done** here once it says updated',
  ],
  ask: { kind: 'task' },
  parked: { reason: 'replied', at: ago(4) },
} as Partial<AgendaItem>);

const A70 = item('A70', 60, {
  title: 'Waiting for the deploy approval',
  subject: 'Approve the relay change before it ships?',
  ask: { kind: 'permission' },
  parked: { reason: 'snoozed', at: ago(30), until: ahead(300) },
} as Partial<AgendaItem>);

const A5 = item('A5', 12, {
  title: 'Which storage engine for the ledger?',
  subject: 'Which storage engine should keep the ledger: SQLite or Postgres?',
  ask: {
    kind: 'multiple-choice',
    options: [
      { label: 'SQLite', description: 'One file, no server to run' },
      { label: 'Postgres', description: 'A server to run and patch' },
    ],
  },
  answers: [
    { direction: 'up', does: 'choose', label: 'SQLite' },
    { direction: 'left', does: 'choose', label: 'Postgres' },
  ],
} as Partial<AgendaItem>);

const A6 = item('A6', 40, {
  title: 'Merge the Inbox swipe card?',
  subject: 'Casen’s &F185 is green: merge it?',
  ask: { kind: 'permission' },
  blockingNow: true,
} as Partial<AgendaItem>);

const A7 = item('A7', 90, {
  title: 'Board v3 shots',
  subject: 'Kaiya is taking the board shots now',
  waitingOn: 'ferret',
} as Partial<AgendaItem>);

const resolved = (id: string, minutes: number, patch: Partial<ResolvedAgendaItem>): ResolvedAgendaItem =>
  ({
    ...item(id, minutes + 30, {}),
    resolvedAt: ago(minutes),
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
    resolutionNote: null,
    disposition: 'done',
    ...patch,
  }) as unknown as ResolvedAgendaItem;

const A1 = resolved('A1', 20, {
  title: 'Use the shared fixture?',
  subject: 'Use the shared fixture for the inbox tests?',
  ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
  response: { kind: 'multiple-choice', choice: 'Yes' },
  resolutionNote: 'And delete the old one once it is green.',
} as Partial<ResolvedAgendaItem>);
const A2 = resolved('A2', 75, {
  title: 'Restart the Warden?',
  subject: 'Restart the Warden after the config change?',
  ask: { kind: 'permission' },
  disposition: 'dismissed',
} as Partial<ResolvedAgendaItem>);

const board: AgendaSnapshot = {
  v: 1,
  sessionId: 'lead',
  items: [A6, A5, A7, A89, A70],
  resolved: [A1, A2],
  count: 5,
  parseErrors: 0,
  updatedAt: ago(1),
} as unknown as AgendaSnapshot;

const params = new URLSearchParams(location.search);
const target = (params.get('target') ?? null) as AgendaId | null;
const agendaMode = params.get('mode') !== 'off';

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="h-dvh" data-fixture="">
    <AgendaChatHarness agendaMode={agendaMode} board={board} ferret="Lizzette" now={NOW} target={target} />
  </div>,
);
