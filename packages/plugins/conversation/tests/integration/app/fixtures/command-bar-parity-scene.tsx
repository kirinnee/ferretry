/**
 * Browser entry for "Ctrl+K's Tasks/Agenda chips follow what is installed" (L253): the REAL `CommandBar` with Conversation's
 * own work-search source over a daemon that answers from memory. Which of the Board and the Agenda has a screen here is the
 * scene's query: it is the `screenHref` the shell would give. No network. Every search is on `window.__asked`.
 *
 *   ?theme=<family>-<mode>
 *   &board=0    the Board is off (no screen draws a task)
 *   &agenda=0   the Agenda is off (no screen draws an ask)
 */
import type { PluginCommandContext } from '@ferretry/app';
import { CommandBar } from '@ferretry/app/ui';
import { useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { workSearchCommandSource } from '../../../../app/search/work-search-commands.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const off = [params.get('board') === '0' ? 'board' : '', params.get('agenda') === '0' ? 'agenda' : ''];

const asked: unknown[] = [];
(window as unknown as { __asked: unknown[] }).__asked = asked;

const AT = '2026-10-30T10:00:00.000Z';
const card = {
  kind: 'card',
  id: 'F10',
  project: '6f1c2f0e-3a4b-4c55-9d1e-0a7b8c9d1e2f',
  ferret: 'f1',
  title: 'Relay handshake',
  state: 'open',
  standing: 'Doing',
  updatedAt: AT,
  match: { field: 'title', line: 'Relay handshake' },
  score: 3,
};
const askHit = {
  kind: 'ask',
  id: 'A3',
  ferret: 'f1',
  title: 'Which relay',
  state: 'open',
  standing: 'open',
  updatedAt: AT,
  match: { field: 'title', line: 'Which relay' },
  score: 2,
};

const client = {
  call: async <Answer,>(route: string, init?: { query?: Record<string, string> }): Promise<Answer> => {
    asked.push({ route, query: init?.query });
    const kind = init?.query?.kind;
    const hits = [card, askHit].filter(hit => kind === undefined || hit.kind === kind);
    return { hits, total: hits.length, indexed: { cards: 1, asks: 1 } } as Answer;
  },
};

const screenHref: PluginCommandContext['screenHref'] = (daemon, plugin, screen) =>
  off.includes(plugin) ? undefined : `/d/${daemon}/${plugin}/${screen}`;

function Scene() {
  const [answers, setAnswers] = useState(0);
  const changed = useCallback(() => setAnswers(current => current + 1), []);
  const navigate = useCallback((href: string) => document.body.setAttribute('data-went', href), []);
  const source = useMemo(
    () =>
      workSearchCommandSource(
        { client, daemon: 'fake', navigate, screenHref, changed } as unknown as PluginCommandContext,
        { debounceMs: 20 },
      ),
    [navigate, changed],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `answers` re-lists when the source's answer arrives.
  const sources = useMemo(() => [source], [source, answers]);
  return <CommandBar open focusSignal={1} onClose={() => undefined} sources={sources} />;
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
