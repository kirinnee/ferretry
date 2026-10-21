import {
  DEFAULT_SECURITY_SETTINGS,
  SECURITY_SETTING_FIELDS,
  type SecuritySettingField,
  type SecuritySettings,
  type SecuritySettingsChange,
  type SecuritySettingsPatch,
  type SecuritySettingsSource,
  type SecuritySettingsView,
  widensSecurity,
  widensWithPasskey,
} from '@ferretry/protocol';
import type { GrantAuditPort } from '../grants/types.ts';

/**
 * ONE MACHINE'S SECURITY SETTINGS (`docs/design/zero-trust.md` B6), held in memory and read
 * synchronously by everything that enforces one of them.
 *
 * ## TIGHTEN FROM ANYWHERE, LOOSEN ONLY AT THE MACHINE
 *
 * The same asymmetry the grant document has. A paired device may make this machine stricter — the
 * route that calls {@link patch} demands `pairing.configure`, so a remote caller also needs a passkey
 * confirmation — but only somebody at the machine may make it looser. A change is judged field by
 * field and refused WHOLE if any field loosens remotely, so a mixed request takes neither half.
 *
 * ONE EXCEPTION, BOUGHT WITH A PASSKEY: a device may raise a field in `SECURITY_PASSKEY_WIDEN_FIELDS`
 * (how long an unlock lasts) when it proved a passkey for that one change. The person proving presence
 * is the owner's consent, so the change is applied at once — no hold — and journaled with
 * {@link PASSKEY_WIDEN_JOURNAL_LINE}. A request that also loosens anything else is still refused whole,
 * before any passkey is asked.
 *
 * ## A DAMAGED DOCUMENT FAILS CLOSED
 *
 * An unreadable document is read as {@link DAMAGED_SECURITY_SETTINGS}: an unlock on opening for the
 * shortest period, a confirmation per act on top of it every time, and the shortest rotation. It is NOT read as the
 * shortest idle expiry, deliberately: that would unpair every device a day after somebody's editor
 * corrupted a file, and an unpairing cannot be taken back. The idle period stays at the default.
 */

/** What a damaged settings document is read as. See the class comment for the one exception. */
export const DAMAGED_SECURITY_SETTINGS: SecuritySettings = {
  unlockOnOpen: true,
  unlockValidityHours: 1,
  stepUpOnActions: true,
  stepUpWindowMinutes: 0,
  deviceKeyRotationDays: 7,
  idleExpiryDays: DEFAULT_SECURITY_SETTINGS.idleExpiryDays,
};

export interface StoredSecuritySettings {
  readonly settings: SecuritySettings;
  readonly updatedAt: string;
}

/** Where the settings live: `state/security.json`. `undefined` is "never written", not damage. */
export interface SecuritySettingsDocumentPort {
  read(): Promise<StoredSecuritySettings | undefined>;
  write(stored: StoredSecuritySettings): Promise<void>;
}

/** Who is asking: where they arrived, and the name the audit records. */
export interface SecurityCaller {
  readonly hostLocal: boolean;
  readonly actor: string;
  /**
   * Whether this caller proved a passkey for THIS change and has not spent it (the boundary's
   * `freshStepUp`), which is what lets a device raise one of {@link SECURITY_PASSKEY_WIDEN_FIELDS}.
   * Never read from a body.
   */
  readonly freshPasskey?: boolean;
}

export type SecurityPatchOutcome =
  | {
      readonly ok: true;
      readonly change: SecuritySettingsChange;
      /** The change loosened the machine on the caller's fresh passkey, which the route must now spend. */
      readonly spentPasskey: boolean;
    }
  | { readonly ok: false; readonly refusal: 'widen-remote'; readonly fields: readonly SecuritySettingField[] }
  | { readonly ok: false; readonly refusal: 'passkey-required'; readonly fields: readonly SecuritySettingField[] }
  | { readonly ok: false; readonly refusal: 'unavailable' };

/** The journal line a change loosened on a device's passkey carries, so the history says how it was allowed. */
export const PASSKEY_WIDEN_JOURNAL_LINE = 'security.loosened-with=passkey';

