import { ApiError } from '../../api/error.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';
import type { ForeignHistoryListing, ImportedConversationDetail } from '../../imports/index.ts';

/** Read-only, daemon-scoped access to histories that predate Ferretry. */
export interface ForeignHistorySubsystem {
  list(): Promise<ForeignHistoryListing>;
  get(id: string): Promise<ImportedConversationDetail | undefined>;
}

/**
 * Foreign harness transcripts are not sessions: they have no Ferretry journal, lifecycle, or pane.
 * This deliberately separate namespace prevents a UI from offering resume/send controls against a
 * transcript whose only honest operation is reading it.
 */
export function foreignHistoryRoutes(subsystem: ForeignHistorySubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/imports/history',
      scope: 'admin',
      minimum: 'operator',
      noStore: true,
      handle: async () => {
        const listing = await subsystem.list();
        const skipped = new Map<
          string,
          { readonly harness: 'claude' | 'codex'; readonly reason: string; count: number }
        >();
        for (const item of listing.skipped) {
          const key = `${item.harness}\u0000${item.reason}`;
          const current = skipped.get(key);
          if (current === undefined) skipped.set(key, { harness: item.harness, reason: item.reason, count: 1 });
          else current.count += 1;
        }
        // A filename under a real harness home is private machine context. The browser needs a
        // title and a stable opaque key, not a path that reveals a user's directory layout.
        return jsonResponse({
          conversations: listing.conversations.map(({ source: _source, ...conversation }) => conversation),
          skipped: [...skipped.values()],
        });
      },
    },
    {
      method: 'GET',
      path: '/v1/imports/history/:importId',
      scope: 'admin',
      minimum: 'operator',
      noStore: true,
      handle: async context => {
        const id = context.params.get('importId');
        if (id === undefined || id.length === 0)
          throw new ApiError(400, 'the imported conversation id is not usable', 'invalid_import_id');
        const imported = await subsystem.get(id);
        if (imported === undefined)
          throw new ApiError(404, 'the imported conversation is unavailable or could not be read', 'not-found');
        const { events, source: _source, ...conversation } = imported;
        return jsonResponse({
          conversation,
          messages: events.flatMap(event =>
            event.kind === 'message' && event.role !== 'tool'
              ? [
                  {
                    id:
                      event.recordId ??
                      event.itemId ??
                      event.messageId ??
                      `${event.line ?? 0}:${event.blockIndex ?? 0}`,
                    role: event.role,
                    text: event.text,
                  },
                ]
              : [],
          ),
        });
      },
    },
  ];
}
