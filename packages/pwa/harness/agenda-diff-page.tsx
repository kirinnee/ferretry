/**
 * The item view's diff, merge and split, in a ferret's chat (`agenda-diff-screenshot.ts` bundles this and drives it):
 *
 *   ?agenda=A140    three versions, a stored conversation with words copied from chat, link meanings in the terms table
 *   ?agenda=A141    an open conversation a merge can join; it says "Merged in from !A143"
 *   ?agenda=A143    the closed item that was merged into A141
 *   ?agenda=A144    split from !A140 (A146 reads "Split into !A144, !A145")
 *   &old=1          the machine does not speak `agenda.conversation.1`: no diff, no merge, the rebuilt thread
 *
 * Every component is the REAL one (`useAgenda` through `AgendaChatHarness`, with the real fetch client and the real wire
 * flag); only the daemon is invented: a `fetch` stub answers the version, seen and conversation routes.
 */

import { type AgendaSnapshot, DAEMON_FEATURES } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import { ReferenceSurfaceProvider } from '../src/components/reference-surface.tsx';
import { AgendaWireDirectory } from '../src/lib/agenda-wire.ts';
import { type AppStore, StoreProvider } from '../src/lib/store.tsx';
import { AgendaChatHarness } from './agenda-chat.tsx';
import {
  A140,
  A141,
  A142,
  A143,
  A144,
  A145,
  A146,
  DIFF_CONVERSATION,
  DIFF_LIST,
  DIFF_NOW,
  DIFF_VERSIONS,
} from './agenda-diff.ts';

const params = new URLSearchParams(location.search);
const target = params.get('agenda') as never;
const old = params.get('old') === '1';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const KEPT = '/v1/sessions/fr/agenda/A140';
const summaryOf = (version: number) => DIFF_LIST.versions.find(entry => entry.version === version);

globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = new URL(String(input), location.href);
  if (!url.pathname.startsWith(KEPT)) return json({ error: 'gone', code: 'not-found' }, 404);
  const path = url.pathname.slice(KEPT.length);
  if (path === '/versions') return json(DIFF_LIST);
  if (path === '/seen') return json({ seen: DIFF_LIST.latest });
  if (path.startsWith('/versions/')) {
    const version = Number(path.split('/')[2]);
    const summary = summaryOf(version);
    const kept = DIFF_VERSIONS[version - 1];
    return summary === undefined || kept === undefined ? json({}, 404) : json({ ...summary, item: kept });
  }
  if (path === '/conversation') {
    const index = Number(url.searchParams.get('index') ?? '0');
    const entry = DIFF_CONVERSATION[index];
    return json({
      total: DIFF_CONVERSATION.length,
      index,
      offset: 0,
      ...(entry === undefined ? {} : { entry }),
      ...(index + 1 < DIFF_CONVERSATION.length ? { next: { index: index + 1, offset: 0 } } : {}),
    });
  }
  return json({}, 404);
}) as typeof fetch;

const wires = new AgendaWireDirectory();
wires.note(
  'studio' as never,
  {
    kind: 'read',
    health: {
      features: old ? [DAEMON_FEATURES.agendaWire] : [DAEMON_FEATURES.agendaWire, DAEMON_FEATURES.agendaConversation],
    },
  } as never,
);
const store = { agendaWire: wires, connections: { list: () => [] } } as unknown as AppStore;

// A140's thread keeps only its newest entries on the item; the rest is read through the conversation route.
const board = {
  v: 1,
  sessionId: 'fr',
  items: [A140, A141, A142, A144, A145, A146],
  resolved: [A143],
  count: 6,
  parseErrors: 0,
  updatedAt: new Date(DIFF_NOW - 60_000).toISOString(),
} as unknown as AgendaSnapshot;

// The chat's own proof: an `!A…` is a link only when it is on this session's ledger.
const ledger = new Set([...board.items, ...board.resolved].map(entry => entry.id as string));
const surface = { agendaReferenceResolver: (id: string) => ledger.has(id), onAgendaOpen: () => undefined };

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <StoreProvider store={store}>
    <ReferenceSurfaceProvider surface={surface}>
      <div className="h-dvh" data-fixture="">
        <AgendaChatHarness board={board} now={DIFF_NOW} target={target} />
      </div>
    </ReferenceSurfaceProvider>
  </StoreProvider>,
);
