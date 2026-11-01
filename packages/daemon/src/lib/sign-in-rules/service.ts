import { randomBytes } from 'node:crypto';
import {
  type AccountId,
  type AccountRef,
  type AuditActor,
  type AuditDetail,
  type Place,
  SIGN_IN_RULE_ERROR_CODES,
  SIGN_IN_RULE_INELIGIBLE_CODES,
  SIGN_IN_RULE_INELIGIBLE_WORDS,
  SIGN_IN_RULE_MAX,
  SIGN_IN_RULE_STAGE_TTL_SECONDS,
  type SignInField,
  type SignInId,
  type SignInRuleBody,
  type SignInRuleDraft,
  SignInRuleDraftSchema,
  type SignInRuleEligibility,
  type SignInRuleFlag,
  type SignInRuleId,
  type SignInRuleList,
  type SignInRuleNarrow,
  SignInRuleNarrowSchema,
  type SignInRuleRecord,
  SignInRuleRecordSchema,
  type SignInRuleStaged,
  type SignInRuleStageId,
  type SignInRuleStageState,
  type SignInRuleStageView,
  type SignInRuleSuspension,
  type SignInRulesDocument,
  type SignInRuleView,
  type StoredStepUpProof,
  signInRuleBodyProblems,
  signInRuleClockProblems,
  signInRuleEffective,
  signInRuleLifetime,
  signInRuleNarrowed,
  signInRuleSuspensionWords,
} from '@ferretry/protocol';
import type { AuditSink } from '../audit/types.ts';
import type { PasteRuleCaller } from '../secure-copy/rules.ts';
import type { PasskeysChange } from '../step-up/passkeys-changed.ts';
import { type RuleListing, ruleDrift, samePins, snapshotPins } from './drift.ts';
import { ineligibleBecause, ruleSurfaceOf } from './eligibility.ts';
import { checkRuleProof, ruleChallenge, type SignInRuleProofPort } from './proof.ts';
import { auditText, ruleFieldWords, stagedSummary } from './words.ts';

/**
 * STANDING SIGN-IN RULES (docs/secrets.md, "Standing sign-in rules"): one owner-signed permission for Ferretry to fill
 * ONE sign-in, for any ferret unless the owner narrowed its scope, until it expires: a page sign-in for at most 90 days,
 * or sudo, su or doas in a terminal (the password only, root, red) for at most 7.
 *
 * ## ONLY THE OWNER, A FRESH PASSKEY EVERY TIME, BOUND TO THE BYTES
 *
 * Every owner method takes a {@link PasteRuleCaller} and refuses `{ kind: 'agent' }` as its first statement: the
 * routes refuse a ferret before the body, and this is the second wall. Creating, widening, resuming or renewing a rule
 * is a STAGE (the body is built here, every pin snapshotted by the daemon, nothing named by the caller) and a COMMIT
 * that takes the KEPT `approve-sign-in-rule` assertion whose challenge was derived from exactly that body
 * (`signInRuleChallenge(nonce, signInRuleSubject(stage, canonical))`). The commit derives the challenge AGAIN from the
 * bytes it is about to write and hands it to the claim, verifies the assertion offline over those same bytes, re-reads
 * the account listing and re-snapshots the pins (they must equal the staged ones, else nothing is made), then writes
 * the file and memory together, then audits. Narrowing and revoking need no passkey: they only take away.
 *
 * ## ON DISK, STRICT, FAILS CLOSED
 *
 * Rules live in `<state>/accounts/sign-in-rules.json`. A file that does not parse means ZERO rules (`health:
 * damaged`): every sign-in asks, the owner is warned, and it is audited; the owner's next write moves it aside, never
 * deletes it. Every record's proof is checked again, offline, at load, whenever a passkey or device goes, and
 * before every fill. A record whose proof does not verify, or whose pinned facts drifted, is SUSPENDED.
 *
 * ## SUSPENSION IS STICKY AND NEVER SILENT
 *
 * A suspension is persisted with its reason and audited (`sign-in-rule-suspended`), and the owner sees it in the list.
 * Changing the fact back resumes nothing: only a new stage and passkey does (`revision` + 1). No card is raised in a
 * ferret's session for it (R3c §18): a ferret learns nothing about rules.
 *
 * ## IT DECIDES WHAT A RULE IS, NOT WHETHER ONE FILLS
 *
 * The shared matcher decides that (`sign-in-grants/rules.ts` reads {@link fillable}, {@link verified} and
 * {@link fillCheck}). `sign-in-rules.1` stays unadvertised until the app ships, and until then no rule fills.
 */

/** The rules file. `read` rejects when the file cannot be read or does not parse: that is damage, never "no rules". */
export interface SignInRuleStore {
  /** The document, or `undefined` when there is no file yet. */
  read(): Promise<SignInRulesDocument | undefined>;
  write(document: SignInRulesDocument): Promise<void>;
  /** Copies a damaged file aside (`sign-in-rules.json.damaged-<stamp>`), never deleting it, before a fresh write. */
  setAside(stamp: string): Promise<void>;
}

/** The account store, as rules read it: the listing with each account's immutable key. Never a value. */
export interface SignInRuleAccountsPort {
  /** Rejects when the store cannot tell. */
  listing(): Promise<RuleListing>;
}

/** Whether a passkey exists to approve a rule with: on any paired device, or on this one. */
export interface SignInRulePasskeysPort {
  any(): Promise<boolean>;
  of(deviceId: string): Promise<boolean>;
}

export interface SignInRulePorts {
  readonly store: SignInRuleStore;
  readonly accounts: SignInRuleAccountsPort;
  readonly proofs: SignInRuleProofPort;
  readonly passkeys: SignInRulePasskeysPort;
  /**
   * A paired device's name now, for the list; absent once it was revoked. Never asked inside the change queue: reading
   * the devices may expire an idle one, and that revocation reaches this service through the queue.
   */
  readonly devices?: { label(deviceId: string): Promise<string | undefined> };
  readonly audit: AuditSink;
  readonly clock: { now(): number };
  readonly ids?: { ruleId?(): SignInRuleId; stageId?(): SignInRuleStageId; nonce?(): string };
  /** Said to the operator (stderr): a damaged file, a write that failed. Never a value or a name. */
  readonly warn: (message: string) => void;
  /**
   * Whether the daemon reports `sign-in-rules-terminal.1`: until it does, a sudo, su or doas sign-in can't have a rule
   * (`tool_not_covered`, at the stage and in the eligibility). Absent: it can't.
   */
  readonly terminalRules?: () => boolean;
}

/** A refusal with a next step of its own: the route answers `status` and `code` in these words. */
export class SignInRuleError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SignInRuleError';
  }
}

/** The commit was asked without the kept `approve-sign-in-rule` proof for its bytes: the route answers the step-up. */
export class SignInRuleProofMissing extends Error {
  constructor() {
    super('approving a standing sign-in rule needs a passkey confirmation for this one rule, from a paired device');
    this.name = 'SignInRuleProofMissing';
  }
}

type Owner = Extract<PasteRuleCaller, { kind: 'owner' }>;

