import { randomBytes } from 'node:crypto';
import {
  canonicalPasteRule,
  canonicalProfileTargets,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  PASTE_RULE_ERROR_CODES,
  PASTE_RULE_REFUSAL_WORDS,
  PASTE_RULE_STAGES_MAX,
  type PasteRule,
  type PasteRuleCreate,
  PasteRuleCreateSchema,
  type PasteRuleRow,
  type PasteRuleSettings,
  type PasteRuleStaged,
  type PasteRuleStageId,
  type PasteRuleStageKind,
  type PasteRuleStager,
  type PasteRuleStageState,
  type PasteRuleStageView,
  pasteRuleApprovalSubject,
  pasteRuleRunsAnything,
  pasteRuleStagedRow,
  pasteRuleWords,
  profileTargetsApprovalSubject,
  profileTargetsWords,
} from '@ferretry/protocol';
import type { PasteRuleCaller, PasteRuleService } from './rules.ts';

/**
 * MAKING A PASTE RULE, OR LETTING RULES USE PROGRAMS IN YOUR OWN PROFILE, WITH A PASSKEY BOUND TO IT
 * (docs/secure-copy.md, owner decision !A244, secrev-1334 M2).
 *
 * Both widen what a ferret may have pasted unasked, so each is STAGED here first: the daemon holds the change, answers
 * its own line and rows (who staged it among them), and applies it only with a fresh proof bound to that one stage: a
 * rule takes an `approve-paste-rule` proof (`pasteRuleApprovalSubject(stage, canonical)`), the profile switch an
 * `allow-profile-targets` proof over the rules it widens (`profileTargetsApprovalSubject`). Every caller proves it, the
 * machine's own token included, so a held step-up window, an unlock or "ask again for each act" never stands in for one.
 * Removing a rule, turning the switch off and dropping a stage only narrow, and never come here.
 *
 * WHO MAY ANSWER A STAGE (secrev-1334 L1): a stage a device made is that device's alone. A stage the machine made
 * (`fy copy rules add`, `fy copy rules profile on`) is shown to every paired device, and one of them TAKES it (`bind`)
 * before it can ask the passkey; from then on it is that device's. The machine answers only its own, and can never
 * commit one. Each stager keeps at most {@link PASTE_RULE_STAGES_MAX} waiting: a new one drops its own oldest, never
 * another's (L2). Held in memory only, for a passkey challenge's life.
 */

const STAGE_TTL_MS = PASSKEY_CHALLENGE_TTL_SECONDS * 1_000;
/** How long a finished stage still answers its state, so `fy copy rules add` reads "Approved" rather than "gone". */
const FINISHED_STAGE_KEPT_MS = STAGE_TTL_MS;
const HOST_KEY = 'host';

type Owner = Extract<PasteRuleCaller, { kind: 'owner' }>;

type Change =
  | { readonly kind: 'rule'; readonly request: PasteRuleCreate }
  | { readonly kind: 'profile-targets'; readonly widens: readonly string[] };

interface Stage {
  readonly id: PasteRuleStageId;
  readonly change: Change;
  readonly canonical: string;
  /** The daemon's line and rows, the Staged row last: fixed at stage time, as the proof is. */
  readonly does: string;
  readonly rows: readonly PasteRuleRow[];
  readonly runsAnything: boolean;
  /** Who staged it: `host` or `device:<id>`. */
  readonly stager: string;
  /** The one device that may answer it: its stager, or the device that took a machine stage. */
  boundTo?: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  state: PasteRuleStageState;
  finishedAtMs?: number;
  rule?: string;
  committing?: boolean;
}

/** The commit came with no proof bound to its stage: the route answers the step-up demand. */
export class PasteRuleProofMissing extends Error {
  constructor() {
    super('this change needs a passkey confirmation bound to it');
    this.name = 'PasteRuleProofMissing';
  }
}

/** The stage is not waiting for this caller (approved, dropped, timed out, never made, or not this caller's). */
export class PasteRuleStageGone extends Error {
  readonly code: string = PASTE_RULE_ERROR_CODES.stageNotFound;
  constructor(message: string = PASTE_RULE_REFUSAL_WORDS.paste_rule_stage_not_found) {
    super(message);
    this.name = 'PasteRuleStageGone';
  }
}

/** The rules a profile stage would widen changed since it was staged: the proof would not cover the new list. */
export class ProfileTargetsChanged extends PasteRuleStageGone {
  override readonly code: string = PASTE_RULE_ERROR_CODES.profileTargetsChanged;
  constructor() {
    super(PASTE_RULE_REFUSAL_WORDS.profile_targets_changed);
    this.name = 'ProfileTargetsChanged';
  }
}

export interface PasteRuleStagePorts {
  readonly rules: Pick<PasteRuleService, 'create' | 'changeSettings'>;
  readonly clock: { now(): number };
  /** A paired device's name for the Staged row; absent or unknown, the row names its id's end. */
  readonly deviceName?: (deviceId: string) => Promise<string | undefined>;
  /** A fresh `prs_` id; random by default. */
  readonly stageId?: () => PasteRuleStageId;
}

