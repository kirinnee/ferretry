/**
 * Shared drafts: owner-only, twice (`operator` and `person`), and `fleet.use` like the sends they precede (c58-sec3).
 * Served raw, as today: the owner's own words, and an edit is a run of positions in the stored text, so a mask
 * of another width would move every offset after it (and the stream carries the same raw text).
 */
import { route, socket } from '@ferretry/kernel/manifest';
import { DRAFT_EDITED_AUDIT, DraftChanged } from '../../contract/index.ts';
import { FLEET_USE, fragment, OWN_DRAFT, PERSON, READ } from '../kit.ts';

export default fragment({
  routes: [
    route('GET /v1/ferrets/:ferretId/shared-draft', { ...PERSON, ...FLEET_USE, ...READ, ...OWN_DRAFT }),
    route('POST /v1/ferrets/:ferretId/shared-draft', {
      ...PERSON,
      ...FLEET_USE,
      audit: { record: DRAFT_EDITED_AUDIT },
      ...OWN_DRAFT,
    }),
  ],
  sockets: [
    // The live stream of one ferret's draft, every open composer kept in step. It carries the same raw text as the
    // two shared-draft routes, never built inside a `Redaction.read`, so it declares what they declare.
    socket('GET /v1/ferrets/:ferretId/shared-draft/stream', {
      minimum: 'operator',
      caller: 'person',
      ...FLEET_USE,
      audit: { skip: 'a stream; the edits it carries are audited as drafts' },
      ...OWN_DRAFT,
    }),
  ],
  data: { publishes: [DraftChanged] },
});
