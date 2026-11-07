import type { AgendaConversationEntry, AgendaId } from '../../lib/protocol/agenda.ts';
import type { AgendaVersion, AgendaVersionSummary } from '../../lib/protocol/agenda-versions.ts';
import type { AgendaVersionDraft, AgendaVersionStore } from '../../lib/agenda/versions.ts';
import { SqliteAgendaVersionStore } from './sqlite-agenda-versions.ts';

type Operation =
  | { readonly kind: 'record'; readonly drafts: readonly AgendaVersionDraft[] }
  | { readonly kind: 'discard'; readonly drafts: readonly AgendaVersionDraft[] }
  | { readonly kind: 'list'; readonly item: AgendaId }
  | { readonly kind: 'get' | 'conversation'; readonly item: AgendaId; readonly version: number };

export type AgendaVersionsRequest =
  | { readonly probe: true }
  | (Operation & { readonly id: number; readonly directory: string; readonly sessionId: string });

export type AgendaVersionsValue =
  | undefined
  | AgendaVersion
  | readonly AgendaVersionSummary[]
  | readonly AgendaConversationEntry[];

export type AgendaVersionsResponse =
  | { readonly probe: true }
  | { readonly id: number; readonly ok: true; readonly value: AgendaVersionsValue }
  | { readonly id: number; readonly ok: false; readonly error: string };

export interface AgendaVersionsScope {
  onmessage: ((event: MessageEvent<AgendaVersionsRequest>) => void) | null;
  postMessage(message: AgendaVersionsResponse): void;
}

/** The worker owns all SQLite opens and commits. Serial requests also serialize them. */
export function serveAgendaVersions(
  scope: AgendaVersionsScope,
  create: (directory: string) => Required<AgendaVersionStore> = directory =>
    new SqliteAgendaVersionStore(() => directory),
): void {
  let held: { directory: string; store: Required<AgendaVersionStore> } | undefined;
  let tail = Promise.resolve();
  scope.onmessage = ({ data: request }) => {
    if ('probe' in request) return scope.postMessage({ probe: true });
    tail = tail.then(async () => {
      try {
        if (held?.directory !== request.directory)
          held = { directory: request.directory, store: create(request.directory) };
        const store = held.store;
        let value: AgendaVersionsValue;
        if (request.kind === 'record') await store.record(request.sessionId, request.drafts);
        else if (request.kind === 'discard') await store.discard(request.sessionId, request.drafts);
        else
          value =
            request.kind === 'list'
              ? await store.list(request.sessionId, request.item)
              : await store[request.kind](request.sessionId, request.item, request.version);
        scope.postMessage({ id: request.id, ok: true, value });
      } catch (error) {
        scope.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  };
}
