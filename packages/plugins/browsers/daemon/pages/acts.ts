import { targetRef } from '@ferretry/core-vault/contract';
import type { ActRunner, Op, RedactionScope, ResultOf, TargetRef } from '@ferretry/kernel/contract';
import { ApiError, REFUSAL_SENTENCES } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import type { BrowserAction, BrowserPageSnapshot, BrowserStatus } from '../../contract/wire/browser.ts';
import { mapStrings } from '../address-rule.ts';

/**
 * How a browser act reaches a page through the kernel's act runner (§4.7). Every page act names its `Op`; the kernel
 * asks the Vault's `InputHolds` inside the page's queue immediately before it runs, and closes a write-only answer to
 * an `Ack`. Page text, a page's address and its title are `reads`, built inside one `Redaction.read` (S16).
 */

/** The `page` target of one browser page (Vault's `input.targets:page`, part b). The key is the worker's page id. */
export const pageTarget = (pageId: string): TargetRef => targetRef('page', pageId);

/** The browser as a whole when an act names no page yet (start, stop, open before any page exists). */
export const browserTarget = (sessionId: string): TargetRef => targetRef('page', `browser:${sessionId}`);

/** The `Op` of each per-session browser action (`POST /v1/sessions/:sessionId/browser`). */
export function opOfAction(action: BrowserAction): Op {
  switch (action.action) {
    case 'start':
    case 'open':
    case 'new-page':
      return 'open';
    case 'stop':
    case 'close-page':
      return 'close';
    case 'navigate':
    case 'back':
    case 'forward':
    case 'reload':
    case 'resize':
    case 'activate-page':
      return 'navigate';
    case 'type':
      return 'type';
    case 'select':
    case 'check':
    case 'fill-form':
      return 'fill';
    case 'read':
      return 'read';
    case 'screenshot':
    case 'highlight':
      return 'picture';
    default:
      return 'press';
  }
}

/** The page an action is about: the one it names, else the session's active page, else the browser itself. */
export function targetOfAction(sessionId: string, action: BrowserAction, status: BrowserStatus): TargetRef {
  const named = (action as { readonly pageId?: unknown }).pageId;
  if (typeof named === 'string' && named !== '') return pageTarget(named);
  if (status.state === 'running' && 'activePageId' in status) return pageTarget(status.activePageId);
  return browserTarget(sessionId);
}

/** A refused act, as the fixed sentence of its code (I120: never the caught message). */
function refusedAct(refusal: { readonly refused: string }): ApiError {
  const sentence =
    (REFUSAL_SENTENCES as Readonly<Record<string, string>>)[refusal.refused] ?? REFUSAL_SENTENCES.holds_unavailable;
  return new ApiError(409, sentence, refusal.refused);
}

/** Unwraps an act's answer, or throws its refusal. */
export function acted<O extends Op>(result: Result<ResultOf<O>, { readonly refused: string }>): ResultOf<O> {
  if (!result.ok) throw refusedAct(result.error);
  return result.value;
}

/** A write-only act's answer for `fn`: a fresh `done`, never a value from the page. */
const DONE = Object.freeze({ status: 'done' as const });

/** Runs a write-only act on one target and throws its refusal. */
export async function writeAct(act: ActRunner, target: TargetRef, op: Op, work: () => Promise<unknown>): Promise<void> {
  const answer = await act(target, op, async () => {
    await work();
    return DONE as never;
  });
  const ack = acted(answer) as { readonly status?: string; readonly code?: string };
  if (ack.status === 'refused') throw refusedAct({ refused: ack.code ?? 'holds_unavailable' });
}

/**
 * A page snapshot with EVERY string in it masked (S16, for agent and person alike): its address, title and error, the
 * nested `pages` list, a download's name, a dialog's text, the text itself. Structural, not field by field — a snapshot
 * is the worker's own object, and a field it grows tomorrow is masked without anyone naming it here.
 */
export function maskedSnapshot<T extends Pick<BrowserPageSnapshot, 'url' | 'title'> & { readonly pageError?: string }>(
  scope: RedactionScope,
  page: T,
): T {
  return mapStrings(page, text => scope.text(text));
}

/** The status with every string in it masked, in every state (a stopped or failed browser's `error` too) (S16). */
export function maskedStatus(scope: RedactionScope, status: BrowserStatus): BrowserStatus {
  return mapStrings(status, text => scope.text(text));
}
