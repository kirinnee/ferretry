/**
 * The browser entry for "an agenda item is drawn as Durian hypermedia": the REAL `AgendaItemView` over an item whose
 * body holds a ` ```terminal ` part and a reference, drawn by the REAL `agendaProse` through the shell's `ProseView`,
 * over the app's registry of REAL halves, so `shell.prose` is what Conversation really provides.
 *
 *   ?theme=<family>-<mode>
 *   ?plain=1     no one provides `shell.prose`: the shell's own Markdown draws every segment (the height baseline)
 *   ?text=1      a body with text only (a heading, a list, bold, a quote): what the baseline and the real draw must agree on
 */

import { WithRegisteredSurfaces } from '@ferretry/app/testing/settings-shell';
import { createRoot } from 'react-dom/client';
import { agendaProse } from '../../../../app/features/agenda/agenda-prose.tsx';
import { AgendaItemView } from '../../../../app/features/agenda/agenda-item-view.tsx';
import { agendaItem, choices } from '../../../support/app/agenda-inbox.tsx';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') ?? 'studio-light';
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.mode = theme.endsWith('dark') ? 'dark' : 'light';
const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const TERMINAL = ['```terminal', '$ bun test', 'ok 3 tests', '```'].join('\n');
const TEXT = [
  '## Plan',
  '',
  'First, the **short** version of what the ferret found.',
  '',
  '- one thing',
  '- another thing, with `code` in it',
  '',
  '1. then this',
  '2. then that',
  '',
  '> a quoted line',
].join('\n');

const item = agendaItem('A61', {
  title: 'Does the build pass?',
  subject: 'Does the build pass?',
  premise: 'Decide whether the build passes.',
  context: 'See &F12 for the card.',
  body: params.get('text') === '1' ? TEXT : `Here is the run:\n\n${TERMINAL}\n\nTracked as &F12.`,
  why: 'The release waits for it.',
  waitingSince: '2026-08-01T11:00:00.000Z',
  ask: choices('Yes', 'No'),
});

function Scene() {
  return (
    <WithRegisteredSurfaces none={params.get('plain') === '1'}>
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
            renderProse={agendaProse()}
            swipeable={false}
          />
        </div>
      </div>
    </WithRegisteredSurfaces>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
