import {
  type Actor,
  type HoldDecision,
  type InputHolds,
  OP_EFFECTS,
  type Op,
  type RevealGrant,
  type TargetRef,
} from '@ferretry/kernel/contract';
import type { LoginObserver } from '../../lib/inputs/login-observer.ts';
import type { QuarantineRegistry } from '../../lib/inputs/quarantine.ts';
import type { RevealGrants } from '../../lib/inputs/reveals.ts';
import type { InputRequestService, InputRequestServiceDependencies } from '../../lib/inputs/service.ts';

/**
 * WHAT THE FERRETS DID TO A SURFACE, as the act runner tells Vault after each completed act (`InputHolds.observed`):
 * today's `loginActs`, which the agent tools told the login observer before each act. It is what voids the short
 * lock on a page the ferret steered (I93, I99, I100) and what a grant fill reads; no tool reports an act by hand.
 *
 * Only a ferret's (or the warden's) op that writes counts, as today only a call that may change a surface did. A
 * `TargetRef` names no ferret, so the act is filed for every session Vault holds something for, on the page it
 * touched (its hosts are not told, so it counts on every host). A page SCRIPT is also kept by the page's key for
 * good, because a script run before the ferret raised its card still voids that card's short lock and that ferret
 * may hold nothing yet: every session then reads that page as scripted (stricter, never looser).
 */
export class HeardActs {
  readonly #scriptedPages = new Set<string>();

  constructor(
    private readonly observer: Pick<LoginObserver, 'acted' | 'sessions'>,
    private readonly sessions: () => Iterable<string>,
  ) {}

  heard(target: TargetRef, op: Op, actor: Actor): void {
    if (actor !== 'ferret' && actor !== 'warden') return;
    const effects: readonly string[] = OP_EFFECTS[op] ?? ['writes'];
    if (!effects.includes('writes')) return;
    const page = target.kind === 'page';
    const script = op === 'script';
    if (page && script) this.#scriptedPages.add(target.key);
    const sessions = new Set([...this.observer.sessions(), ...this.sessions()]);
    for (const session of sessions)
      this.observer.acted(session, page ? 'browser' : 'terminal', script).placed(page ? { id: target.key } : undefined);
  }

  /** The observer as the input service reads it, with the scripted pages no session could be told about. */
  view(observer: LoginObserver): NonNullable<InputRequestServiceDependencies['observer']> {
    const scripted = this.#scriptedPages;
    return {
      delivered: async delivery => await observer.delivered(delivery),
      codeTyped: async typed => await observer.codeTyped(typed),
      tainted: (session, kind, since) =>
        (kind === 'browser' && scripted.size > 0) || observer.tainted(session, kind, since),
      pageSteer: (session, page, since) =>
        scripted.has(page.id) ? 'scripted' : observer.pageSteer(session, page, since),
    };
  }
}

/**
 * The bound `InputHolds` with the kernel's two additive, optional calls (rebuild/port-kernel a51f2cfdb), named exactly
 * as the kernel calls them; a local shape until that kernel lands on 5.0 and `InputHolds` carries them itself.
 *
 * - `prepare`: awaited inside the target's queue, then `decide` runs synchronously in the same continuation (a throw
 *   is `holds_unavailable`). Vault reads here what `decide` cannot await: the document a held page shows now.
 * - `observed`: after an allowed act's fn settled (a write-only op only when its closed Ack is `done`; never for a
 *   refused or thrown act; a throw is swallowed).
 */
export interface BoundInputHolds extends InputHolds {
  prepare?(target: TargetRef, op: Op, actor: Actor): Promise<void>;
  observed?(target: TargetRef, op: Op, actor: Actor): void;
}

type Answer = HoldDecision;
const RANK = (answer: Answer): number => (answer === 'allow' ? 0 : answer === 'allow-masked' ? 1 : 2);
const stricter = (a: Answer, b: Answer): Answer => (RANK(b) > RANK(a) ? b : a);

/**
 * `InputHolds` (§4.7) over today's quarantine registry, page holds and pending cards: the rules of the decide table,
 * each as input-requests.md keeps it. When several rows match, the most restrictive answer wins (refused over
 * `allow-masked` over allowed).
 *
 * - A pending card with any non-`code` field refuses every ferret op that writes; a card of only codes lets the
 *   ferret's `keys` and `type` through (I32).
 * - A terminal in quarantine refuses every op that reads, for the ferret AND the owner's tools; the ferret can still
 *   send keys; the owner's viewer sees it only with an unexpired reveal for that target that THIS Vault minted
 *   (`grants`; without them no reveal is honoured) (I72, I77).
 * - A page hold refuses every op that reads while the page shows a document a value went into, and every op that
 *   pictures for the whole window unless every hold on it follows its document (`until-moved-on`, then only while it
 *   shows one). Once the page left those documents, reads are answered masked (I116, I117). The document is the one
 *   `prepare` read; none read (no `prepare`, or the target cannot say) counts as still showing it.
 *
 * A `TargetRef` names no ferret, so every session holding something is asked: a key two ferrets share is held for
 * both, the strict direction.
 */