const keyOf = (owner: Owner): string => (owner.actor.kind === 'device' ? `device:${owner.actor.deviceId}` : HOST_KEY);

function requireOwner(caller: PasteRuleCaller): Owner {
  if (caller.kind !== 'owner') throw new PasteRuleStageGone();
  return caller;
}

/** Each kind's proof subject, in its own domain: a proof for one kind never commits the other. */
const SUBJECTS: Readonly<Record<PasteRuleStageKind, (stage: PasteRuleStageId, canonical: string) => string>> = {
  rule: pasteRuleApprovalSubject,
  'profile-targets': profileTargetsApprovalSubject,
};

export class PasteRuleStages {
  readonly #stages = new Map<PasteRuleStageId, Stage>();

  constructor(private readonly ports: PasteRuleStagePorts) {}

  /** Stages a rule the owner is making: nothing is allowed until its passkey commits it. */
  async stage(caller: PasteRuleCaller, request: PasteRuleCreate): Promise<PasteRuleStaged> {
    const owner = requireOwner(caller);
    const parsed = PasteRuleCreateSchema.parse(request);
    return await this.#hold(
      owner,
      { kind: 'rule', request: parsed },
      canonicalPasteRule(parsed),
      pasteRuleWords(parsed),
      {
        runsAnything: pasteRuleRunsAnything(parsed.to),
      },
    );
  }

  /** Stages turning on programs in your own profile, bound to the rules it would widen now. Nothing changes until then. */
  async stageProfileTargets(caller: PasteRuleCaller, widens: readonly PasteRule[]): Promise<PasteRuleStaged> {
    const owner = requireOwner(caller);
    const ids = widens.map(rule => rule.id).sort();
    return await this.#hold(
      owner,
      { kind: 'profile-targets', widens: ids },
      canonicalProfileTargets(ids),
      profileTargetsWords(widens),
      { runsAnything: widens.some(rule => pasteRuleRunsAnything(rule.to)) },
    );
  }

  /**
   * What a proof for this stage, of this kind, from this device, is bound to — or nothing when it is not waiting for
   * that device, or is another kind's. The step-up options and the commit both read it here, so they cannot disagree.
   */
  boundSubjectOf(stage: PasteRuleStageId, kind: PasteRuleStageKind, deviceId: string): string | undefined {
    this.#sweep();
    const held = this.#stages.get(stage);
    return held?.state === 'waiting' &&
      held.committing !== true &&
      held.change.kind === kind &&
      held.boundTo === `device:${deviceId}`
      ? SUBJECTS[kind](held.id, held.canonical)
      : undefined;
  }

  /** The stages this caller may answer: a device's own and the machine's no other device took; the machine its own. */
  waiting(caller: PasteRuleCaller): readonly PasteRuleStaged[] {
    const owner = requireOwner(caller);
    this.#sweep();
    return [...this.#stages.values()]
      .filter(held => held.state === 'waiting' && held.committing !== true && this.#visible(owner, held))
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map(held => this.#staged(held));
  }

  /** Where a stage stands, for `fy copy rules add` and `fy copy rules profile on` waiting on the app. */
  view(caller: PasteRuleCaller, stage: PasteRuleStageId): PasteRuleStageView {
    const held = this.#own(requireOwner(caller), stage, { finished: true, visible: true });
    return { ...this.#staged(held), state: held.state, ...(held.rule === undefined ? {} : { rule: held.rule }) };
  }

  /**
   * A paired device TAKES a stage the machine made, to approve it with its own passkey: the first device to take it
   * holds it, and no other device sees it after. Taking it approves nothing.
   */
  bind(caller: PasteRuleCaller, stage: PasteRuleStageId): PasteRuleStaged {
    const owner = requireOwner(caller);
    if (owner.actor.kind !== 'device') throw new PasteRuleStageGone();
    const held = this.#own(owner, stage, { finished: false, visible: true });
    if (held.committing === true) throw new PasteRuleStageGone();
    held.boundTo = keyOf(owner);
    return this.#staged(held);
  }

  /** The rule request a waiting rule stage holds, so its commit asks again what its destination demands. */
  requestOf(caller: PasteRuleCaller, stage: PasteRuleStageId): PasteRuleCreate {
    const held = this.#own(requireOwner(caller), stage, { finished: false, visible: false });
    if (held.change.kind !== 'rule') throw new PasteRuleStageGone();
    return held.change.request;
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
    const { held, change } = this.#claimed(caller, stage, 'rule', claim);
    try {
      // The proof is bound to the stage's own bytes, and the rule is made from exactly those bytes.
      const rule = await this.ports.rules.create(caller, (change as Extract<Change, { kind: 'rule' }>).request);
      held.rule = rule.id;
      this.#finish(held, 'approved');
      return rule;
    } finally {
      held.committing = false;
    }
  }

  /**
   * TURNS ON programs in your own profile, with a fresh `allow-profile-targets` proof bound to the rules it widened when
   * staged. `widensNow` is that list read again: if it changed, the proof would not cover it, so nothing changes.
   */
  async commitProfileTargets(
    caller: PasteRuleCaller,
    stage: PasteRuleStageId,
    widensNow: readonly string[],
    claim: (subject: string) => boolean,
  ): Promise<PasteRuleSettings> {
    const peek = this.#own(requireOwner(caller), stage, { finished: false, visible: false });
    if (peek.change.kind === 'profile-targets' && canonicalProfileTargets(widensNow) !== peek.canonical)
      throw new ProfileTargetsChanged();
    const { held } = this.#claimed(caller, stage, 'profile-targets', claim);
    try {
      const settings = await this.ports.rules.changeSettings(caller, { allowProfileTargets: true });
      this.#finish(held, 'approved');
      return settings;
    } finally {
      held.committing = false;
    }
  }

  /** Drops a stage (the prompt dismissed, or Deny): nothing changes. Never needs a passkey. */
  drop(caller: PasteRuleCaller, stage: PasteRuleStageId): void {
    const held = this.#own(requireOwner(caller), stage, { finished: false, visible: true });
    if (held.committing === true) throw new PasteRuleStageGone();
    this.#finish(held, 'denied');
  }

  /** Checks the stage is this caller's to commit and of this kind, then claims its proof; marks it committing. */
  #claimed(
    caller: PasteRuleCaller,
    stage: PasteRuleStageId,
    kind: PasteRuleStageKind,
    claim: (subject: string) => boolean,
  ): { readonly held: Stage; readonly change: Change } {
    const held = this.#own(requireOwner(caller), stage, { finished: false, visible: false });
    if (held.committing === true || held.change.kind !== kind) throw new PasteRuleStageGone();
    if (!claim(SUBJECTS[kind](held.id, held.canonical))) throw new PasteRuleProofMissing();
    held.committing = true;
    return { held, change: held.change };
  }

  /**
   * Whether this caller may see a stage: the machine its own; a device its own, the one it took, and a machine stage no
   * device took yet.
   */
  #visible(owner: Owner, held: Stage): boolean {
    const key = keyOf(owner);
    if (owner.actor.kind !== 'device') return held.stager === key;
    return held.boundTo === key || (held.stager === HOST_KEY && held.boundTo === undefined);
  }

  /**
   * The stage, when this caller may act on it. `visible` lets the machine read and drop its own and a device take one
   * from the list; without it (a commit) only the device it is bound to may.
   */
  #own(
    owner: Owner,
    stage: PasteRuleStageId,
    options: { readonly finished: boolean; readonly visible: boolean },
  ): Stage {
    this.#sweep();
    const held = this.#stages.get(stage);
    if (held === undefined) throw new PasteRuleStageGone();
    const allowed = options.visible ? this.#visible(owner, held) : held.boundTo === keyOf(owner);
    if (!allowed) throw new PasteRuleStageGone();
    if (held.state !== 'waiting' && !options.finished) throw new PasteRuleStageGone();
    return held;
  }

  async #hold(
    owner: Owner,
    change: Change,
    canonical: string,
    words: { readonly does: string; readonly rows: readonly PasteRuleRow[] },
    flags: { readonly runsAnything: boolean },
  ): Promise<PasteRuleStaged> {
    const stager = keyOf(owner);
    const by: PasteRuleStager =
      owner.actor.kind === 'device'
        ? {
            kind: 'device',
            deviceId: owner.actor.deviceId,
            name: await this.ports.deviceName?.(owner.actor.deviceId).catch(() => undefined),
          }
        : { kind: 'host' };
    this.#sweep();
    // Each stager's own cap: its oldest goes, never another's.
    const own = [...this.#stages.values()].filter(
      held => held.stager === stager && held.state === 'waiting' && held.committing !== true,
    );
    for (const held of own.slice(0, Math.max(0, own.length - PASTE_RULE_STAGES_MAX + 1))) this.#finish(held, 'denied');
    const now = this.ports.clock.now();
    const id = this.#freshId();
    const held: Stage = {
      id,
      change,
      canonical,
      does: words.does,
      rows: [...words.rows, pasteRuleStagedRow(by, new Date(now).toISOString())],
      runsAnything: flags.runsAnything,
      stager,
      ...(owner.actor.kind === 'device' ? { boundTo: stager } : {}),
      createdAtMs: now,
      expiresAtMs: now + STAGE_TTL_MS,
      state: 'waiting',
    };
    this.#stages.set(id, held);
    return this.#staged(held);
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
    return {
      stage: held.id,
      kind: held.change.kind,
      does: held.does,
      rows: [...held.rows],
      runsAnything: held.runsAnything,
      expiresAt: new Date(held.expiresAtMs).toISOString(),
    };
  }
}
