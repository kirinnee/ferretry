import {
  COPY_MAX_RULES,
  type CopyOrigin,
  DEFAULT_PASTE_RULE_SETTINGS,
  type CopyRouteFrom,
  type CopyRouteTo,
  type InputActor,
  type InputTargetFacts,
  type PasteRule,
  type PasteRuleCreate,
  type PasteRuleSettings,
} from '@ferretry/protocol';
import { CODE_PROGRAMS, GETPASS_PROGRAMS } from '../input-requests/lock.ts';
import type { InputPasteRules } from '../input-requests/ports.ts';
import { SecureCopyError } from './errors.ts';

/**
 * THE OWNER'S PRE-APPROVAL RULES (docs/secure-copy.md): pastes allowed in advance, from a source to a destination.
 *
 * A rule only ever LOOSENS what an agent may do without asking, so every change to the set is the owner's: the
 * route refuses an agent caller before it reads a body, and this service refuses again unless the caller is the
 * owner at the machine or a paired device. A store that cannot be read is NO rules, never a guess: every paste
 * then waits for the owner.
 *
 * Matching runs on what the DAEMON observed: the copy's program or origin as it was captured, and the program
 * reading the destination terminal as the kernel proves it. A rule for the secret store matches nothing here: a paste
 * into the store always asks the owner unless a rule names that exact secret (the secret-store phase).
 *
 * The owner's SETTINGS live beside the rules, in the same document. `allowProfileTargets` lets a terminal rule also
 * match a program proved only through the owner's own Nix profile; it is off until the owner turns it on, and a store
 * that cannot be read holds it off with no rules.
 *
 * ## A FERRET'S PLAN RULES LIVE IN MEMORY ONLY
 *
 * The pastes an owner allowed on a ferret's task plan ({@link PasteRuleService.fromPlan}) are kept apart from the
 * owner's standing rules, in this process's memory: never written to the store, so a restart forgets them, and they
 * end with their plan (expiry, revoke, the session ending). Each allows the uses its line asked for (1 to 5). The
 * owner's own standing rules and the settings stay on disk, exactly as before.
 */

/** One paste a plan line allowed, kept in memory with the line it came from. */
interface PlanRule extends PasteRule {
  readonly plan: string;
  readonly line: number;
}

/** One paste line of a task plan the owner allowed, as {@link PasteRuleService.fromPlan} takes it. */
export interface PlanPaste {
  readonly line: number;
  readonly from: CopyRouteFrom;
  readonly to: CopyRouteTo;
  readonly uses: number;
}

/** What the rules file holds: the rules, and the owner's secure-copy settings beside them. */
export interface PasteRuleDocument {
  readonly rules: readonly PasteRule[];
  readonly settings: PasteRuleSettings;
}

export interface PasteRuleStore {
  /** The document as it rests; `undefined` for a store never written; throws when it cannot be read. */
  read(): Promise<PasteRuleDocument | undefined>;
  write(document: PasteRuleDocument): Promise<void>;
}

export interface PasteRulePorts {
  readonly store: PasteRuleStore;
  readonly clock: { now(): number };
  readonly ids: { ruleId(): string };
  /** Told, once, that the store could not be read or written; never told a value (rules hold none). */
  readonly warn: (message: string) => void;
}

/** Who may change the rules: only the owner, as the routes derived it. */
export type PasteRuleCaller =
  | { readonly kind: 'owner'; readonly actor: Extract<InputActor, { readonly kind: 'host' | 'device' }> }
  | { readonly kind: 'agent' };