interface Stage {
  readonly id: SignInRuleStageId;
  /** Who staged it: `host` (the machine, `fy rules add`) or `device:<id>`. */
  readonly owner: string;
  readonly nonce: string;
  /** The body without `approvedBy`, which is fixed when the approving device is known. */
  readonly unsigned: Omit<SignInRuleBody, 'approvedBy'>;
  /**
   * The rule a resume, renew or widen approves again: the revision it had and why it was suspended (or not) when the
   * owner looked. A commit refuses when either moved, so a suspension that lands after the stage is never cleared by a
   * passkey the owner gave without its reason in front of them (secrev-1274a L2).
   */
  readonly replaces?:
    | {
        readonly id: SignInRuleId;
        readonly revision: number;
        readonly suspended?: SignInRuleSuspension | undefined;
        /** The owner's narrowing as it stood (canonical JSON), so one made after the stage is never undone unseen. */
        readonly narrowed: string;
      }
    | undefined;
  readonly account: AccountRef;
  readonly username?: string | undefined;
  readonly place: Place;
  readonly autoRecipe: boolean;
  readonly expiresAtMs: number;
  /** The one device whose passkey may approve it, once known, and the body and challenge bound to it. */
  bound?: { readonly deviceId: string; readonly body: SignInRuleBody; readonly challenge: Uint8Array };
  machine?: { readonly askedAt: string };
  state: SignInRuleStageState;
  committing?: boolean;
  finishedAtMs?: number;
}

const STAGE_TTL_MS = SIGN_IN_RULE_STAGE_TTL_SECONDS * 1_000;
/** How long a finished stage still answers its state, so `fy rules add` reads "Approved" rather than "gone". */
const FINISHED_STAGE_KEPT_MS = STAGE_TTL_MS;
const HOST = 'host';
/** Most finished stages kept for a poll. */
export const FINISHED_STAGES_KEPT = 64;

const ownerKey = (owner: Owner): string => (owner.actor.kind === 'device' ? `device:${owner.actor.deviceId}` : HOST);
const auditActor = (owner: Owner): AuditActor =>
  owner.actor.kind === 'device' ? { kind: 'device', deviceId: owner.actor.deviceId } : { kind: 'host' };

function requireOwner(caller: PasteRuleCaller): Owner {
  if (caller.kind !== 'owner')
    throw new SignInRuleError(
      403,
      'forbidden',
      'only the owner makes, changes or reads standing rules; a ferret cannot',
    );
  return caller;
}

const randomRuleId = (): SignInRuleId => `sr_${randomBytes(12).toString('hex')}`;
const randomStageId = (): SignInRuleStageId => `srs_${randomBytes(12).toString('hex')}`;
/** 32 bytes from the system CSPRNG, as canonical unpadded base64url (43 characters). */
const randomNonce = (): string => randomBytes(32).toString('base64url');

const recordKey = (record: Pick<SignInRuleRecord, 'body'>): string =>
  `${record.body.id}:${String(record.body.revision)}`;

/** What a suspension's audit and the owner's list name, beside the rule. */
interface Suspending {
  readonly id: SignInRuleId;
  readonly because: SignInRuleSuspension;
  readonly revision?: number | undefined;
  readonly sessionId?: string | undefined;
}

export class SignInRuleService {
  #records: readonly SignInRuleRecord[] = [];
  #health: 'loading' | 'ok' | 'damaged' = 'loading';
  readonly #stages = new Map<SignInRuleStageId, Stage>();
  /** Records whose proof checked out against the registry as it stood at the last look, by `id:revision`. */
  #verified: ReadonlySet<string> = new Set<string>();
  /**
   * A check that could not be made yet: the accounts or the passkeys could not be read at load or after. Until a sweep
   * makes it, the rules it covers are not `verified`, so none fills (secrev-1274a L4, secrev-1274b L1, N3).
   */
  #unsettled = false;
  /**
   * Re-checks asked for and not finished: a passkey or device change from the moment it is signalled, and every settle
   * while it reads. While any is pending no rule is `verified` (secrev-1282b F3), so a fill can't pass on the answer of
   * a check that is being taken again.
   */
  #checking = 0;
  /** The answer of the last proof check `#recheckProof` made, for the set its caller builds. */
  #lastProof: 'ok' | 'passkey-removed' | 'proof-invalid' | 'unknown' = 'unknown';
  /**
   * Memory holds a suspension or a use the file does not: its write failed. Every later write carries it, and the sweep
   * and {@link flush} retry until one lands (secrev-1274b L3).
   */
  #dirty = false;
  /** Rules whose expiry was already audited, by `id:revision`. */
  readonly #expiredSaid = new Set<string>();
  /** Every change to the file and the records in memory runs here, one at a time. */
  #queue: Promise<unknown> = Promise.resolve();
  readonly #newRuleId: () => SignInRuleId;
  readonly #newStageId: () => SignInRuleStageId;
  readonly #newNonce: () => string;

  constructor(private readonly ports: SignInRulePorts) {
    this.#newRuleId = ports.ids?.ruleId?.bind(ports.ids) ?? randomRuleId;
    this.#newStageId = ports.ids?.stageId?.bind(ports.ids) ?? randomStageId;
    this.#newNonce = ports.ids?.nonce?.bind(ports.ids) ?? randomNonce;
  }

