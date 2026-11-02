import { randomBytes } from 'node:crypto';
import {
  canonicalPasteRule,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  PASTE_RULE_ERROR_CODES,
  PASTE_RULE_REFUSAL_WORDS,
  PASTE_RULE_STAGES_MAX,
  type PasteRule,
  type PasteRuleCreate,
  PasteRuleCreateSchema,
  type PasteRuleStaged,
  type PasteRuleStageId,
  type PasteRuleStageState,
  type PasteRuleStageView,
  pasteRuleApprovalSubject,
  pasteRuleRunsAnything,
  pasteRuleWords,
} from '@ferretry/protocol';
import type { PasteRuleCaller, PasteRuleService } from './rules.ts';

/**
 * MAKING A PASTE RULE WITH A PASSKEY BOUND TO IT (docs/secure-copy.md, owner decision !A244).
 *
 * A paste rule lets a ferret's sealed copy be pasted along one route with no tap, so making or widening one is
 * STAGED here first: the daemon holds the request, answers its own line and rows of what the rule allows, and makes the
 * rule only with a fresh `approve-paste-rule` passkey proof bound to that one stage
 * (`pasteRuleApprovalSubject(stage, canonical)`). Every caller proves it, the machine's own token included, so a held
 * step-up window, an unlock or "ask again for each act" never stands in for one. Removing a rule never comes here: it
 * only narrows and stays tap-free.
 *
 * Held in memory only, for a passkey challenge's life. A paired device may answer any stage (the machine's
 * `fy copy rules add` is confirmed in the app); the machine itself answers only its own, and can never commit one.
 */

const STAGE_TTL_MS = PASSKEY_CHALLENGE_TTL_SECONDS * 1_000;
/** How long a finished stage still answers its state, so `fy copy rules add` reads "Approved" rather than "gone". */
const FINISHED_STAGE_KEPT_MS = STAGE_TTL_MS;
const HOST_KEY = 'host';

type Owner = Extract<PasteRuleCaller, { kind: 'owner' }>;

interface Stage {
  readonly id: PasteRuleStageId;
  readonly request: PasteRuleCreate;
  readonly canonical: string;
  readonly owner: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  state: PasteRuleStageState;
  finishedAtMs?: number;
  rule?: string;
  committing?: boolean;
}

/** The commit came with no `approve-paste-rule` proof bound to its stage: the route answers the step-up demand. */
export class PasteRuleProofMissing extends Error {
  constructor() {
    super('making this paste rule needs a passkey confirmation bound to it');
    this.name = 'PasteRuleProofMissing';
  }
}

/** The stage is not waiting (approved, dropped, timed out, never made, or not this caller's). */
export class PasteRuleStageGone extends Error {
  readonly code = PASTE_RULE_ERROR_CODES.stageNotFound;
  constructor() {
    super(PASTE_RULE_REFUSAL_WORDS.paste_rule_stage_not_found);
    this.name = 'PasteRuleStageGone';
  }
}

export interface PasteRuleStagePorts {
  readonly rules: Pick<PasteRuleService, 'create'>;
  readonly clock: { now(): number };
  /** A fresh `prs_` id; random by default. */
  readonly stageId?: () => PasteRuleStageId;
}

const ownerKey = (owner: Owner): string =>
  owner.actor.kind === 'device' ? `device:${owner.actor.deviceId}` : HOST_KEY;

function requireOwner(caller: PasteRuleCaller): Owner {
  if (caller.kind !== 'owner') throw new PasteRuleStageGone();
  return caller;
}

export class PasteRuleStages {
  readonly #stages = new Map<PasteRuleStageId, Stage>();

  constructor(private readonly ports: PasteRuleStagePorts) {}

