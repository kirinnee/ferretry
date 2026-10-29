/**
 * A ferret's chat as the agenda sits in it: the transcript with the full card laid over it, and above a
 * composer-shaped box the line, the drawer and the "re:" chips. The REAL `useAttentionAgenda` drives it;
 * only the data is invented and the answers go nowhere.
 */

import type { AttentionId, AttentionSnapshot } from '@ferretry/protocol';
import { type ReactElement, useMemo } from 'react';
import { Markdown } from '../src/components/markdown.tsx';
import { useAttentionAgenda } from '../src/features/attention/attention-agenda.tsx';
import { daemonConnection } from '../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../src/lib/daemon-scope.ts';

const CONNECTION = daemonConnection({
  daemonId: 'studio',
  baseUrl: 'https://studio.example.test',
  deviceId: 'harness',
});

const noop = async (): Promise<void> => undefined;
const CLIENT = { respond: noop, resolve: noop, dismiss: noop, needsInfo: noop, discuss: noop, progress: noop };

export interface AgendaChatHarnessProps {
  readonly board: AttentionSnapshot;
  readonly now: number;
  readonly ferret?: string;
  readonly agendaMode?: boolean;
  readonly desktop?: boolean;
  readonly target?: AttentionId | null;
  readonly onOpenResolved?: (id: AttentionId) => void;
}

export function AgendaChatHarness({
  board,
  now,
  ferret = 'Ottilie',
  agendaMode = true,
  desktop = false,
  target = null,
  onOpenResolved,
}: AgendaChatHarnessProps): ReactElement {
  const scope = useMemo(() => daemonSessionScope(CONNECTION, 'fr'), []);
  const agenda = useAttentionAgenda({
    agendaMode,
    client: CLIENT,
    connection: CONNECTION,
    desktop,
    ferret,
    focus: target === null ? null : { target, seq: 1 },
    now,
    ...(onOpenResolved === undefined ? {} : { onOpenResolved }),
    scope,
    snapshot: board,
    status: 'ready',
    swipeable: !desktop,
  });
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg" data-agenda-harness="">
      <div className="fy-agenda-split">
        <div className="kt-chat-surface flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="fy-chat-log">
            <div className="min-h-0 flex-1 overflow-y-auto p-panel">
              <article className="rounded-panel border border-border bg-surface p-panel text-cell" data-chat-line="">
                <p className="m-0 mb-xs text-meta text-faint">{ferret.toLowerCase()} · 2m</p>
                <Markdown
                  attentionReferenceResolver={id => board.items.some(entry => entry.id === id)}
                  text="Rebased and pushed. I raised !A3 about the release — pick an option when you can. Meanwhile I will keep going on the inbox."
                />
              </article>
            </div>
            {agenda.card}
          </div>
          <div className="fy-chat-input" data-safe-bottom="" data-session-input="">
            <div className="fy-chat-input__column">
              {agenda.above}
              <div
                className="rounded-panel border border-border bg-surface p-panel text-meta text-faint"
                data-agenda-harness-composer=""
              >
                Message {ferret.toLowerCase()}…
              </div>
            </div>
          </div>
        </div>
        {agenda.side}
      </div>
      {agenda.dockButton === null ? null : <div className="p-panel">{agenda.dockButton}</div>}
    </div>
  );
}
