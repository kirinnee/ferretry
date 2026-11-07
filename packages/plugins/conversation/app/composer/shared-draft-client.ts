/**
 * Reading and editing one ferret's SHARED DRAFT — the owner's unsent composer, live on each of their
 * devices — on precisely the daemon that owns the ferret, through the half's own client.
 *
 * The daemon sequences every edit (the contract's `draft-ops.ts`); this module only carries them. Both
 * answers are parsed before anything trusts them, and an answer for another ferret is refused: a draft is
 * private, and showing somebody else's in this composer would be a leak. Both routes are owner-only and
 * serve the draft raw (`OWN_DRAFT`): nothing here routes a draft through a masking read.
 *
 * A refusal keeps the daemon's own code (`shared_draft_stale`, `shared_draft_too_long`, …) on the
 * client's `DaemonCallError` so the composer can tell "read the draft again" from "this is too long"
 * without matching on prose.
 */
import {
  type DraftEdit,
  type DraftEditResult,
  DraftEditResultSchema,
  type DraftSnapshot,
  DraftSnapshotSchema,
} from '../../contract/index.ts';
import { type ConversationCaller, DaemonCallError, type DaemonFerretScope } from './seam.ts';

/** The query naming an item's own draft; the chat's is the bare route. */
const sharedDraftItemQuery = (scope: DaemonFerretScope): Readonly<Record<string, string>> | undefined =>
  scope.item === undefined ? undefined : { item: scope.item };

const sharedDraftInit = (scope: DaemonFerretScope) => {
  const query = sharedDraftItemQuery(scope);
  return { params: { ferretId: scope.ferretId }, ...(query === undefined ? {} : { query }) };
};

/**
 * An answer is this composer's only when it names its ferret AND its slot: a draft under another slot
 * would otherwise be shown under an Agenda card.
 */
const ownFerret = (scope: DaemonFerretScope, snapshot: DraftSnapshot): DraftSnapshot => {
  if (snapshot.ferret !== scope.ferretId)
    throw new DaemonCallError(502, 'shared_draft_invalid', 'the daemon answered with another ferret’s draft');
  if (snapshot.slot !== scope.item)
    throw new DaemonCallError(502, 'shared_draft_invalid', 'the daemon answered with another draft slot');
  return snapshot;
};

/** The draft as the daemon holds it now. */
export const fetchSharedDraft = async (
  client: ConversationCaller,
  scope: DaemonFerretScope,
): Promise<DraftSnapshot> => {
  const answer = await client.call('GET /v1/ferrets/:ferretId/shared-draft', sharedDraftInit(scope));
  const parsed = DraftSnapshotSchema.safeParse(answer);
  if (!parsed.success) throw new DaemonCallError(502, 'shared_draft_invalid', 'the daemon answered with no draft');
  return ownFerret(scope, parsed.data);
};

/** Sends one edit and answers with it as the daemon sequenced it, and the draft after it. */
export const editSharedDraft = async (
  client: ConversationCaller,
  scope: DaemonFerretScope,
  edit: DraftEdit,
): Promise<DraftEditResult> => {
  const answer = await client.call('POST /v1/ferrets/:ferretId/shared-draft', {
    ...sharedDraftInit(scope),
    body: edit,
  });
  const parsed = DraftEditResultSchema.safeParse(answer);
  if (!parsed.success)
    throw new DaemonCallError(502, 'shared_draft_invalid', 'the daemon answered the edit with no draft');
  ownFerret(scope, parsed.data.snapshot);
  return parsed.data;
};