  /** Stages a rule the owner is making: nothing is allowed until its passkey commits it. The oldest past the cap goes. */
  stage(caller: PasteRuleCaller, request: PasteRuleCreate): PasteRuleStaged {
    const owner = requireOwner(caller);
    this.#sweep();
    const parsed = PasteRuleCreateSchema.parse(request);
    const waiting = [...this.#stages.values()].filter(held => held.state === 'waiting' && held.committing !== true);
    for (const held of waiting.slice(0, Math.max(0, waiting.length - PASTE_RULE_STAGES_MAX + 1)))
      this.#finish(held, 'denied');
    const now = this.ports.clock.now();
    const id = this.#freshId();
    const held: Stage = {
      id,
      request: parsed,
      canonical: canonicalPasteRule(parsed),
      owner: ownerKey(owner),
      createdAtMs: now,
      expiresAtMs: now + STAGE_TTL_MS,
      state: 'waiting',
    };
    this.#stages.set(id, held);
    return this.#staged(held);
  }

  /**
   * What an `approve-paste-rule` passkey for this stage is bound to, or nothing when it is not waiting. The step-up
   * options and the commit both read it here, so they cannot disagree.
   */
  boundSubjectOf(stage: PasteRuleStageId): string | undefined {
    this.#sweep();
    const held = this.#stages.get(stage);
    return held?.state === 'waiting' && held.committing !== true
      ? pasteRuleApprovalSubject(held.id, held.canonical)
      : undefined;
  }

  /** The rules waiting for a passkey that this caller may answer: a device sees every one, the machine its own. */
  waiting(caller: PasteRuleCaller): readonly PasteRuleStaged[] {
    const owner = requireOwner(caller);
    this.#sweep();
    return [...this.#stages.values()]
      .filter(held => held.state === 'waiting' && held.committing !== true && this.#mayAnswer(owner, held))
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map(held => this.#staged(held));
  }

  /** Where a staged rule stands, for `fy copy rules add` waiting on the app. */
  view(caller: PasteRuleCaller, stage: PasteRuleStageId): PasteRuleStageView {
    const held = this.#own(requireOwner(caller), stage, { finished: true });
    return { ...this.#staged(held), state: held.state, ...(held.rule === undefined ? {} : { rule: held.rule }) };
  }

  /** The request a waiting stage holds, so its commit asks again what its destination demands. */
  requestOf(caller: PasteRuleCaller, stage: PasteRuleStageId): PasteRuleCreate {
    return this.#own(requireOwner(caller), stage, { finished: false }).request;
  }

  /**
   * MAKES the staged rule. `claim` is the route's claim on a fresh `approve-paste-rule` proof bound to the subject it is
   * handed; without one this throws {@link PasteRuleProofMissing} and the stage keeps waiting. One commit per stage,
   * decided before the proof is spent.
   */
  async commit(
    caller: PasteRuleCaller,
    stage: PasteRuleStageId,
    claim: (subject: string) => boolean,
  ): Promise<PasteRule> {
    const held = this.#own(requireOwner(caller), stage, { finished: false });
    if (held.committing === true) throw new PasteRuleStageGone();
    if (!claim(pasteRuleApprovalSubject(held.id, held.canonical))) throw new PasteRuleProofMissing();
    held.committing = true;
    try {
      // The proof is bound to the stage's own bytes, and the rule is made from exactly those bytes.
      const rule = await this.ports.rules.create(caller, held.request);
      held.rule = rule.id;
      this.#finish(held, 'approved');
      return rule;
    } finally {
      held.committing = false;
    }
  }

  /** Drops a staged rule (the prompt dismissed, or Deny): nothing is allowed. Never needs a passkey. */
  drop(caller: PasteRuleCaller, stage: PasteRuleStageId): void {
    const held = this.#own(requireOwner(caller), stage, { finished: false });
    if (held.committing === true) throw new PasteRuleStageGone();
    this.#finish(held, 'denied');
  }

  #mayAnswer(owner: Owner, held: Stage): boolean {
    return owner.actor.kind === 'device' || held.owner === ownerKey(owner);
  }

  #own(owner: Owner, stage: PasteRuleStageId, options: { readonly finished: boolean }): Stage {
    this.#sweep();
    const held = this.#stages.get(stage);
    if (held === undefined || !this.#mayAnswer(owner, held)) throw new PasteRuleStageGone();
    if (held.state !== 'waiting' && !options.finished) throw new PasteRuleStageGone();
    return held;
  }

  #finish(held: Stage, state: Exclude<PasteRuleStageState, 'waiting'>): void {
    held.state = state;
    held.finishedAtMs = this.ports.clock.now();
  }

  #sweep(): void {
    const now = this.ports.clock.now();
    for (const [id, held] of this.#stages) {
      if (held.state === 'waiting' && held.committing !== true && now >= held.expiresAtMs)
        this.#finish(held, 'expired');
      if (held.state !== 'waiting' && now - (held.finishedAtMs ?? now) >= FINISHED_STAGE_KEPT_MS)
        this.#stages.delete(id);
    }
  }

  #freshId(): PasteRuleStageId {
    for (;;) {
      const id = this.ports.stageId?.() ?? (`prs_${randomBytes(12).toString('hex')}` as PasteRuleStageId);
      if (!this.#stages.has(id)) return id;
    }
  }

  #staged(held: Stage): PasteRuleStaged {
    const words = pasteRuleWords(held.request);
    return {
      stage: held.id,
      does: words.does,
      rows: [...words.rows],
      runsAnything: pasteRuleRunsAnything(held.request.to),
      expiresAt: new Date(held.expiresAtMs).toISOString(),
    };
  }
}
