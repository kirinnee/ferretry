import { LinkKept, SearchSources } from '../../contract/index.ts';
import { openingAttachmentsSource } from '../attachments/adapters/opening-attachments.ts';
import { buildReading } from '../reading.ts';
import type { ConversationFeature } from './types.ts';

/**
 * Part b of Conversation's daemon half: the transcript reader, links, attachments, renders and work search, built over
 * the same ports. The questions feature reads a Codex ferret's question from its transcript, and the queue feature
 * hands the Mailbox its stored originals, both through `f.late.reading`.
 */
export default {
  id: 'reading',
  register: f => {
    const b = buildReading({
      kernel: f.kernel,
      ferrets: f.ferrets,
      asks: f.asks,
      onKept: (ferret, link) => f.kernel.events.publish(LinkKept, { ferret, link }),
      workSources: () => f.hooks.contributions(SearchSources).map(contribution => contribution.item),
    });
    f.late.reading = b;
    return {
      routes: b.routes,
      port: b.api,
      tools: { search_work: b.tools.search_work },
      // The `guard: 'secrets'` routes that already build their answer inside their own redaction read (the transcript reads
      // and the work search), or serve bytes no mask may touch (a transcript image). Every other such route is masked.
      scrubsItsOwnBody: [
        'GET /v1/ferrets/:ferretId/logs',
        'GET /v1/ferrets/:ferretId/log-page',
        'GET /v1/ferrets/:ferretId/log-search',
        'GET /v1/ferrets/:ferretId/messages',
        'GET /v1/ferrets/:ferretId/transcript-images/:handle',
        'GET /v1/search',
        'POST /v1/search/related',
      ],
      // Fields a masked route serves as they are stored, beyond bytes and digests. A render's `payload` is the picture
      // itself, named by its sha256 (its id and its etag): a mask would change what that id names and break the picture,
      // and today never masked renders. Its `meta` (the alt text) is masked, exactly as `GET /v1/renders/:id/meta` masks it.
      verbatimFields: { 'GET /v1/renders/:id': ['payload'] },
      hooks: () => ({
        // The files a start was given (`fy start -f`): decoded, bounded and worded here, written and appended by Ferrets.
        // The one provider of this security-path hook (`takers: ['conversation']`), under its one key.
        'opening.attachments:opening': openingAttachmentsSource(),
      }),
      stop: () => b.stop(),
    };
  },
} satisfies ConversationFeature;
