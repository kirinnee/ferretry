/**
 * Which links serve which versions, for the item side: it refuses to retire a version a link serves and lists the
 * links on each version. A link counts while it is `pending`, `live` or `ending`, and a change in flight counts for
 * the version it is moving to as well as the one it leaves.
 */
import type { LinkServing, LinkUsage } from '../shared-catalogs/ports.ts';
import type { LinkDocumentStore } from './ports.ts';

export function linkUsageOf(documents: LinkDocumentStore): LinkUsage {
  return {
    serving: async (): Promise<readonly LinkServing[]> => {
      const serving: LinkServing[] = [];
      for (const link of (await documents.read()).links) {
        if (link.state !== 'pending' && link.state !== 'live' && link.state !== 'ending') continue;
        const versions = new Set([
          link.version,
          ...(link.pendingUpload === undefined ? [] : [link.pendingUpload.version]),
        ]);
        for (const version of versions) serving.push({ linkId: link.linkId, itemId: link.itemId, version });
      }
      return serving;
    },
  };
}
