/**
 * The browser entry for "the agenda's choices from a list are the app's own SelectBox" (r11 S3c): over fake data,
 *
 *   ?scene=menu   the REAL inbox page opened on an item that has been edited, so its ⋯ menu carries the version picker
 *   ?scene=diff   the REAL version-compare panel (From / To) over three fake versions
 *   &theme=<family>-<mode>
 *   &versions=<n>  how many versions the item has (default: 2 in the menu scene, 3 in the diff scene); 8 or more is past
 *                  the select box's search threshold, so its list carries a search field
 *
 * The scene counts `onShow`-style writes on `window.__picked` so a test can assert the same write as before.
 */

import type { AgendaItem, AgendaVersionList } from '@ferretry/core-asks/contract';
import { createRoot } from 'react-dom/client';
import { AgendaInboxPage } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import { VersionDiffPanel } from '../../../../app/features/agenda/agenda-version-diff.tsx';
import type { AgendaVersionsView } from '../../../../app/features/agenda/use-item-lifecycle.ts';
import { daemonId } from '../../../../app/shell.ts';
import { agendaItem, choices, fakeInbox, InboxHarness, inboxCard } from '../../../support/app/agenda-inbox.tsx';
import { sessionView } from '../../../support/app/sessions.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('scene') ?? 'menu';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const phone = window.innerWidth < 768;
const machine = daemonId('ws');
const seen = window as unknown as { __loads: number[] };
seen.__loads = [];

/** `?versions=` (0 = not given): a count past the select box's 7-option search threshold gives the list a search field. */
const asked = Number(params.get('versions') ?? '0');
const editsOf = (count: number): NonNullable<AgendaItem['revisions']> =>
  Array.from({ length: count - 1 }, (_, at) => ({
    at: new Date(NOW - (count - at) * 3_600_000).toISOString(),
    by: 'agent' as const,
    changed: ['subject' as const],
    previous: { subject: `Which fix? (${String(at + 1)})` },
  }));

const edited = agendaItem('A1', {
  subject: 'Which fix should I apply?',
  ask: choices('Patch the parser', 'Rewrite the test'),
  premise: 'The parser drops the last row; the test also asserts the old behaviour.',
  revisions:
    asked > 0
      ? editsOf(asked)
      : [{ at: '2026-08-01T11:57:00.000Z', by: 'agent', changed: ['subject'], previous: { subject: 'Which fix?' } }],
} as Partial<AgendaItem>);

const fake = fakeInbox();
const cards = [
  inboxCard(edited, sessionView('zoe', { config: { teammate: 'zoe', name: 'Fixture running' } }), 'workshop', machine),
];

const versions = (count: number): AgendaVersionList =>
  ({
    sessionId: 's',
    id: 'A5',
    latest: count,
    versions: Array.from({ length: count }, (_, at) => ({
      version: at + 1,
      at: new Date(NOW - (count - at) * 3_600_000).toISOString(),
      by: 'ferret',
      change: at === 0 ? 'created' : 'edited',
      lifecycle: 'active',
    })),
  }) as AgendaVersionList;

const diffView: AgendaVersionsView = {
  list: versions(asked > 0 ? asked : 3),
  load: async version => {
    seen.__loads.push(version);
    return agendaItem('A5', { subject: 'Queue choice', whereWeAre: `Version ${String(version)} of the plan.` });
  },
};

function Scene() {
  if (scene === 'diff') {
    return (
      <div style={{ padding: 16, maxWidth: 640 }}>
        <VersionDiffPanel id="diff" now={NOW} versions={diffView} />
      </div>
    );
  }
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex' }}>
      <div style={{ width: phone ? '100%' : 420, minWidth: 0, height: '100%' }}>
        <InboxHarness
          cards={cards}
          fake={fake}
          render={inbox => (
            <AgendaInboxPage
              clock={fake.clock.now}
              inbox={inbox}
              now={NOW}
              onNavigate={() => undefined}
              open={{ daemonId: machine, sessionId: 'zoe', id: 'A1', settled: true }}
              phone={phone}
            />
          )}
        />
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