export class PasteRuleService implements InputPasteRules {
  private rules: PasteRule[] = [];
  /** The pastes ferrets' task plans were allowed: in memory only, never in the store. */
  private planRules: PlanRule[] = [];
  private settings: PasteRuleSettings = DEFAULT_PASTE_RULE_SETTINGS;
  private loaded = false;
  /** Settles when the store has been read: a change made before then would be computed from nothing. */
  private readonly ready: Promise<void>;
  private markReady: () => void = () => undefined;
  /** Rules whose count a paste has taken and not yet spent or given back. */
  private readonly reserved = new Map<string, number>();
  /** Every write, one after another, each computed from the rules as the previous one left them. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly ports: PasteRulePorts) {
    this.ready = new Promise(resolve => {
      this.markReady = resolve;
    });
  }

  /** Reads the store once, at start. Damage is no rules, said once. */
  async load(): Promise<void> {
    try {
      const stored = await this.ports.store.read();
      // A plan's rules were written to the store before they moved to memory: a restart forgets a plan, so those are
      // dropped here too (and from the store with the next write), never honoured after it.
      this.rules = (stored?.rules ?? []).filter(rule => rule.plan === undefined);
      this.settings = stored?.settings ?? DEFAULT_PASTE_RULE_SETTINGS;
    } catch {
      this.rules = [];
      this.settings = DEFAULT_PASTE_RULE_SETTINGS;
      this.ports.warn(
        'the secure copy rules could not be read; every paste will ask the owner until they are set again',
      );
    }
    this.loaded = true;
    this.markReady();
  }

  /** Every rule still in force. Owner only. */
  list(caller: PasteRuleCaller): readonly PasteRule[] {
    requireOwner(caller);
    if (!this.loaded) throw new SecureCopyError('unavailable', 'the rules are still being read; try again in a moment');
    this.purge();
    return [
      ...this.rules,
      ...this.planRules.filter(rule => rule.remaining !== 0).map(({ line: _line, ...rule }): PasteRule => rule),
    ];
  }

  /** The owner's secure-copy settings. Owner only. */
  currentSettings(caller: PasteRuleCaller): PasteRuleSettings {
    requireOwner(caller);
    if (!this.loaded) throw new SecureCopyError('unavailable', 'the rules are still being read; try again in a moment');
    return this.settings;
  }

  /**
   * The owner changes the settings. Turning `allowProfileTargets` ON loosens what a rule matches: whether this caller
   * may (at the machine, or a device with a passkey for it) is the route's to decide; this only refuses an agent.
   */
  async changeSettings(caller: PasteRuleCaller, settings: PasteRuleSettings): Promise<PasteRuleSettings> {
    requireOwner(caller);
    await this.ready;
    await this.persist(rules => [...rules], settings);
    return this.settings;
  }

