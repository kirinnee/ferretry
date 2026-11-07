/**
 * PAGE HOLDS, the page's side (§4.7, I116–I121). The Vault decides every hold (`InputHolds.decide`, by effect, never by a
 * list of tools) and keeps its evidence; Browsers names the target, runs every act through `kernel.act`, and words a
 * refusal or a failure the way today's agent tools did (`daemon/src/lib/agent-tools/service.ts`: `guardPage`,
 * `assertPageReadable`, `heldOrMasked`).
 *
 * - A page's hold target is `page:<page id>`, the daemon's own id for that tab (I121): page holds use their own names,
 *   so a page `app` never seals the terminal `app`, and a page opened again under the same name is another target.
 * - The decision is made inside that target's queue immediately before the act, for every caller (I119): `kernel.act`
 *   asks it there, and a pre-queue check only ever fails fast. A result a hold began under is withheld by the kernel's
 *   final check (`OutputGuard`, §7.3), not here.
 * - A failed call under a hold answers with the hold; every other message passes the redactor and fails closed to a
 *   fixed sentence (I120).
 */
import {
  type Ack,
  type ActRunner,
  type Content,
  type HoldRefusal,
  type Op,
  type Picture,
  REFUSAL_SENTENCES,
  type RefusalCode,
  type ResultOf,
  type TargetRef,
  targetRef,
} from '@ferretry/core-vault/contract';
import type { Redaction } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';

/** The hold target of one page: its kind is `page`, its key the daemon's page id (I121). */
export const pageHoldTarget = (pageId: string): TargetRef => targetRef('page', pageId);

/** Who a refusal is worded for: the ferret driving the page, or a person using the owner's tools. */
export type HoldAudience = 'agent' | 'person';

/**
 * A refusal in today's words. `input_pending` and `held` name the page and what still works; every other code is the
 * kernel's fixed sentence.
 */
export function holdSentence(code: RefusalCode, reference: string, audience: HoldAudience): string {
  switch (code) {
    case 'input_pending':
      return `an input request is pending on ${reference}; wait for it (input_wait) and do not type there yourself`;
    case 'held':
      return audience === 'agent'
        ? `${reference} is held: the owner's secret was just typed there, so you cannot read or picture it for a short while. You can still click and navigate; text reads come back once the page has moved on, pictures after the hold ends.`
        : `${reference} is held: a secret was just typed there. Look at it in the browser view, or try again shortly.`;
    default:
      return REFUSAL_SENTENCES[code];
  }
}

/** A refused act, as a tool error: its code and its sentence. */
export class PageHeld extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One act on a page through `kernel.act`: the hold is decided for the runtime op inside the page's queue, immediately
 * before `fn`, and a write-only result leaves as the kernel's closed `Ack`. A refusal is thrown as {@link PageHeld},
 * worded for `audience`.
 */
export async function actOnPage<O extends Op>(
  act: ActRunner,
  page: { readonly id: string; readonly reference: string },
  op: O,
  audience: HoldAudience,
  fn: () => Promise<ResultOf<O>>,
): Promise<ResultOf<O>> {
  const answered: Result<ResultOf<O>, HoldRefusal> = await act(pageHoldTarget(page.id), op, async () => await fn());
  if (!answered.ok)
    throw new PageHeld(answered.error.refused, holdSentence(answered.error.refused, page.reference, audience));
  return answered.value;
}

const NOTHING_SEEN: Content = Object.freeze({ kind: 'content' });
const NOTHING_PICTURED: Picture = Object.freeze({ kind: 'picture', mime: 'image/png', bytes: new Uint8Array() });
const DONE: Ack = Object.freeze({ status: 'done' });

/** What an act that does nothing answers, per op: no content, no picture, a bare `done`. */
function nothingFor<O extends Op>(op: O): ResultOf<O> {
  if (op === 'picture') return NOTHING_PICTURED as ResultOf<O>;
  if (op === 'read' || op === 'wait' || op === 'stream' || op === 'script') return NOTHING_SEEN as ResultOf<O>;
  return DONE as ResultOf<O>;
}

/** The sentence a failed call's message becomes when the redactor cannot run: it quotes none of the message. */
export const WITHHELD_FAILURE =
  'The call failed, and Ferretry could not open its secret store to check its message, so it is withheld.';

/**
 * A failed call's error as it may leave the daemon (I120; today's `heldOrMasked`). The same op on the same page is
 * asked again through `kernel.act` with an act that does nothing: if a hold refuses it now, the answer is the hold,
 * success or not, because an error can carry the page's words as well as a result can. Otherwise the message passes
 * the same redactor as a read (a page's thrown error can echo a value just typed), and fails CLOSED to a fixed
 * sentence when the redactor cannot run.
 */
export async function heldOrMasked<O extends Op>(
  ports: { readonly act: ActRunner; readonly redaction: Redaction },
  page: { readonly id: string; readonly reference: string } | undefined,
  op: O | undefined,
  audience: HoldAudience,
  error: unknown,
): Promise<Error> {
  if (error instanceof PageHeld) return error;
  if (page !== undefined && op !== undefined) {
    const again = await ports
      .act(pageHoldTarget(page.id), op, async () => nothingFor(op))
      .catch(() => ({ ok: false as const, error: { refused: 'holds_unavailable' as const } }));
    if (!again.ok)
      return new PageHeld(again.error.refused, holdSentence(again.error.refused, page.reference, audience));
  }
  const message = error instanceof Error ? error.message : undefined;
  if (message === undefined || message === '') return error instanceof Error ? error : new Error(WITHHELD_FAILURE);
  const masked = await ports.redaction.read(scope => scope.text(message)).catch(() => undefined);
  if (masked === message) return error as Error;
  return new Error(masked ?? WITHHELD_FAILURE);
}
