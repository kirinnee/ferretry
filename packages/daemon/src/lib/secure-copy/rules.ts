import {
  COPY_MAX_RULES,
  type CopyOrigin,
  DEFAULT_PASTE_RULE_SETTINGS,
  type CopyPlanItem,
  type InputActor,
  type InputTargetFacts,
  type PasteRule,
  type PasteRuleCreate,
  type PasteRuleSettings,
} from '@ferretry/protocol';
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
 */

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
      this.rules = [...(stored?.rules ?? [])];
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
    return [...this.rules];
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
    if (this.rules.length >= COPY_MAX_RULES)
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
   * The owner allowed some items of a ferret's plan: each becomes a rule for THAT session allowing ONE paste,
   * until the plan's expiry. All or nothing: a set that would not fit is refused whole.
   */
  async fromPlan(
    caller: PasteRuleCaller,
    sessionId: string,
    planId: string,
    items: readonly CopyPlanItem[],
    expiresAt: number,
  ): Promise<readonly PasteRule[]> {
    const owner = requireOwner(caller);
    await this.ready;
    this.purge();
    if (this.rules.length + items.length > COPY_MAX_RULES)
      throw new SecureCopyError(
        'capacity',
        `that would hold more than ${String(COPY_MAX_RULES)} rules; remove some first`,
      );
    const now = new Date(this.ports.clock.now()).toISOString();
    const made = items.map(
      (item): PasteRule => ({
        id: this.ports.ids.ruleId(),
        from: item.from,
        to: item.to,
        sessionId,
        expiresAt: new Date(expiresAt).toISOString(),
        remaining: 1,
        used: 0,
        createdAt: now,
        createdBy: owner,
        plan: planId,
      }),
    );
    await this.persist(rules => [...rules, ...made]);
    return made;
  }

  /** The owner takes a rule back. Unknown is not found; a rule a paste is spending right now goes all the same. */
  async revoke(caller: PasteRuleCaller, id: string): Promise<void> {
    requireOwner(caller);
    await this.ready;
    if (!this.rules.some(rule => rule.id === id)) throw new SecureCopyError('not_found', 'there is no such rule');
    await this.persist(rules => rules.filter(rule => rule.id !== id));
  }

  /**
   * The rule that allows this paste, with one use TAKEN, or nothing. Synchronous, so two pastes can never both
   * spend a rule's last use. Before the store has been read nothing matches.
   */
  reserve(sessionId: string, from: CopyOrigin, facts: InputTargetFacts): string | undefined {
    if (!this.loaded) return undefined;
    this.purge();
    const rule = this.rules.find(
      candidate =>
        (candidate.sessionId === undefined || candidate.sessionId === sessionId) &&
        (candidate.remaining === undefined || candidate.remaining - this.taken(candidate.id) > 0) &&
        fromMatches(candidate, from) &&
        toMatches(candidate, facts, this.settings),
    );
    if (rule === undefined) return undefined;
    this.reserved.set(rule.id, this.taken(rule.id) + 1);
    return rule.id;
  }

  release(ruleId: string): void {
    this.give(ruleId);
  }

  /** The use stays taken until the store has recorded it, so a paste racing the write cannot spend it twice. */
  /**
   * The use stays taken until it is recorded, and it is recorded in memory EVEN IF the store cannot be written: a
   * failing disk loses the record of a use, never the use itself, so it cannot let a counted rule allow more pastes.
   */
  spent(ruleId: string): void {
    if (this.taken(ruleId) === 0) return;
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
    this.rules = this.rules.filter(rule => rule.expiresAt === undefined || Date.parse(rule.expiresAt) > now);
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

function toMatches(rule: PasteRule, facts: InputTargetFacts, settings: PasteRuleSettings): boolean {
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
          (settings.allowProfileTargets &&
            facts.program === undefined &&
            facts.profileProgram?.name === rule.to.program))
      );
    case 'browser':
      return facts.kind === 'browser' && facts.origin === rule.to.origin;
    case 'secret':
      // Only the EXACT name the owner approved: a rule can never write a secret it does not name.
      return facts.kind === 'secret' && facts.name === rule.to.name;
  }
}