  /** The owner approves a route in advance. */
  async create(caller: PasteRuleCaller, request: PasteRuleCreate): Promise<PasteRule> {
    const owner = requireOwner(caller);
    await this.ready;
    this.purge();
    // ONE cap for the owner's rules and the plans' pastes together: the listing holds both, and must always parse.
    if (this.rules.length + this.planRules.length >= COPY_MAX_RULES)
      throw new SecureCopyError('capacity', `there are already ${String(COPY_MAX_RULES)} rules; remove one first`);
    const now = this.ports.clock.now();
    const rule: PasteRule = {
      id: this.ports.ids.ruleId(),
      from: request.from,
      to: request.to,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.expiresInSeconds === undefined
        ? {}
        : { expiresAt: new Date(now + request.expiresInSeconds * 1000).toISOString() }),
      ...(request.count === undefined ? {} : { remaining: request.count }),
      used: 0,
      createdAt: new Date(now).toISOString(),
      createdBy: owner,
    };
    await this.persist(rules => [...rules, rule]);
    return rule;
  }

  /**
   * The owner allowed some paste lines of a ferret's task plan: each becomes a rule for THAT session allowing the uses
   * its line asked for, until the plan's expiry. IN MEMORY ONLY: nothing is written to the store, so a restart forgets
   * them. All or nothing: a set that would not fit is refused whole, and nothing is made.
   */
  fromPlan(
    caller: PasteRuleCaller,
    sessionId: string,
    planId: string,
    pastes: readonly PlanPaste[],
    expiresAt: number,
  ): readonly PasteRule[] {
    const owner = requireOwner(caller);
    this.purge();
    if (this.rules.length + this.planRules.length + pastes.length > COPY_MAX_RULES)
      throw new SecureCopyError(
        'capacity',
        `that would hold more than ${String(COPY_MAX_RULES)} rules and planned pastes; remove a rule or revoke a plan first`,
      );
    const now = new Date(this.ports.clock.now()).toISOString();
    const made = pastes.map(
      (paste): PlanRule => ({
        id: this.ports.ids.ruleId(),
        from: paste.from,
        to: paste.to,
        sessionId,
        expiresAt: new Date(expiresAt).toISOString(),
        remaining: paste.uses,
        used: 0,
        createdAt: now,
        createdBy: owner,
        plan: planId,
        line: paste.line,
      }),
    );
    this.planRules = [...this.planRules, ...made];
    return made;
  }

  /** A task plan's pastes end (revoked, expired, its session ended): those of `lines`, or all of them. Never written. */
  endPlan(planId: string, lines?: readonly number[]): void {
    this.planRules = this.planRules.filter(
      rule => rule.plan !== planId || (lines !== undefined && !lines.includes(rule.line)),
    );
  }

  /** The uses each of a plan's paste lines has left, by line. A line with none left still answers 0. */
  planUses(planId: string): ReadonlyMap<number, number> {
    this.purge();
    return new Map(
      this.planRules
        .filter(rule => rule.plan === planId)
        .map(rule => [rule.line, Math.max(0, (rule.remaining ?? 0) - this.taken(rule.id))]),
    );
  }

  /** The owner takes a rule back. Unknown is not found; a rule a paste is spending right now goes all the same. */
  async revoke(caller: PasteRuleCaller, id: string): Promise<void> {
    requireOwner(caller);
    await this.ready;
    if (this.planRules.some(rule => rule.id === id)) {
      this.planRules = this.planRules.filter(rule => rule.id !== id);
      return;
    }
    if (!this.rules.some(rule => rule.id === id)) throw new SecureCopyError('not_found', 'there is no such rule');
    await this.persist(rules => rules.filter(rule => rule.id !== id));
  }

  /**
   * The rule that allows this paste, with one use TAKEN, or nothing. Synchronous, so two pastes can never both
   * spend a rule's last use. Before the store has been read nothing matches.
   */
  reserve(sessionId: string, from: CopyOrigin, facts: InputTargetFacts, profile?: string): string | undefined {
    if (!this.loaded) return undefined;
    this.purge();
    const fits = (candidate: PasteRule): boolean =>
      (candidate.sessionId === undefined || candidate.sessionId === sessionId) &&
      (candidate.remaining === undefined || candidate.remaining - this.taken(candidate.id) > 0) &&
      fromMatches(candidate, from) &&
      toMatches(candidate, facts, this.settings, profile);
    // The owner's standing rules first; then a plan's, the one ending soonest first, so its uses go before another's.
    const planned = [...this.planRules].sort(
      (left, right) => Date.parse(left.expiresAt ?? '') - Date.parse(right.expiresAt ?? ''),
    );
    const rule = this.rules.find(fits) ?? planned.find(fits);
    if (rule === undefined) return undefined;
    this.reserved.set(rule.id, this.taken(rule.id) + 1);
    return rule.id;
  }

  release(ruleId: string): void {
    this.give(ruleId);
  }

  /**
   * The use stays taken until it is recorded, and it is recorded in memory EVEN IF the store cannot be written: a
   * failing disk loses the record of a use, never the use itself, so it cannot let a counted rule allow more pastes.
   * A plan's rule is spent in memory at once: it was never in the store.
   */
  spent(ruleId: string): void {
    if (this.taken(ruleId) === 0) return;
    if (this.planRules.some(rule => rule.id === ruleId)) {
      this.planRules = this.planRules.map(rule =>
        rule.id === ruleId ? { ...rule, used: rule.used + 1, remaining: Math.max(0, (rule.remaining ?? 1) - 1) } : rule,
      );
      this.give(ruleId);
      return;
    }
    const spend = (rules: readonly PasteRule[]): PasteRule[] =>
      rules.flatMap(rule => {
        if (rule.id !== ruleId) return [rule];
        const remaining = rule.remaining === undefined ? undefined : rule.remaining - 1;
        if (remaining === 0) return [];
        return [{ ...rule, used: rule.used + 1, ...(remaining === undefined ? {} : { remaining }) }];
      });
    void this.persist(spend, undefined, { keepOnFailure: true })
      .catch(() => undefined)
      .finally(() => this.give(ruleId));
  }

  /** Uses of a rule taken by pastes and not yet given back or recorded. */
  private taken(ruleId: string): number {
    return this.reserved.get(ruleId) ?? 0;
  }

  private give(ruleId: string): void {
    const count = this.taken(ruleId);
    if (count <= 1) this.reserved.delete(ruleId);
    else this.reserved.set(ruleId, count - 1);
  }

  /** Drops expired rules from memory; the next write drops them from the store. */
  private purge(): void {
    const now = this.ports.clock.now();
    const live = <T extends PasteRule>(rule: T): boolean =>
      rule.expiresAt === undefined || Date.parse(rule.expiresAt) > now;
    this.rules = this.rules.filter(live);
    this.planRules = this.planRules.filter(live);
  }

  /**
   * One change, computed from the rules as the previous write left them. `keepOnFailure` is for a change that only
   * TIGHTENS (a use spent): it holds in memory even when the store cannot take it.
   */
  private async persist(
    change: (rules: readonly PasteRule[]) => PasteRule[],
    settings?: PasteRuleSettings,
    options: { readonly keepOnFailure?: boolean } = {},
  ): Promise<void> {
    const write = this.writes.then(async () => {
      const next = change(this.rules);
      const nextSettings = settings ?? this.settings;
      try {
        await this.ports.store.write({ rules: next, settings: nextSettings });
      } catch {
        if (options.keepOnFailure === true) this.rules = next;
        this.ports.warn('the secure copy rules could not be saved');
        throw new SecureCopyError('unavailable', 'Ferretry could not save the rules, so nothing changed');
      }
      this.rules = next;
      this.settings = nextSettings;
    });
    this.writes = write.catch(() => undefined);
    await write;
  }
}

