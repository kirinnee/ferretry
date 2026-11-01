/**
 * SAVING A 2FA SEED: STAGE, PASSKEY, COMMIT (docs/secrets.md, "2FA keys").
 *
 * When this machine holds an account's seed, it makes that account's codes, so the password and the code then come
 * from one place. Every ferret holds the admin token. So a seed is saved only with a passkey, from EVERY caller (the
 * machine itself too), and the proof is bound to the ONE save it was proved for:
 *
 * 1. STAGE. The pasted key (base32 or an `otpauth://totp/…` link) is parsed again here, checked against the account,
 *    sealed with the vault's cipher and held in MEMORY ONLY for {@link TWO_FACTOR_STAGE_TTL_SECONDS}. It is masked at
 *    once (this class is a redaction source). The answer says what was read, never the seed.
 * 2. PASSKEY. The step-up options name the stage; the challenge, and so the proof, is bound to
 *    `addTwoFactorKeySubject(account key, stage)` ({@link boundSubjectOf}).
 * 3. COMMIT. Only a proof for `add-2fa-key` bound to exactly that subject is taken; nothing else stands in for one — not
 *    the machine's own token, an unlock, a step-up window or `stepUpOnActions`. Then the seed is written to the sealed
 *    document under a fresh name and the index names it, all or nothing.
 *
 * At most {@link MAX_LIVE_TWO_FACTOR_STAGES} seeds wait at once, so nobody fills this daemon's memory by staging. A
 * seed is never written to disk before its commit, and nothing here returns one.
 */

import { randomBytes } from 'node:crypto';
import {
  type AccountId,
  type AgendaId,
  addTwoFactorKeySubject,
  factorMismatch,
  factorMismatchWords,
  type InputActor,
  MAX_LIVE_TWO_FACTOR_STAGES,
  MAX_SEEDS_PER_ACCOUNT,
  parseTotpInput,
  type StageTwoFactorSeedRequest,
  type TotpParameters,
  TWO_FACTOR_ERROR_CODES,
  TWO_FACTOR_SEED_CARD_MISMATCH_LINE,
  TWO_FACTOR_STAGE_TTL_SECONDS,
  type TwoFactorId,
  type TwoFactorSeedSaved,
  type TwoFactorSeedStaged,
  type TwoFactorSeedStageView,
  type TwoFactorStageId,
  unpadInputValue,
} from '@ferretry/protocol';
import type { AccountDirectory } from './accounts.ts';
import type { RedactionValueSource } from './redaction.ts';
import type { SecretCipherPort } from './types.ts';

/** Why a seed was not staged or saved: an HTTP status, the code a client branches on, and the person's next step. */
export class TwoFactorSeedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TwoFactorSeedError';
  }
}

/** The commit was asked without a passkey proof bound to this stage: the route answers the step-up demand. */
export class TwoFactorSeedProofMissing extends Error {
  constructor() {
    super('saving a 2FA seed needs a passkey confirmation for this one save, from a paired device');
    this.name = 'TwoFactorSeedProofMissing';
  }
}

/**
 * WHO is asking about a stage, from the boundary (never a body): `key` names the caller (`device:<id>` for a paired
 * device, else the server-derived actor), and `device` says it is a paired device. Only the caller that staged a seed,
 * or a paired device (where the owner's passkey lives), may read, drop or put it on the agenda.
 */
export interface StageCaller {
  readonly key: string;
  readonly device: boolean;
}

/** Most seeds one caller holds staged at once, so one caller cannot take the whole table. */
export const MAX_STAGES_PER_CALLER = 2;

/** How a paired device names itself as a {@link StageCaller}. */
export const DEVICE_OWNER = 'device:';

/** The card that asks the owner to confirm a staged save in the app, as the agenda needs it. */
export interface TwoFactorSeedCard {
  readonly stage: TwoFactorStageId;
  readonly account: AccountId;
  readonly subject: string;
  readonly why: string;
  readonly context: string;
  readonly expiresAt: string;
}

/** Where the confirm-in-app card goes, and how it is closed. */
export interface TwoFactorSeedAgendaPort {
  raise(sessionId: string, card: TwoFactorSeedCard): Promise<AgendaId>;
  close(sessionId: string, id: AgendaId, note: string): Promise<void>;
}

