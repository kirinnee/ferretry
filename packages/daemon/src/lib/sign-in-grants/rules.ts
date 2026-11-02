import {
  type AccountId,
  type AccountKey,
  type GrantMissReason,
  type SignInField,
  type SignInRuleId,
  type SignInRuleRecord,
  type SignInRuleSuspension,
  signInRuleEffective,
  signInRuleSuspensionOf,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import type { SessionProjectFactSource } from '../board-projects/session-projects.ts';
import type { SignInGrantLedger } from './ledger.ts';
import { type ScriptedOriginsView, type SignInGrant, scopeCovers, scriptedSince } from './matcher.ts';
import type { GrantFillAt, GrantVerdict, SignInGrantSource } from './plans.ts';

/**
 * STANDING SIGN-IN RULES AS GRANTS (docs/input-requests.md, "Standing rule fills"): each rule the owner approved with a
 * passkey, read from the rule service, as the shared matcher reads a grant. It shares the ONE ledger with the plan lines
 * (so the rate counts both and neither source forgets the other's attempts or pins), and goes through every check a plan
 * line does, plus a rule's own: its scope (1b), its account as approved (2b), its pinned 2FA key and fingerprint (8), no
 * page script on its places anywhere on the machine (15b), only forms with the owner's own history (17), and a code only
 * as a step of a sign-in it filled the password of.
 *
 * A rule fills only while, synchronously at the last check before the write ({@link RuleSignInGrants.holds}): the rule
 * service says its proof and facts checked out (`verified`, false while any check is pending or a suspension is being
 * written), it is still in force, it still covers the roles being typed, its scope covers the session, and no page
 * script ran on its places since it was approved. And, with I/O, right before the second match
 * ({@link RuleSignInGrants.verify}): its stored proof and its pinned facts are checked again, offline.
 */

/** The rule service, as the fills need it (`SignInRuleService`). */
export interface RuleGrantRules {
  fillable(): readonly SignInRuleRecord[];
  verified(id: SignInRuleId, revision: number): boolean;
  fillCheck(
    id: SignInRuleId,
    revision: number,
  ): Promise<'ok' | 'gone' | 'unknown' | 'suspended' | SignInRuleSuspension>;
  used(id: SignInRuleId, revision: number, sessionId: string): Promise<void>;
  suspend(id: SignInRuleId, because: SignInRuleSuspension, context?: { readonly revision?: number }): Promise<void>;
  scriptedOn(host: string): Promise<void>;
  scriptedEverywhere(): Promise<void>;
}

export interface RuleGrantPorts {
  readonly rules: RuleGrantRules;
  readonly ledger: SignInGrantLedger;
  readonly keys: (account: AccountId) => Promise<AccountKey | undefined>;
  /** Whether the daemon reports `sign-in-rules.1` (it does, since R3c-6): while it does not, no rule fills. */
  readonly advertised: () => boolean;
  /**
   * Whether terminal rules are offered (`terminalRulesOffered`: `sign-in-rules-terminal.1` beside `sign-in-rules.1`):
   * until they are, no terminal rule (sudo, su, doas) is offered to the matcher or holds at the write, whatever the
   * rules file says. Absent: none is.
   */
  readonly terminal?: () => boolean;
  /** The session's STAMPED board project, never one resolved from its folder, never Unfiled. */
  readonly stampedProject: (sessionId: string) => Promise<string | undefined>;
  readonly clock: { now(): number };
  /** A persisted taint or a use that could not be told to the rule service: said once, never thrown. */
  readonly warn?: (message: string) => void;
}

const grantIdOf = (id: SignInRuleId, revision: number): string => `rule:${id}:${String(revision)}`;

/**
 * A session's STAMPED board project, as its stored facts hold it: never resolved from its folder or its parent, and
 * never Unfiled, so a rule scoped to a project fills only for sessions started on that board (adoption can still be
 * steered, so project scope is a narrowing, not a wall).
 */
export async function stampedProjectOf(
  sessions: SessionProjectFactSource,
  sessionId: string,
): Promise<string | undefined> {
  const facts = await sessions.read(sessionId).catch(() => null);
  const project = facts?.projectId;
  return project === undefined || project === UNFILED_PROJECT_ID ? undefined : project;
}

export class RuleSignInGrants implements SignInGrantSource {
  /** Uses spent and not yet on disk, per grant: the rule service writes them in its queue, the ledger reads them now. */
  readonly #inflight = new Map<string, number>();
  /** Where a page script ran, by host, and when one ran where its origin couldn't be read: machine-wide, in RAM. */
  readonly #scripted = new Map<string, number>();
  #scriptedEverywhere: number | undefined;
  /** Agent scripts running now, anywhere on the machine: no rule fills while any is (secrev-1282a M2). */
  #running = 0;

  constructor(private readonly ports: RuleGrantPorts) {}

  get ledger(): SignInGrantLedger {
    return this.ports.ledger;
  }

  enabled(): boolean {
    return this.ports.advertised();
  }

  /**
   * Every rule as a grant, whatever its scope (the matcher's 1b says `out-of-scope` to the owner) and whatever its state
   * (a suspended, used-up or expired rule still says why on the owner's card). A rule's attempts and pins die with its
   * revision: a resumed rule starts with none.
   */
  of(_sessionId: string): readonly SignInGrant[] {
    const now = this.ports.clock.now();
    const records = this.#offered();
    const held = new Set(records.map(record => grantIdOf(record.body.id, record.body.revision)));
    this.ports.ledger.retain(id => !id.startsWith('rule:') || held.has(id));
    return records
      .map(record => this.#grantOf(record, now))
      .toSorted((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id));
  }

  async keyOf(account: AccountId): Promise<AccountKey | undefined> {
    return await this.ports.keys(account).catch(() => undefined);
  }

  /** One use spent: counted in RAM at once (the ledger reads it), then written by the rule service. */
  used(grant: SignInGrant, _at: number, sessionId: string): void {
    const rule = grant.rule;
    if (rule === undefined) return;
    this.#inflight.set(grant.id, (this.#inflight.get(grant.id) ?? 0) + 1);
    void this.ports.rules
      .used(rule.id, rule.revision, sessionId)
      .catch(() => this.ports.warn?.('a standing rule’s use could not be recorded'))
      .finally(() => {
        const left = (this.#inflight.get(grant.id) ?? 1) - 1;
        if (left <= 0) this.#inflight.delete(grant.id);
        else this.#inflight.set(grant.id, left);
      });
  }

  /** A miss that suspends: persisted and audited by the rule service, sticky, at this revision only. */
  async stopped(grant: SignInGrant, because: GrantMissReason): Promise<void> {
    const rule = grant.rule;
    const suspension = signInRuleSuspensionOf(because);
    if (rule === undefined || suspension === undefined) return;
    await this.ports.rules.suspend(rule.id, suspension, { revision: rule.revision }).catch(() => undefined);
  }

  /**
   * The rule checked again, offline, right before the second match: its stored proof against the registry and its pinned
   * facts against the accounts now. A failure suspends it (the rule service does, with its own reason). A registry or a
   * listing that can't be read fills nothing and suspends nothing.
   */
  async verify(grant: SignInGrant): Promise<GrantVerdict> {
    const rule = grant.rule;
    if (rule === undefined) return { ok: false };
    const check = await this.ports.rules.fillCheck(rule.id, rule.revision).catch(() => 'unknown' as const);
    switch (check) {
      case 'ok':
        return { ok: true };
      case 'unknown':
        return { ok: false };
      case 'gone':
        return { ok: false, reason: 'expired' };
      case 'suspended':
      case 'store-write-failed':
        return { ok: false, reason: 'suspended' };
      case 'passkey-removed':
        return { ok: false, reason: 'proof-invalid' };
      default:
        return { ok: false, reason: check };
    }
  }

  /**
   * THE LAST CHECK BEFORE TYPING, synchronous: the rule at this very revision is still in the service's memory, its
   * proof and facts checked out at the last look (`verified`), it is in force (or its spent use is still open for a later
   * step), it still covers every role being typed (a narrowing that dropped the code stops a code), its scope covers
   * the session, no agent script is running anywhere now, and, for a PAGE rule, no page script ran on its places since
   * it was approved (a terminal rule's write goes to a tmux pane no page script reaches, so a taint from a page whose
   * origin could not be read does not stop it).
   */
  holds(grant: SignInGrant, at: GrantFillAt): boolean {
    const rule = grant.rule;
    if (rule === undefined) return false;
    const record = this.#offered().find(each => each.body.id === rule.id && each.body.revision === rule.revision);
    if (record === undefined || record.suspended !== undefined) return false;
    if (this.#running > 0) return false;
    const page = record.body.surface === 'page';
    if (!this.ports.rules.verified(rule.id, rule.revision)) return false;
    const effective = signInRuleEffective(record, at.now);
    const left = (effective.remaining ?? Number.POSITIVE_INFINITY) - (this.#inflight.get(grant.id) ?? 0);
    const inForce =
      effective.status === 'active' || effective.status === 'used-up'
        ? left > 0 || this.ports.ledger.joinable(grant.id, at.sessionId, at.now)
        : false;
    return (
      inForce &&
      at.roles.every(role => effective.fields.includes(role)) &&
      scopeCovers(record.body.scope, at.sessionId, at.project) &&
      !(page && scriptedSince(this.scriptedOrigins(), record.body.pins.placeKeys, Date.parse(record.body.createdAt)))
    );
  }

  async projectOf(sessionId: string): Promise<string | undefined> {
    return await this.ports.stampedProject(sessionId).catch(() => undefined);
  }

  scriptedOrigins(): ScriptedOriginsView {
    return {
      hosts: this.#scripted,
      ...(this.#scriptedEverywhere === undefined ? {} : { everywhere: this.#scriptedEverywhere }),
      ...(this.#running > 0 ? { running: true } : {}),
    };
  }

  /**
   * AN AGENT SCRIPT IS ABOUT TO RUN (any session's `browser.eval`): until the returned function is called, no rule fills
   * anywhere. The page may move between the daemon's look and the script's world being made, so the origin the script
   * really runs in is known only once it answered; this closes that window. Memory only: a restart ends every script.
   */
  running(): () => void {
    this.#running += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#running -= 1;
    };
  }

  /**
   * A PAGE SCRIPT RAN on `host` (any session's `browser.eval`), or on a page whose origin couldn't be read
   * (`undefined`: it may have been any). Tainted in RAM at once, so a fill that follows in the same tick is refused, then
   * every rule pinned to that host (or every rule) is suspended on disk, so planted storage can't wait out a restart.
   */
  scriptedOn(host: string | undefined): void {
    const now = this.ports.clock.now();
    if (host === undefined) this.#scriptedEverywhere = now;
    else this.#scripted.set(host, now);
    void (host === undefined ? this.ports.rules.scriptedEverywhere() : this.ports.rules.scriptedOn(host)).catch(() =>
      this.ports.warn?.('a page script’s taint could not be saved; the rules it covers stay refused until a restart'),
    );
  }

  /** The rules a fill may read: every page rule, and terminal ones only while `sign-in-rules-terminal.1` is reported. */
  #offered(): readonly SignInRuleRecord[] {
    const terminal = this.ports.terminal?.() === true;
    return this.ports.rules.fillable().filter(record => terminal || record.body.surface !== 'terminal');
  }

  /** One rule as the matcher reads it: what is in force after the owner's narrowing, and what the passkey approved. */
  #grantOf(record: SignInRuleRecord, now: number): SignInGrant {
    const { body } = record;
    const effective = signInRuleEffective(record, now);
    const id = grantIdOf(body.id, body.revision);
    const remaining = (effective.remaining ?? Number.POSITIVE_INFINITY) - (this.#inflight.get(id) ?? 0);
    return {
      id,
      source: 'rule',
      rule: { id: body.id, revision: body.revision },
      surface: body.surface,
      signIn: body.signIn,
      accountKey: body.pins.accountKey,
      fields: new Set<SignInField>(effective.fields),
      pins: {
        placeKeys: body.pins.placeKeys,
        recipeVersion: body.pins.recipeVersion,
        identities: body.pins.identities,
      },
      scope: body.scope,
      ...(body.pins.factor === undefined ? {} : { factor: body.pins.factor }),
      accountPins: { id: body.pins.account, username: body.pins.username, factors: body.pins.factors },
      approvedAt: Date.parse(body.createdAt),
      // An expired rule (or one from a clock that ran back) reads as ended now.
      expiresAt:
        effective.status === 'expired'
          ? Math.min(now, Date.parse(effective.expiresAt))
          : Date.parse(effective.expiresAt),
      state: effective.status === 'suspended' ? 'stopped' : remaining <= 0 ? 'used-up' : 'in-force',
      remaining: Math.max(0, remaining),
    };
  }
}
