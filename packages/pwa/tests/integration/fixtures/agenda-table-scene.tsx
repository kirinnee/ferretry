/**
 * The browser entry for "a markdown table never covers the agenda card's head": the REAL `AgendaItemView` over a
 * card whose body holds a two-column markdown table, rendered by the REAL `ChatProse`, above a stand-in composer.
 *
 *   ?theme=<family>-<mode>
 *   ?view=cards|table          the device's table view (phone only; a desktop always draws the table)
 *   ?wide=1                    a table whose columns cannot wrap (an unbroken token), so it must scroll sideways
 */

import { createRoot } from 'react-dom/client';
import { ChatProse } from '../../../src/components/chat-prose.tsx';
import { AgendaItemView } from '../../../src/features/agenda/agenda-item-view.tsx';
import { TABLE_VIEW_KEY } from '../../../src/lib/table-view-preference.ts';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
localStorage.setItem(TABLE_VIEW_KEY, params.get('view') === 'cards' ? 'cards' : 'table');

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const rows = [
  ['**Testbloom** (test reports)', "Yes. It's one app for our own GitHub orgs. Uploads and badges stay public."],
  ['**Rainbow** (a long one)', 'No. It runs on its own cloud account, so nothing here carries over to it at all.'],
  [
    '**CyanPrint**',
    'Unclear. Its registry and website are public, and anyone can use them. It also ships a CLI with its own release pipeline (apt, Brew, Scoop). That makes it a public product more than an internal app.',
  ],
  ['**Launchpad**', 'Yes. Internal only, so it follows the divine class like the rest of the platform apps.'],
  ['**Ledger**', 'No. It holds customer data and needs its own review before it can join anything.'],
  ['**Atlas**', 'Yes. A thin wrapper over the template with no state of its own.'],
];
const wide = params.get('wide') === '1';
const table = [
  '| App | Fits divine? |',
  '| --- | --- |',
  ...rows.map(([app, fit]) => `| ${app ?? ''} | ${wide ? `${fit ?? ''} ${'x'.repeat(60)}` : (fit ?? '')} |`),
].join('\n');

const prose = (text: string) => <ChatProse text={text} />;

const item = agendaItem('A60', {
  title: 'Which apps join the divine class?',
  subject: 'Which apps join the divine class?',
  premise: 'Decide which apps join the divine class.',
  context: 'The answers below are what the ferret found while reading each repo.',
  body: `Here is the list, one row per app.\n\n${table}\n\nIf CyanPrint stays outside divine, it can still borrow pieces from the template later.\n\n${table}\n\nThat is everything the ferret found.`,
  why: 'The platform team needs the list before the next release.',
  waitingSince: '2026-08-01T11:00:00.000Z',
  ask: choices('A', 'B'),
});

function Scene() {
  return (
    <div className="kt-chat-surface scene-chat">
      <div className="fy-chat-log">
        <AgendaItemView
          busy={false}
          error={null}
          ferret="Durian"
          history={[] as never}
          item={item}
          now={NOW}
          onAct={() => undefined}
          onClose={() => undefined}
          onNext={() => undefined}
          onPrevious={() => undefined}
          position={{ index: 1, total: 2 }}
          renderProse={prose}
          swipeable={false}
        />
      </div>
      <div className="fy-chat-input" data-safe-bottom="">
        <div className="fy-chat-input__column">
          <div className="scene-composer">Reply to Durian…</div>
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