/** Who saved a seed, as an input card's deliver names the owner: the machine, or a paired device. */
export type SeedSaver = Extract<InputActor, { readonly kind: 'host' | 'device' }>;

/**
 * An input card the owner set a seed up from: whether it is still open, where the daemon saw its target, and the digest
 * of the facts the card shows now (`observedDigest`, absent while the daemon looks again).
 */
export interface TwoFactorSeedCardPort {
  cardTarget(requestId: string): { readonly matchKey?: string; readonly observedDigest?: string } | undefined;
  /**
   * "Use it now": types the new key's first code into that card under every check a "Use code from Ferretry" tap gets
   * (`InputRequestService.useNow`), against `observedDigest`: the card as the owner saw it when they staged the seed, so
   * a card redrawn since types nothing, as a tap on a stale card would. Whether it was typed; never the code. Absent:
   * never typed.
   */
  useNow?(
    requestId: string,
    use: {
      readonly account: AccountId;
      readonly factor: TwoFactorId;
      readonly observedDigest: string;
      readonly submit?: boolean;
      readonly actor: SeedSaver;
    },
  ): Promise<boolean>;
}

/**
 * The card port as the daemon wires it: the input service is built after the seed stages, so both calls are handed on
 * to whatever `current()` returns then. Before it exists: no card is open, and nothing is typed.
 */
export function lateSeedCards(current: () => TwoFactorSeedCardPort | undefined): TwoFactorSeedCardPort {
  return {
    cardTarget: requestId => current()?.cardTarget(requestId),
    useNow: async (requestId, use) => (await current()?.useNow?.(requestId, use)) ?? false,
  };
}

export interface TwoFactorSeedStagesDeps {
  readonly accounts: Pick<AccountDirectory, 'seedTarget' | 'accountsAt' | 'addSeed'>;
  /** The vault's cipher: a staged seed rests sealed in memory, opened only to save it or to mask it. */
  readonly cipher: SecretCipherPort;
  readonly clock: { nowMs(): number };
  /** Whether ANY paired device holds a passkey. None: no seed can be saved ("add a passkey first"). */
  readonly anyPasskey: () => Promise<boolean>;
  /** This machine's name, for the card ("Asked by `fy` on kirin-box"). */
  readonly hostName: string;
  readonly cards?: TwoFactorSeedCardPort;
  readonly agenda?: TwoFactorSeedAgendaPort;
  readonly newStageId?: () => TwoFactorStageId;
}

type StageState = TwoFactorSeedStageView['state'];

interface Stage {
  readonly id: TwoFactorStageId;
  readonly accountKey: string;
  readonly account: AccountId;
  /** Who staged it ({@link StageCaller.key}). */
  readonly owner: string;
  readonly label: string;
  /** The label the owner chose, if any; absent, the save takes a free default. */
  readonly ownLabel?: string;
  readonly params: TotpParameters;
  readonly issuer?: string;
  readonly accountName?: string;
  readonly mismatch: boolean;
  readonly expiresAtMs: number;
  /** The seed and the text it came from, sealed. Dropped the moment the stage is no longer waiting. */
  sealed?: { readonly seed: Sealed; readonly input: Sealed };
  state: StageState;
  /** A commit is saving it: no second commit, drop or expiry may touch it, and it stays masked until that ends. */
  committing?: boolean;
  factor?: TwoFactorId;
  card?: { readonly sessionId: string; readonly id: AgendaId };
  /**
   * The input card a PAIRED DEVICE set this seed up from, to type the first code into once saved ("use it now"). Never
   * for a stage made from the machine or a ferret's token: their save is confirmed on an agenda card that says nothing
   * about typing, so the owner's passkey there is no tap on a code card.
   */
  readonly useOn?: { readonly request: string; readonly observedDigest?: string; readonly submit?: boolean };
}

interface Sealed {
  readonly iv: string;
  readonly ciphertext: string;
}

const STAGE_TTL_MS = TWO_FACTOR_STAGE_TTL_SECONDS * 1_000;
/** How long a finished stage still answers its state (no seed in it), so `fy` reads "Saved" rather than "gone". */
const FINISHED_KEPT_MS = STAGE_TTL_MS;