export class InputHoldsOverService implements BoundInputHolds {
  /** What `prepare` read for the `decide` that follows it in the same continuation: target → session → document. */
  readonly #fresh = new Map<string, Map<string, string | undefined>>();

  constructor(
    private readonly service: Pick<InputRequestService, 'openSessions' | 'pendingOn' | 'pageHeld' | 'pageDocument'>,
    private readonly quarantine: Pick<QuarantineRegistry, 'sessions' | 'until' | 'replayUntil'>,
    private readonly nowMs: () => number,
    private readonly acts?: HeardActs,
    private readonly grants?: Pick<RevealGrants, 'minted'>,
  ) {}

  async prepare(target: TargetRef, op: Op, actor: Actor): Promise<void> {
    const at = keyOf(target);
    this.#fresh.delete(at);
    if (actor === 'owner-input' || target.kind !== 'page') return;
    const effects: readonly string[] = OP_EFFECTS[op] ?? [];
    if (!effects.includes('reads') && !effects.includes('pictures')) return;
    const read = new Map<string, string | undefined>();
    for (const session of this.sessions())
      if (this.service.pageHeld(session, [target.key]) !== undefined)
        read.set(session, await this.service.pageDocument(session, target.key));
    this.#fresh.set(at, read);
  }

  decide(target: TargetRef, op: Op, actor: Actor, reveal?: RevealGrant): HoldDecision {
    const fresh = this.#fresh.get(keyOf(target));
    this.#fresh.delete(keyOf(target));
    // The owner's own delivery is what the holds protect; nothing holds it.
    if (actor === 'owner-input') return 'allow';
    const effects: readonly string[] = OP_EFFECTS[op];
    const reads = effects.includes('reads');
    const writes = effects.includes('writes');
    const pictures = effects.includes('pictures');
    const ferret = actor === 'ferret' || actor === 'warden';
    // Replay must close readers even when the session list is still empty (I82).
    if ((reads || pictures) && this.quarantine.replayUntil() !== undefined) {
      if (target.kind === 'terminal' && !this.revealed(actor, target, reveal)) return { refused: 'quarantined' };
      if (target.kind === 'page') return { refused: 'held' };
    }
    let answer: Answer = 'allow';
    for (const session of this.sessions()) {
      if (ferret && writes) {
        const typing = op === 'keys' || op === 'type';
        if (this.service.pendingOn(session, target, { typing }) !== undefined) return { refused: 'input_pending' };
      }
      if (target.kind === 'terminal' && (reads || pictures)) {
        if (this.quarantine.until(session, [target.key]) !== undefined && !this.revealed(actor, target, reveal))
          return { refused: 'quarantined' };
      }
      if (target.kind === 'page' && (reads || pictures)) {
        const held = this.service.pageHeld(session, [target.key]);
        if (held === undefined) continue;
        const document = fresh?.get(session);
        const shows = document === undefined || held.documents.length === 0 || held.documents.includes(document);
        if (pictures && (held.documentsOnly !== true || shows)) return { refused: 'held' };
        if (reads) answer = stricter(answer, shows ? { refused: 'held' } : 'allow-masked');
      }
    }
    return answer;
  }

  /** After each completed act: the login observer hears it ({@link HeardActs}). */
  observed(target: TargetRef, op: Op, actor: Actor): void {
    this.acts?.heard(target, op, actor);
  }

  private sessions(): readonly string[] {
    return [...new Set([...this.quarantine.sessions(), ...this.service.openSessions()])];
  }

  /**
   * Only the owner's viewer may look anyway, and only under a reveal this Vault minted (by identity: a cast shape is
   * not one) for this very target that has not run out.
   */
  private revealed(actor: Actor, target: TargetRef, reveal: RevealGrant | undefined): boolean {
    if (actor !== 'owner-viewer' || reveal === undefined) return false;
    if (this.grants?.minted(reveal) !== true) return false;
    if (reveal.target.kind !== target.kind || reveal.target.key !== target.key) return false;
    return Date.parse(reveal.until) > this.nowMs();
  }
}

const keyOf = (target: TargetRef): string => `${target.kind}\u0000${target.key}`;