  // ── Life ──────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Reads the file, then checks every record: a body created in the future or a proof that does not verify suspends it
   * (`proof-invalid`), the approving passkey or device gone suspends it (`passkey-removed`), and a pinned fact that
   * drifted suspends it with that reason. The new suspensions are written and audited. A file that cannot be read or
   * does not parse means zero rules, `damaged`, said and audited.
   */
  async load(): Promise<void> {
    await this.#serial(async () => {
      let document: SignInRulesDocument | undefined;
      try {
        document = await this.ports.store.read();
      } catch (error) {
        this.#records = [];
        this.#health = 'damaged';
        const cause = error instanceof Error ? error.message : String(error);
        this.ports.warn(
          `the standing sign-in rules file could not be read (${auditText(cause)}): no rule fills until you approve one again`,
        );
        await this.#record('sign-in-rules', { action: 'sign-in-rules-damaged' }, { kind: 'host' }, 'failed');
        return;
      }
      // Still `loading` while every record is checked, so no list shows a rule as active before it was (secrev-1274a N3).
      this.#records = document?.rules ?? [];
      await this.#settle();
      this.#health = 'ok';
    });
  }

  /**
   * Inside the queue: checks every rule still in force against the registry and the accounts as they stand, suspends
   * what no longer holds, and leaves `#unsettled` set when either could not be read — then no rule is `verified`
   * until a later sweep settles it, so none fills while it cannot be checked.
   */
  async #settle(): Promise<void> {
    this.#checking += 1;
    try {
      await this.#settleChecked();
    } finally {
      this.#checking -= 1;
    }
  }

  async #settleChecked(): Promise<void> {
    this.#unsettled = false;
    const listing = await this.ports.accounts.listing().catch(() => undefined);
    if (listing === undefined && this.#records.length > 0) {
      this.#unsettled = true;
      this.ports.warn(
        'the accounts could not be read, so the standing rules were not checked against them: none fills',
      );
    }
    // The verified set is BUILT APART and swapped in before any suspension is written, so no rule reads verified while
    // its re-check runs or while its suspension is being saved (secrev-1274-delta F2). A rule whose drift could not be
    // checked is never in it.
    const suspending: Suspending[] = [];
    const verified = new Set<string>();
    for (const record of this.#records) {
      if (record.suspended !== undefined) continue;
      const because = await this.#recheck(record, listing);
      if (because !== undefined) suspending.push({ id: record.body.id, because });
      else if (listing !== undefined && this.#lastProof === 'ok') verified.add(recordKey(record));
    }
    this.#verified = verified;
    await this.#suspendAll(suspending);
  }

  /** Waiting stages past their time lapse; finished ones are kept a while for a poll, then forgotten. */
  sweep(): void {
    const now = this.ports.clock.now();
    for (const stage of this.#stages.values()) {
      if (stage.state === 'waiting' && stage.committing !== true && now >= stage.expiresAtMs)
        this.#finish(stage, 'expired');
      if (stage.state !== 'waiting' && now - (stage.finishedAtMs ?? now) >= FINISHED_STAGE_KEPT_MS)
        this.#stages.delete(stage.id);
    }
  }

  /**
   * Expiry: each rule that reached its end is audited once (`sign-in-rule-expired`), and a rule suspended because its
   * sign-in is gone is removed at its end (it can't be resumed). Run by the daemon's sweep.
   */
  async sweepRules(): Promise<void> {
    this.sweep();
    await this.#serial(async () => {
      if (this.#health !== 'ok') return;
      if (this.#unsettled) await this.#settle();
      if (this.#dirty) await this.#write(this.#records).catch(() => undefined);
      const now = this.ports.clock.now();
      const ended = this.#records.filter(record => now >= Date.parse(signInRuleEffective(record, now).expiresAt));
      for (const record of ended) {
        if (this.#expiredSaid.has(recordKey(record))) continue;
        this.#expiredSaid.add(recordKey(record));
        await this.#auditRule(record, 'sign-in-rule-expired', {}, { kind: 'host' }, 'daemon');
      }
      const gone = ended.filter(record => record.suspended?.because === 'sign-in-gone');
      if (gone.length === 0) return;
      const ids = new Set(gone.map(record => record.body.id));
      await this.#write(this.#records.filter(record => !ids.has(record.body.id))).catch(() => undefined);
    });
  }

  // ── The owner reads ───────────────────────────────────────────────────────────────────────────────

  /**
   * EVERY RULE AS THE OWNER READS IT (or one sign-in's, for "saving this suspends 1 standing rule"), the machine stages
   * waiting in the app, and whether the file was readable.
   */
  async list(caller: PasteRuleCaller, signIn?: SignInId): Promise<SignInRuleList> {
    requireOwner(caller);
    this.#ready();
    this.sweep();
    const listing = await this.ports.accounts.listing().catch(() => undefined);
    const records = this.#records.filter(record => signIn === undefined || record.body.signIn === signIn);
    const rules: SignInRuleView[] = [];
    for (const record of records) rules.push(await this.#view(record, listing));
    const stages = [...this.#stages.values()]
      .filter(stage => stage.state === 'waiting' && stage.owner === HOST && stage.machine !== undefined)
      .filter(stage => signIn === undefined || stage.unsigned.signIn === signIn)
      .map(stage => this.#staged(stage));
    return { health: this.#health === 'damaged' ? 'damaged' : 'ok', rules, stages };
  }

  /** Whether the owner could make a rule for this sign-in now, and why not; its rule, when it has one. */
  async eligibility(caller: PasteRuleCaller, signIn: SignInId): Promise<SignInRuleEligibility> {
    const owner = requireOwner(caller);
    this.#ready();
    const listing = await this.#listing();
    const found = listing.signIns.find(each => each.id === signIn);
    if (found === undefined) throw new SignInRuleError(404, 'not_found', `there is no sign-in ${signIn}`);
    const rule = this.#records.find(record => record.body.signIn === signIn)?.body.id;
    const because =
      (ruleSurfaceOf(found) === 'terminal' && !this.#terminalRules() ? 'tool-not-covered' : undefined) ??
      ineligibleBecause(found) ??
      ((await this.#passkeyFor(owner)) ? undefined : 'no-passkey');
    return because === undefined
      ? { signIn, eligible: true, ...(rule === undefined ? {} : { rule }) }
      : { signIn, eligible: false, because, ...(rule === undefined ? {} : { rule }) };
  }

  // ── Stage, approve, drop ──────────────────────────────────────────────────────────────────────────

  /**
   * STAGES A RULE from the owner's ticks: the daemon finds the sign-in, checks it can have a rule (a page password
   * sign-in, or sudo, su or doas in a terminal, with the owner's tapped history), snapshots every pin itself, and holds
   * the body for one challenge's life. The surface is the sign-in's own, never the caller's word: a terminal rule types
   * the password only, lasts a day unless the owner says otherwise, and a week at most. One stage per sign-in: a newer
   * one replaces a waiting one. Nothing is approved here.
   */
  async stage(caller: PasteRuleCaller, draft: SignInRuleDraft): Promise<SignInRuleStaged> {
    const owner = requireOwner(caller);
    this.#ready();
    this.sweep();
    const checked = SignInRuleDraftSchema.safeParse(draft);
    if (!checked.success)
      throw new SignInRuleError(400, 'bad_request', checked.error.issues[0]?.message ?? 'the rule is not usable');
    const ask = checked.data;
    const totp = ask.totp === true;
    const listing = await this.#listing();
    const target = listing.signIns.find(each => each.id === ask.signIn);
    const surface = target === undefined ? 'page' : ruleSurfaceOf(target);
    // Terminal rules are their own feature (`sign-in-rules-terminal.1`): until it is reported, none can be made.
    if (surface === 'terminal' && !this.#terminalRules())
      throw new SignInRuleError(
        409,
        SIGN_IN_RULE_INELIGIBLE_CODES['tool-not-covered'],
        SIGN_IN_RULE_INELIGIBLE_WORDS['tool-not-covered'],
      );
    // sudo, su and doas ask for the password alone: a username or a code ticked for one is refused before anything else.
    if (surface === 'terminal' && (totp || ask.fields.length !== 1 || ask.fields[0] !== 'password'))
      throw new SignInRuleError(400, 'bad_request', 'a terminal rule types the password only');
    const snap = snapshotPins(listing, ask.signIn, totp);
    if (!snap.ok) {
      if (snap.because === 'not-found')
        throw new SignInRuleError(404, 'not_found', `there is no sign-in ${ask.signIn}`);
      if (snap.because === 'no-code-key')
        throw new SignInRuleError(
          409,
          SIGN_IN_RULE_ERROR_CODES.noCodeKey,
          'the account has no 2FA key Ferretry makes codes for, so the code cannot be pre-approved',
        );
      throw new SignInRuleError(
        409,
        SIGN_IN_RULE_INELIGIBLE_CODES[snap.because],
        SIGN_IN_RULE_INELIGIBLE_WORDS[snap.because],
      );
    }
    const existing = this.#records.find(record => record.body.signIn === ask.signIn);
    if (ask.replaces !== undefined && existing?.body.id !== ask.replaces)
      throw new SignInRuleError(
        409,
        SIGN_IN_RULE_ERROR_CODES.conflict,
        'that rule is not this sign-in’s standing rule',
      );
    if (ask.replaces === undefined && existing !== undefined)
      throw new SignInRuleError(
        409,
        SIGN_IN_RULE_ERROR_CODES.conflict,
        'this sign-in already has a standing rule: renew or resume that one',
      );
    if (existing === undefined && this.#records.length >= SIGN_IN_RULE_MAX)
      throw new SignInRuleError(429, 'capacity', `this machine already has ${String(SIGN_IN_RULE_MAX)} standing rules`);
    if (!(await this.#passkeyFor(owner)))
      throw new SignInRuleError(
        409,
        SIGN_IN_RULE_ERROR_CODES.passkeyRequired,
        SIGN_IN_RULE_INELIGIBLE_WORDS['no-passkey'],
      );
    const now = this.ports.clock.now();
    const fields: SignInField[] = [...ask.fields, ...(totp ? (['totp'] as const) : [])];
    const unsigned: Omit<SignInRuleBody, 'approvedBy'> = {
      v: 1,
      id: existing?.body.id ?? this.#newRuleId(),
      revision: existing === undefined ? 1 : existing.body.revision + 1,
      signIn: ask.signIn,
      surface,
      fields,
      pins: snap.pins,
      scope: ask.scope ?? { kind: 'any' },
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(
        now + (ask.lifetimeSeconds ?? signInRuleLifetime(surface).defaultSeconds) * 1_000,
      ).toISOString(),
      ...(ask.uses === undefined ? {} : { uses: ask.uses }),
    };
    const problem = [...signInRuleBodyProblems(unsigned), ...signInRuleClockProblems(unsigned, now)][0];
    if (problem !== undefined) throw new SignInRuleError(400, 'bad_request', problem);
    // ONE STAGE PER SIGN-IN: a newer stage replaces one still waiting (never one being committed).
    for (const held of this.#stages.values())
      if (held.unsigned.signIn === ask.signIn && held.state === 'waiting' && held.committing !== true)
        this.#finish(held, 'denied');
    const stage: Stage = {
      id: this.#freshStageId(),
      owner: ownerKey(owner),
      nonce: this.#newNonce(),
      unsigned,
      ...(existing === undefined
        ? {}
        : {
            replaces: {
              id: existing.body.id,
              revision: existing.body.revision,
              ...(existing.suspended === undefined ? {} : { suspended: existing.suspended.because }),
              narrowed: narrowingOf(existing),
            },
          }),
      account: { id: snap.account.id, label: snap.account.label },
      ...(snap.account.username === undefined ? {} : { username: snap.account.username }),
      place: snap.signIn.place,
      autoRecipe: snap.signIn.autoApplyRecipe === true,
      expiresAtMs: now + STAGE_TTL_MS,
      state: 'waiting',
    };
    // A paired device approves its own stage with its own passkey: the body names it now.
    if (owner.actor.kind === 'device' && !this.#bind(stage, owner.actor.deviceId))
      throw new SignInRuleError(400, 'bad_request', 'the rule could not be built for this device');
    this.#stages.set(stage.id, stage);
    return this.#staged(stage);
  }

  /** Whether terminal rules are on (`sign-in-rules-terminal.1` reported). Off unless the composition root says so. */
  #terminalRules(): boolean {
    return this.ports.terminalRules?.() === true;
  }

  /**
   * The challenge an `approve-sign-in-rule` passkey for this stage must answer, for THIS device only, or nothing: the
   * device the stage is bound to (the one that made it, or the one that took a machine stage with {@link bind}). A pure
   * read: asking for passkey options binds nothing, so a device that could not commit can't take a stage from the
   * owner's phone (secrev-1274a L3). Any other device, an unknown, finished or lapsed stage, or one being committed,
   * gets nothing.
   */
  challengeOf(stageId: SignInRuleStageId, deviceId: string): Uint8Array | undefined {
    this.sweep();
    const held = this.#stages.get(stageId);
    if (held === undefined || held.state !== 'waiting' || held.committing === true) return undefined;
    return held.bound?.deviceId === deviceId ? held.bound.challenge.slice() : undefined;
  }

  /**
   * A PAIRED DEVICE TAKES A MACHINE STAGE (`fy rules add`, waiting in the app) to approve it with its own passkey: the
   * signed body then names it, and the challenge is derived from that body. Behind the same route demands as the commit
   * (`secrets.configure`, `browser.use`), and only for a device that holds a passkey. A stage bound to this device
   * already answers itself again; one bound to another device is not waiting for this one.
   */
  async bind(caller: PasteRuleCaller, stageId: SignInRuleStageId): Promise<SignInRuleStaged> {
    const owner = requireOwner(caller);
    this.#ready();
    this.sweep();
    if (owner.actor.kind !== 'device')
      throw new SignInRuleError(403, 'forbidden', 'only a paired device approves a standing rule, with its passkey');
    const deviceId = owner.actor.deviceId;
    const held = this.#ownStage(owner, stageId, false);
    if (held.bound?.deviceId === deviceId) return this.#staged(held);
    if (held.owner !== HOST || held.machine === undefined || held.committing === true) throw this.#stageGone();
    if (!(await this.#passkeyFor(owner)))
      throw new SignInRuleError(
        409,
        SIGN_IN_RULE_ERROR_CODES.passkeyRequired,
        SIGN_IN_RULE_INELIGIBLE_WORDS['no-passkey'],
      );
    // Looked at again after the await: another device may have taken it (then it is not this one's), or it lapsed.
    const still = this.#ownStage(owner, stageId, false);
    if (still.bound?.deviceId === deviceId) return this.#staged(still);
    // A device id that can't be signed (not a paired device's) binds nothing.
    if (!this.#bind(still, deviceId)) throw this.#stageGone();
    return this.#staged(still);
  }

  /** Where a staged rule stands, for `fy rules add` waiting on the app. */
  viewStage(caller: PasteRuleCaller, stageId: SignInRuleStageId): SignInRuleStageView {
    const owner = requireOwner(caller);
    this.#ready();
    this.sweep();
    const held = this.#ownStage(owner, stageId, true);
    return { ...this.#staged(held), state: held.state };
  }

  /** Puts a stage made at the machine (`fy rules add`) in the app, for a paired device's passkey. Approves nothing. */
  confirmInApp(caller: PasteRuleCaller, stageId: SignInRuleStageId): SignInRuleStaged {
    const owner = requireOwner(caller);
    this.#ready();
    this.sweep();
    const held = this.#ownStage(owner, stageId, false);
    // "Asked at the machine": only a stage the machine made may say so (secrev-1261 L3).
    if (held.owner !== HOST || held.committing === true) throw this.#stageGone();
    held.machine ??= { askedAt: new Date(this.ports.clock.now()).toISOString() };
    return this.#staged(held);
  }

  /** Drops a staged rule (the dialog dismissed, or Deny): nothing is approved. Never needs a passkey. */
  drop(caller: PasteRuleCaller, stageId: SignInRuleStageId): void {
    const owner = requireOwner(caller);
    this.#ready();
    this.sweep();
    const held = this.#ownStage(owner, stageId, false);
    if (held.committing === true) throw this.#stageGone();
    this.#finish(held, 'denied');
  }

  /**
   * COMMITS a staged rule, in this order and all or nothing:
   *
   * 1. The stage is waiting and this caller's; its body is not from the future.
   * 2. The challenge is derived AGAIN from the body about to be written, and `claim` takes the kept assertion only if
   *    it is the challenge the live ceremony verified ({@link SignInRuleProofMissing} otherwise; nothing is spent).
   * 3. The assertion is verified offline over those bytes, from the device the body names.
   * 4. The listing is read again and the pins snapshotted again: they must equal the staged ones (`409 conflict`).
   * 5. The file is written, then memory. 6. It is audited.
   *
   * A refusal after the claim spends the proof: the stage ends and must be made again.
   */
  async commit(
    caller: PasteRuleCaller,
    stageId: SignInRuleStageId,
    claim: (expectedChallenge: Uint8Array) => StoredStepUpProof | undefined,
  ): Promise<SignInRuleView> {
    const owner = requireOwner(caller);
    this.#ready();
    this.sweep();
    const held = this.#ownStage(owner, stageId, false);
    // ONE COMMIT PER STAGE, decided before a proof is claimed: a second commit racing this one finds it committing.
    if (held.committing === true) throw this.#stageGone();
    const bound = held.bound;
    // Never bound to a device: no ceremony could have been made for it, from anyone.
    if (bound === undefined) throw new SignInRuleProofMissing();
    if (signInRuleClockProblems(bound.body, this.ports.clock.now()).length > 0) {
      this.#finish(held, 'expired');
      throw new SignInRuleError(409, SIGN_IN_RULE_ERROR_CODES.conflict, 'the clock moved back: stage the rule again');
    }
    const challenge = ruleChallenge(bound.body, held.id, held.nonce);
    if (challenge === undefined) throw this.#stageGone();
    const evidence = claim(challenge);
    if (evidence === undefined) throw new SignInRuleProofMissing();
    held.committing = true;
    try {
      const made = await this.#committed(owner, held, bound.body, evidence);
      this.#finish(held, 'approved');
      return made;
    } catch (error) {
      this.#finish(held, 'denied');
      throw error;
    } finally {
      held.committing = false;
    }
  }

  async #committed(
    owner: Owner,
    held: Stage,
    body: SignInRuleBody,
    evidence: StoredStepUpProof,
  ): Promise<SignInRuleView> {
    if (evidence.deviceId !== body.approvedBy.deviceId)
      throw new SignInRuleError(
        403,
        SIGN_IN_RULE_ERROR_CODES.proofInvalid,
        'that passkey is not the one this rule names',
      );
    const record = SignInRuleRecordSchema.safeParse({
      body,
      proof: { ...evidence, stage: held.id, nonce: held.nonce },
      usage: { count: 0 },
    });
    if (!record.success)
      throw new SignInRuleError(403, SIGN_IN_RULE_ERROR_CODES.proofInvalid, 'the proof is not usable');
    // The view is drawn AFTER the queue: naming the approving device asks pairing, which may revoke an idle device, and a
    // revocation is told to this service through the same queue.
    const { made, listing } = await this.#serial(async () => {
      const listing = await this.#listing();
      const again = snapshotPins(listing, body.signIn, body.fields.includes('totp'));
      if (!again.ok || !samePins(again.pins, body.pins))
        throw new SignInRuleError(
          409,
          SIGN_IN_RULE_ERROR_CODES.conflict,
          'the sign-in changed since this rule was staged; nothing was approved: stage it again',
        );
      const existing = this.#records.find(each => each.body.signIn === body.signIn);
      const replaced =
        held.replaces === undefined
          ? existing === undefined
          : existing?.body.id === held.replaces.id && existing.body.revision === held.replaces.revision;
      if (!replaced)
        throw new SignInRuleError(
          409,
          SIGN_IN_RULE_ERROR_CODES.conflict,
          'the sign-in’s standing rule changed since this one was staged; nothing was approved',
        );
      // A suspension is sticky and keeps its first reason, so the only way this differs is one that landed since.
      const suspendedNow = existing?.suspended?.because;
      if (held.replaces !== undefined && suspendedNow !== held.replaces.suspended)
        throw new SignInRuleError(
          409,
          SIGN_IN_RULE_ERROR_CODES.conflict,
          `the standing rule was suspended after this approval was staged (${signInRuleSuspensionWords(suspendedNow ?? 'proof-invalid')}); nothing was approved: look at it again`,
        );
      if (held.replaces !== undefined && existing !== undefined && narrowingOf(existing) !== held.replaces.narrowed)
        throw new SignInRuleError(
          409,
          SIGN_IN_RULE_ERROR_CODES.conflict,
          'the standing rule was narrowed after this approval was staged; nothing was approved: look at it again',
        );
      if (existing === undefined && this.#records.length >= SIGN_IN_RULE_MAX)
        throw new SignInRuleError(
          429,
          'capacity',
          `this machine already has ${String(SIGN_IN_RULE_MAX)} standing rules`,
        );
      // THE PROOF, CHECKED INSIDE THE QUEUE, right before the write (secrev-1274a L1, secrev-1274b M1): a revocation or a
      // passkey removal already queued has run, and one that lands while this check runs is queued behind the write and
      // sees the new rule. The device must still be paired and hold the credential, and the assertion must verify over
      // the very bytes written (the challenge derived again from the record).
      const proof = await checkRuleProof(record.data, this.ports.proofs);
      if (proof === 'unknown')
        throw new SignInRuleError(503, 'unavailable', 'the passkeys cannot be read right now; nothing was approved');
      if (proof !== 'ok')
        throw new SignInRuleError(
          403,
          SIGN_IN_RULE_ERROR_CODES.proofInvalid,
          proof === 'passkey-removed'
            ? 'the passkey or device that approved this rule is gone; nothing was approved'
            : 'the passkey confirmation does not match this rule; nothing was approved',
        );
      await this.#write([...this.#records.filter(each => each.body.id !== body.id), record.data]).catch(() => {
        throw new SignInRuleError(503, 'unavailable', 'the standing rules could not be saved; nothing was approved');
      });
      this.#verified = new Set([...this.#verified, recordKey(record.data)]);
      const action = existing === undefined ? 'sign-in-rule-created' : againAction(existing, this.ports.clock.now());
      await this.#auditRule(record.data, action, { proof: 'passkey' }, auditActor(owner));
      return { made: record.data, listing };
    });
    return await this.#view(made, listing);
  }

  // ── Narrow and revoke: no passkey, they only take away ────────────────────────────────────────────

  /** Drops the code, ends earlier or lowers the cap: refused unless STRICTLY narrower. Needs no passkey. */
  async narrow(caller: PasteRuleCaller, id: SignInRuleId, narrow: SignInRuleNarrow): Promise<SignInRuleView> {
    const owner = requireOwner(caller);
    this.#ready();
    const checked = SignInRuleNarrowSchema.safeParse(narrow);
    if (!checked.success)
      throw new SignInRuleError(400, 'bad_request', checked.error.issues[0]?.message ?? 'not a narrowing');
    const next = await this.#checked(async () => {
      const record = this.#rule(id);
      const narrowed = signInRuleNarrowed(record, checked.data, this.ports.clock.now());
      if (!narrowed.ok) throw new SignInRuleError(400, 'bad_request', narrowed.reason);
      const next = SignInRuleRecordSchema.parse({ ...record, narrowed: narrowed.narrowed });
      await this.#write(this.#records.map(each => (each.body.id === id ? next : each))).catch(this.#unsaved);
      await this.#auditRule(
        next,
        'sign-in-rule-narrowed',
        {
          ...(checked.data.dropTotp === true ? { dropTotp: true } : {}),
          ...(checked.data.expiresAt === undefined ? {} : { narrowedTo: checked.data.expiresAt }),
          ...(checked.data.uses === undefined ? {} : { narrowedUses: checked.data.uses }),
        },
        auditActor(owner),
      );
      return next;
    });
    return await this.#view(next, await this.ports.accounts.listing().catch(() => undefined));
  }

  /** Revokes one rule, one tap, no passkey: it is gone from the file and memory at once. */
  async revoke(caller: PasteRuleCaller, id: SignInRuleId): Promise<void> {
    const owner = requireOwner(caller);
    this.#ready();
    await this.#checked(async () => {
      const record = this.#rule(id);
      await this.#write(this.#records.filter(each => each.body.id !== id)).catch(this.#unsaved);
      this.#unverify(record);
      await this.#auditRule(record, 'sign-in-rule-revoked', {}, auditActor(owner));
    });
  }

  /** Revokes every rule of one account (pinned to it, or on a sign-in it holds now), in one write. */
  async revokeAccount(caller: PasteRuleCaller, account: AccountId): Promise<{ readonly revoked: number }> {
    const owner = requireOwner(caller);
    this.#ready();
    const listing = await this.ports.accounts.listing().catch(() => undefined);
    return await this.#checked(async () => {
      const held = new Set(listing?.signIns.filter(each => each.account === account).map(each => each.id) ?? []);
      const ending = this.#records.filter(each => each.body.pins.account === account || held.has(each.body.signIn));
      if (ending.length === 0) return { revoked: 0 };
      const ids = new Set(ending.map(each => each.body.id));
      await this.#write(this.#records.filter(each => !ids.has(each.body.id))).catch(this.#unsaved);
      for (const record of ending) {
        this.#unverify(record);
        await this.#auditRule(record, 'sign-in-rule-revoked', { wholeAccount: true }, auditActor(owner));
      }
      return { revoked: ending.length };
    });
  }

  // ── Suspension: sticky, persisted, audited ────────────────────────────────────────────────────────

  /**
   * SUSPENDS a rule until a new passkey: persisted, then audited. Sticky: an already suspended rule keeps its first
   * reason. `revision`, when given, must be the rule's current one (a fill under an older revision suspends nothing
   * that was approved again since). `sessionId` is recorded in the audit only: no card is raised in a ferret's session.
   */
  async suspend(
    id: SignInRuleId,
    because: SignInRuleSuspension,
    context: { readonly revision?: number; readonly sessionId?: string } = {},
  ): Promise<void> {
    await this.#checked(async () => {
      await this.#suspendAll([{ id, because, revision: context.revision, sessionId: context.sessionId }]);
    });
  }

  /**
   * THE ACCOUNT STORE CHANGED (`AccountDirectory.followRulesWith`, after every commit): each rule still in force whose
   * pinned facts drifted is suspended with that reason. A label, a password, `verified`, a proposal or a default never
   * drift, so they suspend nothing.
   */
  async accountsChanged(listing: RuleListing): Promise<void> {
    // Queued behind a load still reading the file, so a change made meanwhile is checked against what it reads.
    await this.#checked(async () => {
      if (this.#health !== 'ok') return;
      const suspending: Suspending[] = [];
      for (const record of this.#records) {
        if (record.suspended !== undefined) continue;
        const because = ruleDrift(record.body, listing);
        if (because !== undefined) suspending.push({ id: record.body.id, because, revision: record.body.revision });
      }
      await this.#suspendAll(suspending);
    });
  }

  /**
   * A PASSKEY OR DEVICE WENT (`PasskeysChangedSignal`): every rule's proof is checked again against the registry as it
   * stands now, and one that no longer holds is suspended (`passkey-removed`, or `proof-invalid`). A device forgotten
   * also drops the stages it could approve.
   */
  async passkeysChanged(change?: PasskeysChange): Promise<void> {
    if (change?.cause === 'device-forgotten') this.#dropStagesOf(change.deviceId);
    // Unverified from the moment it is signalled, while it waits its turn and while it checks.
    this.#checking += 1;
    // Queued behind a load still reading the file, so a change made meanwhile is checked against what it reads.
    await this.#serial(async () => {
      if (this.#health !== 'ok') return;
      const suspending: Suspending[] = [];
      const verified = new Set<string>();
      for (const record of this.#records) {
        if (record.suspended !== undefined) continue;
        const because = await this.#recheckProof(record);
        if (because !== undefined) suspending.push({ id: record.body.id, because, revision: record.body.revision });
        else if (this.#lastProof === 'ok') verified.add(recordKey(record));
      }
      this.#verified = verified;
      await this.#suspendAll(suspending);
    }).finally(() => {
      this.#checking -= 1;
    });
  }

  /**
   * A PAIRED DEVICE WAS REVOKED (pairing's device-state purge): every rule its passkey approved is suspended
   * (`passkey-removed`) whether or not the passkey purge after it succeeds, and the stages it could approve are dropped.
   */
  async forgetDevice(deviceId: string): Promise<void> {
    this.#dropStagesOf(deviceId);
    this.#checking += 1;
    // Queued behind a load still reading the file, so a change made meanwhile is checked against what it reads.
    await this.#serial(async () => {
      if (this.#health !== 'ok') return;
      const suspending = this.#records
        .filter(record => record.suspended === undefined && record.body.approvedBy.deviceId === deviceId)
        .map(record => ({ id: record.body.id, because: 'passkey-removed' as const, revision: record.body.revision }));
      for (const record of this.#records) if (record.body.approvedBy.deviceId === deviceId) this.#unverify(record);
      await this.#suspendAll(suspending);
    }).finally(() => {
      this.#checking -= 1;
    });
  }

  /**
   * A PAGE SCRIPT RAN ON `host` (any session): every rule pinned to that login domain is suspended (`scripted-origin`),
   * persisted, so a planted service worker or storage can't wait out a restart. Told by the browser tools (`browser.eval`).
   */
  async scriptedOn(host: string): Promise<void> {
    // Queued behind a load still reading the file, so a change made meanwhile is checked against what it reads.
    await this.#serial(async () => {
      if (this.#health !== 'ok') return;
      await this.#suspendAll(
        this.#records
          .filter(
            record =>
              record.suspended === undefined &&
              record.body.surface === 'page' &&
              record.body.pins.placeKeys.includes(host),
          )
          .map(record => ({ id: record.body.id, because: 'scripted-origin' as const, revision: record.body.revision })),
      );
    });
  }

  /**
   * A PAGE SCRIPT RAN WHERE ITS ORIGIN COULD NOT BE READ (R3c-4): it may have run on any login domain, so every PAGE
   * rule is suspended (`scripted-origin`). Fails closed: denial of service at most, never a fill. A terminal rule is not
   * a page's: no page script reaches the terminal it types into.
   */
  async scriptedEverywhere(): Promise<void> {
    await this.#serial(async () => {
      if (this.#health !== 'ok') return;
      await this.#suspendAll(
        this.#records
          .filter(record => record.suspended === undefined && record.body.surface === 'page')
          .map(record => ({ id: record.body.id, because: 'scripted-origin' as const, revision: record.body.revision })),
      );
    });
  }

  /**
   * THE RULES A FILL READS, as they stand in memory now (R3c-4, `RuleSignInGrants`). Synchronous, so the input
   * service's last check before typing asks it with nothing awaited. None while the file is loading or damaged.
   */
  fillable(): readonly SignInRuleRecord[] {
    return this.#health === 'ok' ? this.#records : [];
  }

  /**
   * ONE RULE CHECKED AGAIN FOR A FILL, offline, right before it types (R3c-4; secrev-1274b L1 and N3): its signed
   * window against the clock, its proof against the registry, and its pinned facts against the accounts now. A proof or
   * a fact that no longer holds suspends it here with its own reason. `gone`: revoked or approved again since;
   * `unknown`: the registry or the accounts could not be read, so nothing fills and nothing is suspended.
   */
  async fillCheck(
    id: SignInRuleId,
    revision: number,
  ): Promise<'ok' | 'gone' | 'unknown' | 'suspended' | SignInRuleSuspension> {
    const record = this.fillable().find(each => each.body.id === id && each.body.revision === revision);
    if (record === undefined) return 'gone';
    if (record.suspended !== undefined) return 'suspended';
    let because: SignInRuleSuspension | undefined;
    if (signInRuleClockProblems(record.body, this.ports.clock.now()).length > 0) because = 'proof-invalid';
    else {
      const proof = await checkRuleProof(record, this.ports.proofs);
      if (proof === 'unknown') return this.#owed(record);
      if (proof !== 'ok') because = proof;
      else {
        const listing = await this.ports.accounts.listing().catch(() => undefined);
        if (listing === undefined) return this.#owed(record);
        because = ruleDrift(record.body, listing);
      }
    }
    if (because === undefined) return 'ok';
    await this.suspend(id, because, { revision });
    return because;
  }

  /**
   * A FILL UNDER A RULE (R3c-4): its count, last use and session, persisted. A write that fails keeps the count in
   * memory and suspends the rule there (`store-write-failed`), so an uncounted use never goes on filling.
   */
  async used(id: SignInRuleId, revision: number, sessionId: string): Promise<void> {
    await this.#serial(async () => {
      const record = this.#records.find(each => each.body.id === id && each.body.revision === revision);
      if (record === undefined) return;
      const usage = {
        count: record.usage.count + 1,
        lastUsedAt: new Date(this.ports.clock.now()).toISOString(),
        lastSession: sessionId.slice(0, 128),
      };
      const next = { ...record, usage };
      const records = this.#records.map(each => (each === record ? next : each));
      try {
        await this.#write(records);
      } catch {
        this.ports.warn(
          'a standing rule’s use could not be saved, so the rule is suspended until you approve it again',
        );
        this.#unverify(record);
        this.#records = this.#records.map(each =>
          each === record ? { ...next, suspended: this.#suspension('store-write-failed') } : each,
        );
        this.#dirty = true;
        await this.#auditRule(
          next,
          'sign-in-rule-suspended',
          { because: 'store-write-failed' },
          { kind: 'host' },
          'daemon',
        );
      }
    });
  }

  /**
   * At shutdown: a suspension or a use whose write failed is written now, if the file can be written at all. What a
   * crash before any write lands still loses is declared (docs/secrets.md).
   */
  async flush(): Promise<void> {
    await this.#serial(async () => {
      if (this.#dirty) await this.#write(this.#records).catch(() => undefined);
    });
  }

  /**
   * Whether a rule's proof AND its pinned facts checked out at the last look (R3c-4's fill reads it before every write).
   * `false` while any check is still owed or still running — the accounts or the passkeys could not be read, a passkey
   * or device change is being checked, or the file is still being read — so a passkey change can't re-verify a rule whose facts were never checked (secrev-1274-delta F1).
   */
  verified(id: SignInRuleId, revision: number): boolean {
    return (
      this.#health === 'ok' &&
      !this.#unsettled &&
      this.#checking === 0 &&
      this.#verified.has(`${id}:${String(revision)}`)
    );
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────────

  /** One record against the registry and, when it could be read, the listing: why it no longer holds, or nothing. */
  async #recheck(
    record: SignInRuleRecord,
    listing: RuleListing | undefined,
  ): Promise<SignInRuleSuspension | undefined> {
    if (signInRuleClockProblems(record.body, this.ports.clock.now()).length > 0) {
      this.#lastProof = 'proof-invalid';
      return 'proof-invalid';
    }
    const proof = await this.#recheckProof(record);
    if (proof !== undefined) return proof;
    return listing === undefined ? undefined : ruleDrift(record.body, listing);
  }

  /** One record's proof now: `passkey-removed` or `proof-invalid`, or nothing (checked out, or nobody could tell). */
  async #recheckProof(record: SignInRuleRecord): Promise<SignInRuleSuspension | undefined> {
    const check = await checkRuleProof(record, this.ports.proofs);
    this.#lastProof = check;
    if (check === 'unknown') this.#unsettled = true;
    return check === 'passkey-removed' || check === 'proof-invalid' ? check : undefined;
  }

  /** Inside the queue: suspends each named rule still in force, in one write, then audits each. */
  async #suspendAll(changes: readonly Suspending[]): Promise<void> {
    const wanted = new Map<SignInRuleId, Suspending>();
    for (const change of changes) {
      const record = this.#records.find(each => each.body.id === change.id);
      if (record === undefined || record.suspended !== undefined) continue;
      if (change.revision !== undefined && change.revision !== record.body.revision) continue;
      if (!wanted.has(change.id)) wanted.set(change.id, change);
    }
    if (wanted.size === 0) return;
    // Out of the verified set BEFORE the write, so nothing reads it verified while its suspension is being saved.
    this.#verified = new Set(
      [...this.#verified].filter(key => ![...wanted.keys()].some(id => key.startsWith(`${id}:`))),
    );
    const suspended = (because: (change: Suspending) => SignInRuleSuspension) =>
      this.#records.map(record => {
        const change = wanted.get(record.body.id);
        return change === undefined ? record : { ...record, suspended: this.#suspension(because(change)) };
      });
    let saved = true;
    try {
      await this.#write(suspended(change => change.because));
    } catch {
      saved = false;
      this.#dirty = true;
      this.ports.warn('a standing rule was suspended, but the rules file could not be written; it stays suspended');
      this.#records = suspended(() => 'store-write-failed');
    }
    for (const record of this.#records) {
      const change = wanted.get(record.body.id);
      if (change === undefined) continue;
      await this.#auditRule(
        record,
        'sign-in-rule-suspended',
        {
          because: saved ? change.because : 'store-write-failed',
          ...(change.sessionId === undefined ? {} : { session: auditText(change.sessionId) }),
        },
        { kind: 'host' },
        'daemon',
      );
    }
  }

  /**
   * A fill's re-check could not be made (the registry or the accounts unreadable): the rule is no longer `verified`, and
   * a check is owed, so no other fill passes on the older answer until a sweep settles it (secrev-1282a M1).
   */
  #owed(record: Pick<SignInRuleRecord, 'body'>): 'unknown' {
    this.#unverify(record);
    this.#unsettled = true;
    return 'unknown';
  }

  #unverify(record: Pick<SignInRuleRecord, 'body'>): void {
    this.#verified = new Set([...this.#verified].filter(key => key !== recordKey(record)));
  }

  #suspension(because: SignInRuleSuspension): { readonly at: string; readonly because: SignInRuleSuspension } {
    return { at: new Date(this.ports.clock.now()).toISOString(), because };
  }

  /**
   * Inside the queue: writes `records` as the whole document, then holds them. After damage the old file is moved aside
   * first, never deleted, and the fresh document can only drop approvals.
   */
  async #write(records: readonly SignInRuleRecord[]): Promise<void> {
    if (this.#health === 'damaged')
      await this.ports.store.setAside(new Date(this.ports.clock.now()).toISOString().replaceAll(/[:.]/gu, '-'));
    await this.ports.store.write({ v: 1, rules: [...records] });
    this.#records = records;
    this.#dirty = false;
    if (this.#health === 'damaged') this.#health = 'ok';
  }

  /** The store's own failure, said as the person's refusal (`#write` throws nothing of this service's). */
  readonly #unsaved = (): never => {
    throw new SignInRuleError(503, 'unavailable', 'the standing rules could not be saved; nothing changed');
  };

  /**
   * {@link #serial}, counted as a check in flight from the moment it is asked for (delta F5): an account change, a
   * suspension, a revoke or a narrowing waiting its turn already makes no rule read `verified`.
   */
  async #checked<T>(work: () => Promise<T>): Promise<T> {
    this.#checking += 1;
    try {
      return await this.#serial(work);
    } finally {
      this.#checking -= 1;
    }
  }

  async #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return await run;
  }

  #ready(): void {
    if (this.#health === 'loading')
      throw new SignInRuleError(503, 'unavailable', 'the standing rules are still being read; try again in a moment');
  }

  async #listing(): Promise<RuleListing> {
    return await this.ports.accounts.listing().catch(() => {
      throw new SignInRuleError(503, 'unavailable', 'the accounts cannot be read right now');
    });
  }

  async #passkeyFor(owner: Owner): Promise<boolean> {
    const has =
      owner.actor.kind === 'device' ? this.ports.passkeys.of(owner.actor.deviceId) : this.ports.passkeys.any();
    return await has.catch(() => false);
  }

  #rule(id: SignInRuleId): SignInRuleRecord {
    const record = this.#records.find(each => each.body.id === id);
    if (record === undefined) throw new SignInRuleError(404, 'not_found', `there is no standing rule ${id}`);
    return record;
  }

  /** Fixes the approving device: the signed body names it, and the challenge is derived from that body. */
  #bind(stage: Stage, deviceId: string): boolean {
    const body = { ...stage.unsigned, approvedBy: { deviceId } } as SignInRuleBody;
    const challenge = ruleChallenge(body, stage.id, stage.nonce);
    if (challenge === undefined) return false;
    stage.bound = { deviceId, body, challenge };
    return true;
  }

  /**
   * A stage this caller may act on: the one it made, or — for a paired device — a machine stage waiting in the app that
   * is bound to it or to no device yet. Anything else is "not waiting", so a stage id says nothing to another device.
   */
  #ownStage(owner: Owner, stageId: SignInRuleStageId, finished: boolean): Stage {
    const held = this.#stages.get(stageId);
    if (held === undefined || (!finished && held.state !== 'waiting')) throw this.#stageGone();
    const me = ownerKey(owner);
    const device = owner.actor.kind === 'device' ? owner.actor.deviceId : undefined;
    const mine =
      held.owner === me ||
      (device !== undefined &&
        held.owner === HOST &&
        held.machine !== undefined &&
        (held.bound === undefined || held.bound.deviceId === device));
    if (!mine || (held.bound !== undefined && device !== undefined && held.bound.deviceId !== device))
      throw this.#stageGone();
    return held;
  }

  #dropStagesOf(deviceId: string): void {
    for (const stage of this.#stages.values())
      if (
        stage.state === 'waiting' &&
        stage.committing !== true &&
        (stage.owner === `device:${deviceId}` || stage.bound?.deviceId === deviceId)
      )
        this.#finish(stage, 'denied');
  }

  #finish(stage: Stage, state: Exclude<SignInRuleStageState, 'waiting'>): void {
    if (stage.state !== 'waiting') return;
    stage.state = state;
    stage.finishedAtMs = this.ports.clock.now();
    // Finished stages are kept only to answer a poll: at most this many, the oldest dropped (secrev-1274a N2).
    const finished = [...this.#stages.values()].filter(each => each.state !== 'waiting');
    for (const old of finished.slice(0, Math.max(0, finished.length - FINISHED_STAGES_KEPT)))
      this.#stages.delete(old.id);
  }

  #freshStageId(): SignInRuleStageId {
    for (;;) {
      const id = this.#newStageId();
      if (!this.#stages.has(id)) return id;
    }
  }

  #stageGone(): SignInRuleError {
    return new SignInRuleError(
      404,
      SIGN_IN_RULE_ERROR_CODES.stageNotFound,
      'that standing rule is not waiting for a passkey: stage it again',
    );
  }

  #staged(stage: Stage): SignInRuleStaged {
    const body = stage.bound?.body ?? stage.unsigned;
    return {
      stage: stage.id,
      rule: body.id,
      revision: body.revision,
      signIn: body.signIn,
      account: stage.account,
      place: stage.place,
      summary: [
        ...stagedSummary({
          fields: body.fields,
          account: stage.account,
          username: stage.username,
          place: stage.place,
          scope: body.scope,
          expiresAt: body.expiresAt,
          uses: body.uses,
          autoRecipe: stage.autoRecipe,
          revision: body.revision,
          suspended: stage.replaces?.suspended,
        }),
      ],
      fields: [...body.fields],
      totp: body.fields.includes('totp'),
      root: body.surface === 'terminal',
      autoRecipe: stage.autoRecipe,
      scope: body.scope,
      expiresAt: body.expiresAt,
      ...(body.uses === undefined ? {} : { uses: body.uses }),
      stageExpiresAt: new Date(stage.expiresAtMs).toISOString(),
      ...(stage.machine === undefined ? {} : { machine: { askedAt: stage.machine.askedAt } }),
    };
  }

  /** One record as the owner reads it: in force after narrowing, named from the listing when it could be read. */
  async #view(record: SignInRuleRecord, listing: RuleListing | undefined): Promise<SignInRuleView> {
    const effective = signInRuleEffective(record, this.ports.clock.now());
    const signIn = listing?.signIns.find(each => each.id === record.body.signIn);
    const account = signIn === undefined ? undefined : listing?.accounts.find(each => each.id === signIn.account);
    const place: Place =
      signIn !== undefined && ruleSurfaceOf(signIn) === record.body.surface ? signIn.place : pinnedPlace(record.body);
    const totp = effective.fields.includes('totp');
    const flags: SignInRuleFlag[] = [
      ...(record.body.surface === 'terminal' ? (['root'] as const) : []),
      ...(totp ? (['one-factor'] as const) : []),
      ...(signIn?.autoApplyRecipe === true ? (['auto-recipe'] as const) : []),
    ];
    const device = await this.ports.devices?.label(record.body.approvedBy.deviceId).catch(() => undefined);
    return {
      id: record.body.id,
      revision: record.body.revision,
      signIn: record.body.signIn,
      account: { id: account?.id ?? record.body.pins.account, label: account?.label ?? record.body.pins.account },
      ...(record.body.pins.username === undefined ? {} : { username: record.body.pins.username }),
      place,
      fields: [...effective.fields],
      totp,
      scope: record.body.scope,
      createdAt: record.body.createdAt,
      expiresAt: effective.expiresAt,
      ...(effective.uses === undefined ? {} : { uses: effective.uses, remaining: effective.remaining ?? 0 }),
      status: effective.status,
      ...(record.suspended === undefined && !this.verified(record.body.id, record.body.revision)
        ? { unverified: true }
        : {}),
      ...(record.suspended === undefined ? {} : { suspended: record.suspended }),
      usage: record.usage,
      flags,
      approvedWith: {
        deviceId: record.body.approvedBy.deviceId,
        ...(device === undefined ? {} : { device: device.slice(0, 200) }),
      },
    };
  }

  // ── Audit: what was approved, changed or stopped, never a value or a username ────────────────────

  async #auditRule(
    record: SignInRuleRecord,
    action: string,
    extra: AuditDetail,
    actor: AuditActor,
    cause?: 'daemon',
  ): Promise<void> {
    const body = record.body;
    await this.#record(
      body.id,
      {
        action,
        revision: body.revision,
        signIn: body.signIn,
        account: body.pins.account,
        fields: ruleFieldWords(body.fields).replaceAll(' and ', '+').replaceAll(', ', '+'),
        scope: body.scope.kind,
        expiresAt: body.expiresAt,
        ...(body.uses === undefined ? {} : { uses: body.uses }),
        ...(action === 'sign-in-rule-suspended' && typeof extra['because'] === 'string'
          ? { words: auditText(signInRuleSuspensionWords(extra['because'] as SignInRuleSuspension)) }
          : {}),
        ...extra,
      },
      actor,
      'succeeded',
      cause,
    );
  }

  async #record(
    subject: string,
    detail: AuditDetail,
    actor: AuditActor,
    outcome: 'succeeded' | 'failed',
    cause?: 'daemon',
  ): Promise<void> {
    await this.ports.audit
      .record({
        event: 'security.changed',
        actor,
        subject,
        outcome,
        detail,
        ...(cause === undefined ? {} : { cause }),
      })
      .catch(() => undefined);
  }
}

