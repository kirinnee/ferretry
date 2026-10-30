/**
 * A ferret's chat as the agenda sits in it: a header (where the "Agenda" dock button lives), the transcript, and
 * above a composer-shaped box the line, the drawer and the "re:" chips. An opened item is the full-height overlay
 * over the whole chat column. The REAL `useAgenda` drives it; only the data is invented and the answers go
 * nowhere.
 *
 * The composer is a box of one fixed height, so what the screenshot script measures — that nothing the agenda
 * does ever moves it in the normal chat — is the layout's doing, not the box's.
 */

import type { AgendaId, AgendaSnapshot } from '@ferretry/protocol';
import { type ReactElement, type ReactNode, useMemo } from 'react';
import { Markdown } from '../src/components/markdown.tsx';
import { useAgenda } from '../src/features/agenda/agenda.tsx';
import { daemonConnection } from '../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../src/lib/daemon-scope.ts';
import type { TranscriptEntry } from '../src/lib/session-screens.ts';

const CONNECTION = daemonConnection({
  daemonId: 'studio',
  baseUrl: 'https://studio.example.test',
  deviceId: 'harness',
});

const noop = async (): Promise<void> => undefined;
const CLIENT = { respond: noop, resolve: noop, dismiss: noop, needsInfo: noop, discuss: noop, progress: noop };

/** A wide screen with a mouse: the agenda can dock and the card has no swipe arrows. */
const harnessIsDesktop = (): boolean => window.innerWidth >= 1_024;

export interface AgendaChatHarnessProps {
  readonly board: AgendaSnapshot;
  readonly now: number;
  readonly ferret?: string;
  readonly agendaMode?: boolean;
  readonly desktop?: boolean;
  readonly target?: AgendaId | null;
  readonly entries?: readonly TranscriptEntry[];
  readonly live?: ReactNode;
}

const MESSAGES: readonly { readonly when: string; readonly text: string }[] = [
  { when: '14m', text: 'Picked up the relay work. The advertisement is stale, so I am checking the directory first.' },
  {
    when: '9m',
    text: 'Found it: the directory entry was written before the key rotation. I raised !A8 for the rotation steps.',
  },
  {
    when: '2m',
    text: 'Rebased and pushed. I raised !A3 about the release — pick an option when you can. Meanwhile I will keep going on the inbox.',
  },
];

export function AgendaChatHarness({
  board,
  now,
  ferret = 'Ottilie',
  agendaMode = true,
  desktop = harnessIsDesktop(),
  target = null,
  entries,
  live,
}: AgendaChatHarnessProps): ReactElement {
  const scope = useMemo(() => daemonSessionScope(CONNECTION, 'fr'), []);
  const agenda = useAgenda({
    agendaMode,
    client: CLIENT,
    connection: CONNECTION,
    desktop,
    ferret,
    focus: target === null ? null : { target, seq: 1 },
    now,
    scope,
    snapshot: board,
    status: 'ready',
    swipeable: !desktop,
    send: noop,
    ...(entries === undefined ? {} : { entries }),
    ...(live === undefined ? {} : { live }),
  });
  const chat = (
    <div
      className="kt-chat-surface flex min-h-0 min-w-0 flex-1 flex-col"
      data-agenda-focus={agenda.covered || undefined}
    >
      <div className="fy-chat-log" inert={agenda.covered || undefined}>
        <div className="flex min-h-0 flex-col justify-end gap-sm overflow-y-auto p-panel" style={{ gridArea: '1 / 1' }}>
          {MESSAGES.map(message => (
            <article
              className="rounded-panel border border-border bg-surface p-panel text-cell"
              data-chat-line=""
              key={message.when}
            >
              <p className="m-0 mb-xs text-meta text-faint">
                {ferret.toLowerCase()} · {message.when}
              </p>
              <Markdown
                agendaReferenceResolver={id => board.items.some(entry => entry.id === id)}
                text={message.text}
              />
            </article>
          ))}
        </div>
      </div>
      <div className="fy-chat-input" data-safe-bottom="" data-session-input="" inert={agenda.covered || undefined}>
        <div className="fy-chat-input__column">
          {agenda.above}
          <div
            className="flex h-14 items-center rounded-panel border border-border bg-surface px-panel text-cell text-faint"
            data-agenda-harness-composer=""
          >
            Message {ferret.toLowerCase()}…
          </div>
        </div>
      </div>
      {agenda.view}
    </div>
  );
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg" data-agenda-harness="">
      <header
        className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-panel"
        data-agenda-harness-header=""
      >
        <span className="text-ui font-semibold">{ferret}</span>
        <span className="text-meta text-faint">ferretry · studio</span>
        <span className="ml-auto flex items-center gap-2">{agenda.dockButton}</span>
      </header>
      {desktop && agendaMode ? (
        <div className="fy-agenda-split">
          {chat}
          {agenda.side}
        </div>
      ) : (
        chat
      )}
    </div>
  );
}