const randomStageId = (): TwoFactorStageId => `st_${randomBytes(12).toString('hex')}`;

/** The sealed names a staged seed rests under in memory: never a name the sealed document can hold. */
const sealName = (stage: TwoFactorStageId, part: 'seed' | 'input'): string => `stage:${stage}:${part}`;

/** "GitHub · kirinnee". */
const accountWords = (target: { readonly label: string; readonly username?: string }): string =>
  target.username === undefined ? target.label : `${target.label} · ${target.username}`;

const NOTES: Readonly<Record<Exclude<StageState, 'waiting'>, string>> = {
  saved: 'Saved: Ferretry makes this account’s codes now.',
  dropped: 'Denied: nothing was saved.',
  expired: 'Timed out: nothing was saved. Stage it again to save it.',
};

export class TwoFactorSeedStages implements RedactionValueSource {
  readonly #stages = new Map<TwoFactorStageId, Stage>();
  readonly #newStageId: () => TwoFactorStageId;

  constructor(private readonly deps: TwoFactorSeedStagesDeps) {
    this.#newStageId = deps.newStageId ?? randomStageId;
  }

  /**
   * STAGES a seed for `accountId`. Refused, before anything is held: a paste that is not a key, an account that already
   * keeps {@link MAX_SEEDS_PER_ACCOUNT} seeds, a card matched to another account, a machine where no device has a
   * passkey, a key that says it is for another account without "save it here anyway", and a full stage table.
   */
  async stage(
    accountId: AccountId,
    request: StageTwoFactorSeedRequest,
    caller: StageCaller,
  ): Promise<TwoFactorSeedStaged> {
    const text = unpadInputValue(request.padded);
    if (text === undefined)
      throw new TwoFactorSeedError(400, TWO_FACTOR_ERROR_CODES.notAKey, 'the key was not sent padded; update the app');
    const parsed = parseTotpInput(text);
    if (!parsed.ok) throw new TwoFactorSeedError(400, TWO_FACTOR_ERROR_CODES.notAKey, parsed.error);
    const target = await this.deps.accounts.seedTarget(accountId);
    if (request.request !== undefined) await this.#assertCardAccount(request.request, accountId);
    if (target.seeds >= MAX_SEEDS_PER_ACCOUNT)
      throw new TwoFactorSeedError(
        409,
        'full',
        `${target.label} already keeps ${String(MAX_SEEDS_PER_ACCOUNT)} 2FA seeds; remove one first`,
      );
    if (
      request.label !== undefined &&
      target.labels.some(label => label.trim().toLowerCase() === request.label?.trim().toLowerCase())
    )
      throw new TwoFactorSeedError(
        409,
        'invalid_change',
        `${target.label} already has a 2FA key called ${request.label}; pick another label`,
      );
    if (!(await this.deps.anyPasskey()))
      throw new TwoFactorSeedError(
        409,
        TWO_FACTOR_ERROR_CODES.passkeyRequired,
        'saving a 2FA seed needs a passkey: add a passkey in Settings › Security first',
      );
    const key = parsed.value;
    const mismatch = factorMismatch(target, target.places, key);
    if (mismatch !== undefined && request.mismatchAcknowledged !== true)
      throw new TwoFactorSeedError(409, TWO_FACTOR_ERROR_CODES.mismatch, factorMismatchWords(key, target));
    const now = this.deps.clock.nowMs();
    this.#sweep(now);
    this.#assertRoom(caller);
    const id = this.#freshId();
    const sealed = {
      seed: await this.deps.cipher.seal(sealName(id, 'seed'), key.seed),
      input: await this.deps.cipher.seal(sealName(id, 'input'), text),
    };
    const stage: Stage = {
      id,
      accountKey: target.key,
      owner: caller.key,
      account: accountId,
      label: request.label ?? 'Authenticator app',
      ...(request.label === undefined ? {} : { ownLabel: request.label }),
      params: key.params,
      ...(key.issuer === undefined ? {} : { issuer: key.issuer }),
      ...(key.accountName === undefined ? {} : { accountName: key.accountName }),
      mismatch: mismatch !== undefined,
      expiresAtMs: now + STAGE_TTL_MS,
      sealed,
      state: 'waiting',
      ...(request.request === undefined || !caller.device
        ? {}
        : { useOn: this.#useOn(request.request, request.submit) }),
    };
    this.#stages.set(id, stage);
    return {
      stage: id,
      account: accountId,
      label: stage.label,
      expiresAt: new Date(stage.expiresAtMs).toISOString(),
      parsed: {
        params: key.params,
        ...(key.issuer === undefined ? {} : { issuer: key.issuer }),
        ...(key.accountName === undefined ? {} : { accountName: key.accountName }),
      },
      ...(mismatch === undefined ? {} : { mismatch: { ...mismatch, words: factorMismatchWords(key, target) } }),
    };
  }

  /**
   * What an `add-2fa-key` passkey for this stage is bound to: `addTwoFactorKeySubject(account key, stage)`, or nothing
   * when no such stage is waiting. The step-up options and the commit both read it here, so they cannot disagree.
   */
  boundSubjectOf(stage: TwoFactorStageId): string | undefined {
    this.#sweep(this.deps.clock.nowMs());
    const held = this.#stages.get(stage);
    return held?.state === 'waiting' ? addTwoFactorKeySubject(held.accountKey, held.id) : undefined;
  }

  /** Where a stage stands, for `fy` waiting on the owner. Refused as unknown for another account's stage. */
  async view(accountId: AccountId, stage: TwoFactorStageId, caller: StageCaller): Promise<TwoFactorSeedStageView> {
    this.#sweep(this.deps.clock.nowMs());
    const held = await this.#own(accountId, stage, { finished: true, caller });
    return {
      stage: held.id,
      account: accountId,
      label: held.label,
      state: held.state,
      expiresAt: new Date(held.expiresAtMs).toISOString(),
      ...(held.factor === undefined ? {} : { factor: held.factor }),
      ...(held.card === undefined ? {} : { agendaItemId: held.card.id }),
      mismatch: held.mismatch,
    };
  }

  /**
   * SAVES a waiting stage. `claim` is the route's claim on a fresh `add-2fa-key` proof bound to the subject it is
   * handed; without one this throws {@link TwoFactorSeedProofMissing} and the stage keeps waiting. The proof is spent
   * by the claim whatever follows, as every act's is. A stage a paired device set up from an input card then types the
   * new key's first code into that card (`typed`), as `saver`.
   */
  async commit(
    accountId: AccountId,
    stage: TwoFactorStageId,
    claim: (subject: string) => boolean,
    saver?: SeedSaver,
  ): Promise<TwoFactorSeedSaved> {
    this.#sweep(this.deps.clock.nowMs());
    const held = await this.#own(accountId, stage, { finished: false });
    // ONE COMMIT PER STAGE, decided before anything awaits (and before a proof is spent): a second commit racing this
    // one finds it committing and is told it is gone, so one stage is one key whatever proofs are presented. The seed
    // stays sealed on the stage, and so MASKED, until the store has its own sealed copy (secrev-1236 N1).
    if (held.committing === true) throw this.#gone();
    if (!claim(addTwoFactorKeySubject(held.accountKey, held.id))) throw new TwoFactorSeedProofMissing();
    const sealed = held.sealed;
    if (sealed === undefined) throw this.#gone();
    held.committing = true;
    let saved: Omit<TwoFactorSeedSaved, 'mismatch'> | undefined;
    try {
      const name = sealName(held.id, 'seed');
      const seed = (await this.deps.cipher.openAll({ [name]: sealed.seed })).get(name);
      if (seed === undefined) throw this.#gone();
      saved = await this.deps.accounts.addSeed(held.accountKey, seed, {
        ...(held.ownLabel === undefined ? {} : { label: held.ownLabel }),
        params: held.params,
        ...(held.issuer === undefined ? {} : { issuer: held.issuer }),
        ...(held.accountName === undefined ? {} : { accountName: held.accountName }),
      });
    } catch (error) {
      await this.#finish(held, 'dropped');
      throw error;
    }
    if (saved === undefined) {
      await this.#finish(held, 'dropped');
      throw new TwoFactorSeedError(404, 'unknown_login', `${accountId} was deleted; nothing was saved`);
    }
    held.factor = saved.factor.id;
    await this.#finish(held, 'saved');
    const use = held.useOn;
    if (use === undefined) return { ...saved, mismatch: held.mismatch };
    const digest = use.observedDigest;
    const typed =
      saver === undefined || digest === undefined || this.deps.cards?.useNow === undefined
        ? false
        : await this.deps.cards
            .useNow(use.request, {
              account: saved.account,
              factor: saved.factor.id,
              observedDigest: digest,
              ...(use.submit === undefined ? {} : { submit: use.submit }),
              actor: saver,
            })
            .catch(() => false);
    return { ...saved, mismatch: held.mismatch, typed };
  }

  /** Drops a waiting stage (Deny, or `DELETE`): the seed is let go and nothing is saved. Never needs a passkey. */
  async drop(accountId: AccountId, stage: TwoFactorStageId, caller: StageCaller): Promise<void> {
    this.#sweep(this.deps.clock.nowMs());
    await this.#finish(await this.#own(accountId, stage, { finished: false, caller }), 'dropped');
  }

  /**
   * Puts a waiting stage on the owner's agenda so they confirm it with a passkey in the app: the card is the daemon's
   * words only (the account, who asked, from where and when), and it saves nothing by itself.
   */
  async confirmInApp(
    accountId: AccountId,
    stage: TwoFactorStageId,
    sessionId: string,
    askedBy: string,
    caller: StageCaller,
  ): Promise<{ readonly agendaItemId: AgendaId }> {
    const agenda = this.deps.agenda;
    if (agenda === undefined) throw new TwoFactorSeedError(503, 'unavailable', 'this daemon has no agenda to ask on');
    this.#sweep(this.deps.clock.nowMs());
    const held = await this.#own(accountId, stage, { finished: false, caller });
    if (held.card !== undefined) return { agendaItemId: held.card.id };
    const target = await this.deps.accounts.seedTarget(accountId);
    const at = new Date(this.deps.clock.nowMs()).toISOString().slice(11, 16);
    const says = [held.issuer, held.accountName].filter(part => part !== undefined).join(' · ');
    const context = [
      ...(says === '' ? [] : [`The key says it is for ${says}.`]),
      ...(held.mismatch ? [TWO_FACTOR_SEED_CARD_MISMATCH_LINE] : []),
      'Password and code both come from this machine then: together they are one factor.',
    ];
    const id = await agenda.raise(sessionId, {
      stage: held.id,
      account: accountId,
      subject: `Save automatic codes to ${accountWords(target)}?`,
      why: `Asked by ${askedBy} on ${this.deps.hostName} at ${at} UTC. If you didn't just ask for this, Deny.`,
      context: context.map(line => `- ${line}`).join('\n'),
      expiresAt: new Date(held.expiresAtMs).toISOString(),
    });
    held.card = { sessionId, id };
    return { agendaItemId: id };
  }

  /** The waiting seeds, for MASKING: each one and the text it was pasted as, keyed `login:stage:<st_…>`. */
  async values(): Promise<ReadonlyMap<string, string>> {
    this.#sweep(this.deps.clock.nowMs());
    const entries: Record<string, Sealed> = {};
    for (const stage of this.#waiting()) {
      if (stage.sealed === undefined) continue;
      entries[sealName(stage.id, 'seed')] = stage.sealed.seed;
      entries[sealName(stage.id, 'input')] = stage.sealed.input;
    }
    if (Object.keys(entries).length === 0) return new Map();
    const opened = await this.deps.cipher.openAll(entries);
    return new Map([...opened].map(([name, value]) => [`login:${name}`, value]));
  }

  /** The card a device staged from, as the owner sees it NOW: "use it now" types only into that very card. */
  #useOn(requestId: string, submit: boolean | undefined): NonNullable<Stage['useOn']> {
    const digest = this.deps.cards?.cardTarget(requestId)?.observedDigest;
    return {
      request: requestId,
      ...(digest === undefined ? {} : { observedDigest: digest }),
      ...(submit === undefined ? {} : { submit }),
    };
  }

  async #assertCardAccount(requestId: string, accountId: AccountId): Promise<void> {
    const card = this.deps.cards?.cardTarget(requestId);
    const matched = card?.matchKey === undefined ? [] : await this.deps.accounts.accountsAt(card.matchKey);
    if (!matched.includes(accountId))
      throw new TwoFactorSeedError(
        409,
        TWO_FACTOR_ERROR_CODES.notThisCardsAccount,
        `that card is closed or is not for ${accountId}: a key set up from a card saves only to the account Ferretry matched for it`,
      );
  }