function requireOwner(caller: PasteRuleCaller) {
  if (caller.kind !== 'owner')
    throw new SecureCopyError('forbidden', 'only the owner approves pastes in advance; an agent cannot');
  return caller.actor;
}

function fromMatches(rule: PasteRule, from: CopyOrigin): boolean {
  switch (rule.from.kind) {
    case 'command':
      // The bare name, as the daemon's PATH found it, and only a program no ferret could have swapped: a file
      // the daemon did not locate, or one this account can change (`~/.local/bin`, its own folder), is asked about.
      return (
        from.kind === 'command' &&
        from.program === rule.from.program &&
        from.path !== undefined &&
        from.replaceable !== true
      );
    case 'browser':
    case 'clipboard':
      // Never a field's value: the agent could have typed it there, on any page.
      return from.kind === rule.from.kind && from.origin === rule.from.origin && from.editable !== true;
  }
}

/**
 * Whether a program proved only through the owner's own profile may stand for a rule's program: the owner allowed
 * profile targets, and the name is no password or code program. (The proof itself already refused a name a
 * root-controlled folder holds: a rule for a system program is never met by the profile.)
 */
const profileMayStandFor = (settings: PasteRuleSettings, program: string): boolean =>
  settings.allowProfileTargets &&
  !GETPASS_PROGRAMS.has(program.toLowerCase()) &&
  !CODE_PROGRAMS.has(program.toLowerCase());

function toMatches(rule: PasteRule, facts: InputTargetFacts, settings: PasteRuleSettings, profile?: string): boolean {
  switch (rule.to.kind) {
    case 'terminal':
      // The PROVED program (every process of the foreground group, by the kernel), never the name ps shows: a ferret's
      // shell can call itself `sudo` and would be pasted into without a card. And line mode: a relay (`ssh -t`,
      // `docker exec -it`) reads key by key and hands them to a reader the proof never saw. Otherwise the owner is asked.
      // A program proved only through the owner's own profile counts when, and only when, the owner allowed that.
      return (
        facts.kind === 'terminal' &&
        facts.canonical === true &&
        (facts.program === rule.to.program ||
          (facts.program === undefined && profile === rule.to.program && profileMayStandFor(settings, profile)))
      );
    case 'browser':
      return facts.kind === 'browser' && facts.origin === rule.to.origin;
    case 'secret':
      // Only the EXACT name the owner approved: a rule can never write a secret it does not name.
      return facts.kind === 'secret' && facts.name === rule.to.name;
  }
}
