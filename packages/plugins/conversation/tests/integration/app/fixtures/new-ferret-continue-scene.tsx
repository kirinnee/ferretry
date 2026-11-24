/**
 * The browser entry for "Continue a past conversation" on the New ferret page: the REAL Ferrets New ferret screen and the
 * REAL Conversation panel in its `ferrets.new-ferret-continue` slot, both BUILT as the shell builds them (the app's own
 * registry), over a daemon that answers from memory. The conversation rows are the ones the REAL conversation index made
 * from synthetic transcripts (the test serves them at `/rows.json`); no real home is read. The runtime field is a stand-in
 * for Runtimes' picker (a plain box) that records the harness the page limited it to on `window.__harness`. Every call lands
 * on `window.__calls`; the page's own navigation is the browser's location.
 *
 *   ?theme=<family>-<mode>
 *   ?empty=1   the daemon holds no conversation
 */
import { NEW_FERRET_ACCOUNT_SLOT, NEW_FERRET_CONTINUE_SLOT } from '@ferretry/core-ferrets/contract';
import { RouterProvider } from '@ferretry/app/testing/router';
import {
  noteClientDaemon,
  registeredPanel,
  registeredScreen,
  WithSlotPanels,
} from '@ferretry/app/testing/settings-shell';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { LinkableConversation } from '../../../../contract/index.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const empty = params.get('empty') === '1';

const rows = empty ? [] : ((await (await fetch('/rows.json')).json()) as readonly LinkableConversation[]);

interface Recorded {
  route: string;
  query: unknown;
  headers: Record<string, string> | undefined;
  body: unknown;
}
const calls: Recorded[] = [];
const win = window as unknown as {
  __calls: Recorded[];
  __harness: string | undefined;
  __resumed: string | undefined;
};
win.__calls = calls;

const words = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .split(/\s+/u)
    .filter(word => word !== '');

/** What the daemon answers for the listing: the search words and the harness narrow it, as the daemon's index does. */
const listing = (query: Record<string, string> | undefined): unknown => {
  const wanted = words(query?.q ?? '');
  const found = rows
    .filter(row => query?.harness === undefined || row.harness === query.harness)
    .filter(row => query?.source !== 'ferretry' || row.keptBy !== undefined)
    .filter(row =>
      wanted.every(word => `${row.name ?? ''}\n${row.preview}\n${row.project}`.toLowerCase().includes(word)),
    );
  return { conversations: found, matched: found.length, skipped: 0 };
};

/** The harness each runtime name starts (Runtimes' `runtime.start`): `codex-*` runs Codex, any other Claude Code. */
const harnessOfRuntime = (runtime: string): string => (runtime.startsWith('codex') ? 'codex' : 'claude-code');

/**
 * `POST /v1/ferrets` as the daemon answers it, HONESTLY: a start that names a conversation resumes THAT conversation, and
 * only when this machine's index holds it for the harness asked (it is then staged first); otherwise it is refused with a
 * reason and starts nothing. A harness the runtime does not run is refused too. A start naming no conversation is a fresh
 * ferret, and its id says so. The conversation the daemon resumed is on `window.__resumed`.
 */
const start = (body: unknown): { id: string } => {
  const sent = body as { runtime: string; harness?: string; harnessConversation?: string };
  const runs = harnessOfRuntime(sent.runtime);
  if (sent.harness !== undefined && sent.harness !== runs)
    throw new Error(
      `runtime ${sent.runtime} runs the ${runs} harness, not ${sent.harness}, so the ferret was not started`,
    );
  if (sent.harnessConversation === undefined) return { id: 'fresh-1' };
  const held = rows.find(row => row.id === sent.harnessConversation && row.harness === runs);
  if (held === undefined)
    throw new Error(
      `No ${runs} conversation ${sent.harnessConversation} is on this machine. The ferret was not started, so nothing was resumed.`,
    );
  win.__resumed = held.id;
  return { id: 'resumed-1' };
};

const client = {
  call: async <Answer,>(
    route: string,
    init?: { headers?: Record<string, string>; body?: unknown; query?: Record<string, string> },
  ): Promise<Answer> => {
    calls.push({ route, query: init?.query, headers: init?.headers, body: init?.body });
    if (route === 'GET /v1/ferrets') return [] as Answer;
    if (route === 'GET /v1/links/conversations') return listing(init?.query) as Answer;
    if (route === 'GET /v1/links/conversations/:harness/:conversationId/preview')
      return {
        id: 'x',
        harness: 'claude-code',
        messages: [
          { role: 'user', text: 'Why is the login test flaky on CI?' },
          { role: 'assistant', text: 'It races the session cookie; I added a wait.' },
        ],
      } as Answer;
    if (route === 'POST /v1/ferrets') return start(init?.body) as Answer;
    throw new Error(`no route ${route}`);
  },
  subscribe: () => () => undefined,
};
noteClientDaemon(client, 'fake');

/** Stands in for Runtimes' picker: a plain box that remembers which harness the page limited the field to. */
const runtimeBox = (props: Record<string, unknown>) => {
  win.__harness = props.harness as string | undefined;
  // The page draws nothing of the form until the runtime field says its read is over; a stand-in has nothing to read.
  useEffect(() => (props.onSettled as (() => void) | undefined)?.(), [props.onSettled]);
  return (
    <input
      className="kt-input w-full font-mono"
      id={props.fallbackId as string}
      onChange={event => (props.onValueChange as (value: string) => void)(event.target.value)}
      value={props.value as string}
    />
  );
};

const NEW_FERRET = { plugin: 'ferrets', id: 'new-ferret', path: 'new', label: 'New ferret' };
const NewFerret = registeredScreen('ferrets', 'new-ferret', client);
// The route the page reads, with the query kept: a reload of this address draws the same scene.
window.history.pushState(null, '', `/d/fake/new${window.location.search}`);

createRoot(document.getElementById('root') as HTMLElement).render(
  <div data-scene-ready="">
    <WithSlotPanels
      slots={{
        [NEW_FERRET_CONTINUE_SLOT]: [registeredPanel('conversation', 'new-ferret-continue', client)],
        [NEW_FERRET_ACCOUNT_SLOT]: [{ plugin: 'runtimes', id: 'new-ferret-account', view: runtimeBox }],
      }}
    >
      <RouterProvider screens={[NEW_FERRET]}>
        <NewFerret />
      </RouterProvider>
    </WithSlotPanels>
  </div>,
);