/**
 * The place a rule was approved for, from its signed keys alone: what the list shows once its sign-in is gone or is no
 * longer of the rule's surface. A terminal rule's one key is `tool@host` (sudo, su and doas name no destination).
 */
function pinnedPlace(body: SignInRuleBody): Place {
  const [key = ''] = body.pins.placeKeys;
  const at = key.indexOf('@');
  return body.surface === 'terminal'
    ? { kind: 'terminal', tool: key.slice(0, at), host: key.slice(at + 1) }
    : { kind: 'site', domains: [...body.pins.placeKeys], match: [] };
}

/** A record's narrowing as one comparable string: the same three facts, in a fixed order. */
const narrowingOf = (record: Pick<SignInRuleRecord, 'narrowed'>): string =>
  JSON.stringify([
    record.narrowed?.dropTotp ?? null,
    record.narrowed?.expiresAt ?? null,
    record.narrowed?.uses ?? null,
  ]);

/** What approving a rule again was: a resume (it was suspended), a renew (it ended or was used up), or a widen. */
function againAction(previous: SignInRuleRecord, now: number): string {
  const status = signInRuleEffective(previous, now).status;
  return status === 'suspended'
    ? 'sign-in-rule-resumed'
    : status === 'expired' || status === 'used-up'
      ? 'sign-in-rule-renewed'
      : 'sign-in-rule-widened';
}
