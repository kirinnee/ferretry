/**
 * What every `manifest/actions/*.actions.ts` fragment of Conversation shares: the descriptor pieces that repeat, and the
 * shape a fragment exports.
 *
 * A fragment is one feature's slice of the manifest (routes, sockets, tools, verbs, app actions, published events). The
 * generator (`scripts/gen/registries.ts`) lists every fragment into the git-ignored `manifest/generated/actions.ts` and
 * `manifest.ts` spreads that, so a feature adds a file and no list in `manifest.ts` is edited. The merged order is the
 * file names sorted as plain strings, and a list's order is part of the package's contract hash, so the numeric prefix
 * is what keeps every entry where the manifest first declared it.
 */
import { cap } from '../contract/index.ts';

export { manifestFragment as fragment } from '@ferretry/kernel/manifest';

// Shared descriptor pieces. The fields answer independent questions (§7.1); only what repeats is shared.
export const FERRET = { minimum: 'operator', caller: 'any', noStore: true } as const;
export const PERSON = { minimum: 'operator', caller: 'person', noStore: true } as const;
/** The body can show a ferret's words, a transcript, a pane or a draft: built inside one `Redaction.read` (§7.3). */
export const SECRETS = { guard: 'secrets' } as const;
export const OWN_DRAFT = {
  guard: { none: "the owner's own draft, person caller only, served raw as today: positional edits need the raw text" },
} as const;
export const READ = { audit: { skip: 'read' } } as const;
/**
 * Reading a ferret's words (its log, messages, question, send ledger, queue, handoffs, images, attachments) is `fleet.use`
 * (c58-sec1): a device the owner narrowed off it is refused, as it is on `GET /v1/ferrets/:ferretId`. Only a DEVICE is
 * governed: a ferret's own credential is never grant-governed and the owner's loopback token is ungoverned.
 */
export const FLEET_USE = { capability: cap('fleet', 'use') } as const;
export const ACK = { guard: { none: 'answers an acknowledgement; no pane, page or vault text' } } as const;