export interface SecuritySettingsDeps {
  readonly document: SecuritySettingsDocumentPort;
  readonly audit: GrantAuditPort;
  readonly clock: { readonly nowMs: () => number };
  /** The command a person runs at the machine to loosen a setting. */
  readonly widenCommand: string;
  /** Told after every change, so what enforces a setting can act on the new value at once. */
  readonly changed?: (settings: SecuritySettings) => void;
  /**
   * How many paired devices an idle period of `days` would unpair at the next check, so the answer to a
   * shortening can say so. Absent means nobody can count, and the answer says none.
   */
  readonly devicesIdleLongerThan?: (days: number) => number;
}

export class SecuritySettingsService {
  #settings: SecuritySettings = DAMAGED_SECURITY_SETTINGS;
  #source: SecuritySettingsSource = 'damaged';
  #updatedAt: string | undefined;
  /** Serializes changes, so two that both read the old value cannot each drop the other's field. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SecuritySettingsDeps) {}

  /** The settings in force. Synchronous, because enforcement must never wait on a file. */
  current(): SecuritySettings {
    return this.#settings;
  }

  /**
   * Re-reads the document. Returns a sentence when it was damaged, for the boot trail, and nothing
   * otherwise. A damaged document is never thrown: the machine keeps serving, on the strict reading.
   */
  async refresh(): Promise<string | undefined> {
    try {
      const stored = await this.deps.document.read();
      this.#apply(stored?.settings ?? DEFAULT_SECURITY_SETTINGS, stored === undefined ? 'defaults' : 'document');
      this.#updatedAt = stored?.updatedAt;
      return undefined;
    } catch (error) {
      this.#apply(DAMAGED_SECURITY_SETTINGS, 'damaged');
      this.#updatedAt = undefined;
      const cause = error instanceof Error ? error.message : String(error);
      return `the security settings document could not be read (${cause}), so this machine asks for a passkey on opening and for every protected act until it is fixed`;
    }
  }

  view(caller: SecurityCaller): SecuritySettingsView {
    return {
      settings: this.#settings,
      source: this.#source,
      mayWiden: caller.hostLocal,
      widenCommand: this.deps.widenCommand,
      ...(this.#updatedAt === undefined ? {} : { updatedAt: this.#updatedAt }),
    };
  }

  async patch(patch: SecuritySettingsPatch, caller: SecurityCaller): Promise<SecurityPatchOutcome> {
    const operation = this.#queue.then(async () => await this.#patchNow(patch, caller));
    this.#queue = operation.catch(() => undefined);
    return await operation;
  }

  async #patchNow(patch: SecuritySettingsPatch, caller: SecurityCaller): Promise<SecurityPatchOutcome> {
    // A damaged document is not a base to change: writing over it would make its strict reading look
    // like a decision somebody took. Only the machine may replace it, and it does so whole.
    if (this.#source === 'damaged' && !caller.hostLocal) return { ok: false, refusal: 'unavailable' };
    const current = this.#settings;
    const next: SecuritySettings = { ...current, ...patch };
    const widened = SECURITY_SETTING_FIELDS.filter(field => widensSecurity(field, current[field], next[field]));
    const remoteWiden = widened.length > 0 && !caller.hostLocal;
    if (remoteWiden) {
      // Judged before any passkey is asked: a widen no passkey could buy must not ask for one first.
      if (!widened.every(widensWithPasskey)) return { ok: false, refusal: 'widen-remote', fields: widened };
      if (caller.freshPasskey !== true) return { ok: false, refusal: 'passkey-required', fields: widened };
    }
    const changes = SECURITY_SETTING_FIELDS.filter(field => current[field] !== next[field]).map(
      field => `security.${field}=${String(current[field])}->${String(next[field])}`,
    );
    if (remoteWiden) changes.push(PASSKEY_WIDEN_JOURNAL_LINE);
    const at = new Date(this.deps.clock.nowMs()).toISOString();
    if (changes.length > 0) {
      await this.deps.document.write({ settings: next, updatedAt: at });
      this.#apply(next, 'document');
      this.#updatedAt = at;
    }
    // Recorded even when nothing moved, as the grant journal records an empty patch: an attempt is
    // part of the history.
    await this.deps.audit.record({ actor: caller.actor, changes, at });
    const devicesExpiring =
      next.idleExpiryDays < current.idleExpiryDays ? (this.deps.devicesIdleLongerThan?.(next.idleExpiryDays) ?? 0) : 0;
    return { ok: true, change: { view: this.view(caller), devicesExpiring }, spentPasskey: remoteWiden };
  }

  #apply(settings: SecuritySettings, source: SecuritySettingsSource): void {
    this.#settings = settings;
    this.#source = source;
    this.deps.changed?.(settings);
  }
}
