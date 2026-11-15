import type { SavedLoginsProvider } from '../../../contract/index.ts';
import type { AccountId, AccountKey, GrantMissReason } from '../../lib/inputs/borrowed.ts';
import {
  type ScriptedOriginsView,
  type SignInGrant,
  SignInGrantLedger,
  type SignInGrantSource,
} from '../../lib/inputs/borrowed-grants.ts';

/** The `input.saved:saved` provider in effect now, or nothing when Accounts is off (§4.7). */
export type GrantsProviderLookup = () => SavedLoginsProvider | undefined;

/** Every member a grant source answers with, by name: an object missing one is no source (never half used). */
const SOURCE_METHODS = [
  'enabled',
  'of',
  'keyOf',
  'used',
  'stopped',
  'verify',
  'holds',
  'projectOf',
  'scriptedOrigins',
] as const;

const isGrantSource = (offered: unknown): offered is SignInGrantSource =>
  typeof offered === 'object' &&
  offered !== null &&
  SOURCE_METHODS.every(name => typeof (offered as Record<string, unknown>)[name] === 'function') &&
  typeof (offered as { ledger?: unknown }).ledger === 'object' &&
  (offered as { ledger?: unknown }).ledger !== null;

/**
 * WHAT A STANDING RULE OR TASK-PLAN LINE MAY FILL, as Accounts hands it to the Vault (`input.saved:saved` → `grants()`),
 * looked up on every call: an Accounts that is off, provides no source, or provides something that is not one leaves
 * `enabled()` false and every sign-in waiting for the owner (fail closed).
 *
 * The Vault never owns a grant: the plan lines, the rules, the one ledger and the owner's revocations are Accounts'. This
 * is only the Vault's end of them. It is total where the input service reads it while raising a card (`enabled`, `of`,
 * `scriptedOrigins`): a source that throws grants nothing, and its script view then reads as "a script is running".
 */
export class SignInGrantsThroughHook implements SignInGrantSource {
  /** Settles a reservation that outlived its source (Accounts turned off mid-fill): nothing is ever reserved on it. */
  readonly #none = new SignInGrantLedger();

  constructor(private readonly provider: GrantsProviderLookup) {}

  get ledger(): SignInGrantLedger {
    return this.#source()?.ledger ?? this.#none;
  }

  enabled(): boolean {
    return this.#guarded(source => source.enabled(), false, false);
  }

  of(sessionId: string): readonly SignInGrant[] {
    return this.#guarded(source => source.of(sessionId), [], []);
  }

  async keyOf(account: AccountId): Promise<AccountKey | undefined> {
    return await this.#source()?.keyOf(account);
  }

  used(grant: SignInGrant, at: number, sessionId: string): void {
    this.#source()?.used(grant, at, sessionId);
  }

  async stopped(grant: SignInGrant, because: GrantMissReason): Promise<void> {
    await this.#source()?.stopped(grant, because);
  }

  async verify(grant: SignInGrant): Promise<Awaited<ReturnType<SignInGrantSource['verify']>>> {
    return (await this.#source()?.verify(grant)) ?? { ok: false };
  }

  holds(grant: SignInGrant, at: Parameters<SignInGrantSource['holds']>[1]): boolean {
    return this.#source()?.holds(grant, at) === true;
  }

  async projectOf(sessionId: string): Promise<string | undefined> {
    return await this.#source()?.projectOf(sessionId);
  }

  scriptedOrigins(): ScriptedOriginsView {
    return this.#guarded(source => source.scriptedOrigins(), { hosts: new Map() }, { hosts: new Map(), running: true });
  }

  /** An agent script is about to run: the source stops every standing rule until it is over (no source: nothing to stop). */
  running(): () => void {
    return this.#source()?.running?.() ?? (() => undefined);
  }

  /** A page script ran: the source stops every standing rule pinned there (no source: nothing to stop). */
  scriptedOn(host: string | undefined): void {
    this.#source()?.scriptedOn?.(host);
  }

  /** The source in effect now, or nothing: a provider that throws or offers something else is no source. */
  #source(): SignInGrantSource | undefined {
    try {
      const offered = this.provider()?.grants?.();
      return isGrantSource(offered) ? offered : undefined;
    } catch {
      return undefined;
    }
  }

  /** A read the input service makes while raising a card must not break it: a source that throws answers `otherwise`. */
  #guarded<T>(read: (source: SignInGrantSource) => T, none: T, thrown: T): T {
    const source = this.#source();
    if (source === undefined) return none;
    try {
      return read(source);
    } catch {
      return thrown;
    }
  }
}
