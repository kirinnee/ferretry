/**
 * The browser entry for "Fork into a new ferret…": the REAL header Actions menu carrying the REAL `ForkRowPanel`'s row
 * (`?scene=menu`), and the REAL `ForkDialog` over an in-memory client (`?scene=form`). Fake data, no daemon.
 *
 *   ?theme=<family>-<mode>
 *   ?scene=menu | form
 *   &state=form | refused | done       (scene=form) the picker, a refused fork's own sentence, or the made fork
 *   &compact=1                          the phone layout of the menu
 */

import type { ActionsRowOffer } from '@ferretry/core-ferrets/contract';
import { DaemonCallError, ScreenHrefProvider } from '@ferretry/app';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationClientProvider } from '../../../../app/client.ts';
import { ForkDialog } from '../../../../app/fork/fork-dialog.tsx';
import { ForkRowPanel } from '../../../../app/slots/fork-row-panel.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const REFUSAL =
  'the conversation was written by Codex 0.99.0, a rollout format Ferretry has not tested, so it was not forked';

const say = (point: string, role: 'user' | 'assistant', text: string, timestamp: string) => ({
  point,
  role,
  text,
  timestamp,
  selectionBinding: `s2.${point}`,
});
const PAGE = {
  v: 1,
  ferret: 'f1',
  messages: [
    say(
      '10.0',
      'user',
      'Can you read the build log and tell me why the Static check keeps failing on this branch?',
      '2026-02-01T09:00:00.000Z',
    ),
    say('20.0', 'assistant', 'It is the lint step: one file was not formatted.', '2026-02-01T09:01:00.000Z'),
    say('30.0', 'user', 'Fix it and push.', '2026-02-01T09:02:00.000Z'),
    say('40.0', 'assistant', 'Done, pushed.', '2026-02-01T09:03:00.000Z'),
    say(
      '50.0',
      'user',
      'Now add a test for the empty case, and make sure it fails before the fix and passes after it, then explain what you changed in two sentences.',
      '2026-02-01T09:10:00.000Z',
    ),
    say('60.0', 'assistant', 'Added.', '2026-02-01T09:11:00.000Z'),
    say('70.0', 'user', 'Great. What is left?', '2026-02-01T09:20:00.000Z'),
    say('80.0', 'assistant', 'Only the docs.', '2026-02-01T09:21:00.000Z'),
  ],
  nextCursor: null,
  previousCursor: null,
};

const client = {
  call: async (route: string) => {
    if (route === 'GET /v1/ferrets/:ferretId/messages') return PAGE;
    if (route === 'POST /v1/ferrets/:ferretId/fork') {
      if (params.get('state') === 'refused') throw new DaemonCallError(409, 'fork_refused', REFUSAL);
      return { ferret: 'f2', worktree: { branch: 'fork/olive-01234567' }, attachments: 2 };
    }
    throw new Error(`no route ${route}`);
  },
  subscribe: () => () => undefined,
} as unknown as PluginClient;

const run = (id: string, label: string, group: ActionsRowOffer['group'], order: number): ActionsRowOffer => ({
  kind: 'run',
  id,
  label,
  group,
  order,
  run: () => undefined,
});

/**
 * The header's menu drawn with Ferrets' own stylesheet and class names (the page reads that sheet as a file: Conversation
 * reaches another package only through its contract, so it cannot import Ferrets' menu). The rows are OFFERED the way the
 * slot takes them: the other plugins' by hand, the fork row by the REAL `ForkRowPanel`.
 */
function Menu() {
  const [rows, setRows] = useState<Readonly<Record<string, ActionsRowOffer>>>({});
  const offer = useCallback((id: string, row: ActionsRowOffer | null) => {
    setRows(current => {
      const { [id]: _gone, ...rest } = current;
      return row === null ? rest : { ...rest, [id]: row };
    });
  }, []);
  useEffect(() => {
    for (const row of [
      run('add-mcp', 'Add MCP server…', 'ferret', 10),
      run('clear-stuck-messages', 'Clear stuck messages', 'ferret', 40),
      run('open-queue', 'Queue…', 'ferret', 45),
    ])
      offer(row.id, row);
  }, [offer]);
  const ordered = Object.values(rows).sort((a, b) => a.order - b.order);
  return (
    <>
      <ForkRowPanel {...({ canControl: true, ferret: 'f1', name: 'Zoe', offer } as unknown as PanelProps)} />
      <div style={{ padding: 16, display: 'flex', justifyContent: 'flex-end' }}>
        <div
          aria-label="Zoe actions"
          className="fy-actions-menu"
          data-compact={params.get('compact') === '1' ? '' : undefined}
          data-ferret-actions-menu=""
          role="menu"
        >
          <div className="fy-actions-menu__section" role="none">
            <div aria-hidden="true" className="fy-actions-menu__group">
              Ferret
            </div>
            {/* biome-ignore lint/a11y/useSemanticElements: the menu groups its items as the real header menu does, with role=group */}
            <div aria-label="Ferret" role="group">
              {ordered.map(row => (
                <button
                  className="fy-actions-menu__row"
                  data-ferret-action-item={row.id}
                  key={row.id}
                  role="menuitem"
                  type="button"
                >
                  <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
                    <circle cx="8" cy="8" fill="none" r="6" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                  <span className="fy-actions-menu__label">{row.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <ScreenHrefProvider href={(daemon, plugin, screen) => `/${daemon}/${plugin}/${screen}`}>
      <ConversationClientProvider client={client}>{children}</ConversationClientProvider>
    </ScreenHrefProvider>
  );
}

const scene = params.get('scene') ?? 'form';
const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <Frame>{scene === 'menu' ? <Menu /> : <ForkDialog ferret="f1" onClose={() => undefined} />}</Frame>,
  );