  /** A stage of THIS account, still waiting (or, for a read, finished but remembered); else it is gone. */
  async #own(
    accountId: AccountId,
    stage: TwoFactorStageId,
    options: { readonly finished: boolean; readonly caller?: StageCaller },
  ): Promise<Stage> {
    const held = this.#stages.get(stage);
    if (held === undefined || (held.state !== 'waiting' && !options.finished)) throw this.#gone();
    if (held.committing === true && !options.finished) throw this.#gone();
    // Another caller's stage reads as gone: the id is on the agenda card, so knowing it proves nothing.
    const caller = options.caller;
    if (caller !== undefined && !caller.device && caller.key !== held.owner) throw this.#gone();
    const target = await this.deps.accounts.seedTarget(accountId).catch(() => undefined);
    if (target?.key !== held.accountKey) throw this.#gone();
    return held;
  }

  /**
   * ROOM FOR ONE MORE STAGE, per caller and kept for the owner: at most {@link MAX_STAGES_PER_CALLER} each, and callers
   * that are not a paired device share all but one of the {@link MAX_LIVE_TWO_FACTOR_STAGES} slots, so a ferret holding
   * junk stages can never keep the owner's app from staging (secrev-1236 L1).
   */
  #assertRoom(caller: StageCaller): void {
    const waiting = this.#waiting();
    const full = (why: string) => new TwoFactorSeedError(429, TWO_FACTOR_ERROR_CODES.tooManyStages, why);
    if (waiting.filter(stage => stage.owner === caller.key).length >= MAX_STAGES_PER_CALLER)
      throw full(
        `you already have ${String(MAX_STAGES_PER_CALLER)} 2FA seeds waiting for a passkey; save or drop one, or wait two minutes`,
      );
    const limit = caller.device ? MAX_LIVE_TWO_FACTOR_STAGES : MAX_LIVE_TWO_FACTOR_STAGES - 1;
    const counted = caller.device ? waiting : waiting.filter(stage => !stage.owner.startsWith(DEVICE_OWNER));
    if (waiting.length >= MAX_LIVE_TWO_FACTOR_STAGES || counted.length >= limit)
      throw full(
        `${String(waiting.length)} 2FA seeds are already waiting for a passkey; save or drop one, or wait two minutes`,
      );
  }

  #gone(): TwoFactorSeedError {
    return new TwoFactorSeedError(
      404,
      TWO_FACTOR_ERROR_CODES.stageGone,
      'that 2FA key is not waiting to be saved: it was saved, dropped or timed out; stage it again',
    );
  }

  #waiting(): readonly Stage[] {
    return [...this.#stages.values()].filter(stage => stage.state === 'waiting');
  }

  #freshId(): TwoFactorStageId {
    for (;;) {
      const id = this.#newStageId();
      if (!this.#stages.has(id)) return id;
    }
  }

  async #finish(stage: Stage, state: Exclude<StageState, 'waiting'>): Promise<void> {
    stage.state = state;
    delete stage.sealed;
    const card = stage.card;
    if (card !== undefined) await this.deps.agenda?.close(card.sessionId, card.id, NOTES[state]).catch(() => undefined);
  }

  /** Lets go of every seed past its two minutes, and forgets finished stages once nobody is waiting on their state. */
  #sweep(nowMs: number): void {
    for (const [id, stage] of this.#stages) {
      if (stage.state === 'waiting' && stage.committing !== true && stage.expiresAtMs <= nowMs)
        void this.#finish(stage, 'expired');
      else if (stage.state !== 'waiting' && stage.expiresAtMs + FINISHED_KEPT_MS <= nowMs) this.#stages.delete(id);
    }
  }
}
