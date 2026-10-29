/**
 * The Sessions page's "Needs you" card with the owner's long to-do, inside the phone shell it lives in: a
 * fixed `.kt-shell` (status-bar inset on top), the app bar, the page area, and the tab bar that owns the
 * home-indicator inset. Every component is the REAL one (`AttentionNeedsYou`); only the data and the
 * bars' contents are invented. `cards-fit-screenshot.ts` bundles this.
 */

import type { AttentionItem } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import { AttentionNeedsYou } from '../src/features/attention/attention-inbox-page.tsx';
import type { AttentionInbox } from '../src/hooks/use-attention-inbox.ts';
import type { InboxCard } from '../src/lib/attention-inbox.ts';
import { DeferredAttentionActions, inboxCardKey } from '../src/lib/attention-inbox.ts';
import { daemonId } from '../src/lib/daemon-connection.ts';
import { sessionView } from '../tests/support/sessions.ts';

const NOW = Date.parse('2026-10-23T09:00:00.000Z');
const STUDIO = daemonId('studio');

const TASK = {
  id: 'A1',
  source: 'agent-raised',
  sourceRef: null,
  title: 'Sync secrets to ProtoDurian',
  subject: 'Point your Infisical GitHub secret sync at the new ProtoDurian org so diene’s secrets arrive there.',
  why: 'Point your Infisical GitHub secret sync at the new ProtoDurian org so diene’s secrets arrive there.',
  context: [
    '- Repo moves don’t carry AtomiCloud’s 25 org-wide secrets; 22 of them look synced from Infisical',
    '- Infisical’s own GitHub app for AtomiCloud is private, so it can’t be installed on ProtoDurian as-is',
    '- On GitHub Free, org-wide secrets only reach public repos; private repos need a per-repo sync',
  ].join('\n'),
  steps: [
    'In Infisical, open the project that syncs to GitHub (look for a GitHub integration or sync)',
    'Add a new GitHub sync target: organization **ProtoDurian**, using Infisical’s own GitHub app (not the private AtomiCloud one)',
    'Sync at org level for the public repos, and per repo for private ones: diene-ratchet, diene-corpus, diene-ops-history, diene.helm-wrapper, ketone.shared, ketone.shared-wo-docker, ketone.shared-wo-docker-helm',
    'Check that the 22 already-synced secrets still arrive in each repo after the new target is added',
    'Tell me when it is done and I will re-run the migration',
  ],
  stepsDone: [],
  urgency: 'no rush',
  waitingSince: new Date(NOW - 11 * 60_000).toISOString(),
  howToResolve: 'Do the steps.',
  raisedBy: 'agent',
  raisedBySession: 'jaeda',
  raisedByName: 'Jaeda',
  ask: { kind: 'task' },
  answers: [
    { direction: 'right', does: 'done', label: 'Done' },
    { direction: 'left', does: 'needs-info', label: 'Need more info' },
    { direction: 'up', does: 'dismiss', label: 'Skip' },
  ],
} as unknown as AttentionItem;

const view = sessionView('jaeda', { config: { name: 'Liftoff EC2' } });
const card: InboxCard = {
  key: inboxCardKey(STUDIO, view.config.id, TASK.id),
  daemonId: STUDIO,
  machineName: 'studio',
  view,
  item: TASK,
};

const deferred = new DeferredAttentionActions(async () => undefined);
const inbox: AttentionInbox = {
  unread: [],
  total: 1,
  cards: [card],
  withFerret: [],
  reading: false,
  resolved: [],
  resolvedReading: false,
  loadResolved: () => undefined,
  deferred,
  deferredState: deferred.getSnapshot(),
  connectionFor: () => undefined,
};

const phone = new URLSearchParams(location.search).get('shell') !== 'desktop';

const Row = ({ name }: { readonly name: string }) => (
  <li className="rounded-control border border-border-soft bg-surface px-3 py-2 text-ui">{name}</li>
);

function Page() {
  return (
    <div className="kt-shell flex flex-col overflow-hidden" data-fixture="">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3 text-ui font-semibold">
        <span>318</span>
        <span className="rounded-control border border-border px-2 py-1">Liftoff EC2 offline</span>
      </header>
      <div className="relative min-h-0 min-w-0 flex-1 px-1 sm:px-3">
        <div className="flex h-full min-h-0 w-full flex-col">
          <AttentionNeedsYou daemonId={STUDIO} inbox={inbox} now={NOW} onNavigate={() => undefined} />
          <div className="flex min-h-0 flex-1 flex-col">
            <ul className="m-0 flex list-none flex-col gap-2 p-3">
              <Row name="Release train" />
              <Row name="Docs sweep" />
            </ul>
          </div>
        </div>
      </div>
      {phone ? (
        <nav aria-label="App" className="kt-tabbar" data-app-tab-bar="" data-safe-bottom="">
          {['Sessions', 'Attention', 'Tasks', 'Find', 'More'].map(label => (
            <span className="kt-tabbar__item" key={label}>
              <span className="kt-tabbar__label">{label}</span>
            </span>
          ))}
        </nav>
      ) : null}
    </div>
  );
}

const style = document.createElement('style');
style.textContent = phone
  ? ':root{--inset-top:47px;--inset-bottom:34px;}'
  : ':root{--inset-top:0px;--inset-bottom:0px;}';
document.head.append(style);
const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Page />);
