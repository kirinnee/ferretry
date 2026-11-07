import {
  DEFAULT_SECURITY_SETTINGS,
  type GrantAuditEntryView,
  SECURITY_SETTING_FIELDS,
  type SecuritySettingField,
  type SecuritySettings,
  type SecuritySettingsPatch,
  type SecuritySettingsView,
  widensSecurity,
  widensWithPasskey,
} from '../../../contract/index.ts';
import type { GrantHistoryPort } from '../grants/service.ts';

/**
 * ONE MACHINE'S SECURITY SETTINGS (today's `lib/security/service.ts`, copied; the document is now `gate.yaml`'s
 * `security` section, read live through the kernel's config port).
 *
 * TIGHTEN FROM ANYWHERE, LOOSEN ONLY AT THE MACHINE (G111–G116). A change is judged field by field and refused WHOLE
 * if any field loosens remotely. ONE EXCEPTION, BOUGHT WITH A PASSKEY: a device may raise `unlockValidityHours` when
 * it proved a passkey for that one change; it is applied at once and journaled `security.loosened-with=passkey`.
 *
 * A DAMAGED DOCUMENT FAILS CLOSED: it is read as {@link DAMAGED_SECURITY_SETTINGS}, except the idle expiry, which
 * stays at the default because an unpairing cannot be taken back.
 */
export const DAMAGED_SECURITY_SETTINGS: SecuritySettings = Object.freeze({
  unlockOnOpen: true,
  unlockValidityHours: 1,
  stepUpOnActions: true,
  stepUpWindowMinutes: 0,
  deviceKeyRotationDays: 7,
  idleExpiryDays: DEFAULT_SECURITY_SETTINGS.idleExpiryDays,
});

/** The journal line a change loosened on a device's passkey carries. */
export const PASSKEY_WIDEN_JOURNAL_LINE = 'security.loosened-with=passkey';

export type SecuritySettingsSource = SecuritySettingsView['source'];

/** What the document says now: its settings, or `damaged`, or `undefined` when the file was never written. */
export type SecurityDocument =
  | { readonly kind: 'document'; readonly settings: SecuritySettings; readonly updatedAt?: string }
  | { readonly kind: 'defaults' }
  | { readonly kind: 'damaged' };

/** Where the settings live and how a change is saved. A save that cannot happen throws; nothing is applied. */
export interface SecurityDocumentPort {
  read(): SecurityDocument;
  /** Writes the whole `security` section. */
  write(settings: SecuritySettings): Promise<void>;
}

export interface SecurityCaller {
  readonly hostLocal: boolean;
  readonly actor: string;
  /**
   * TAKES this caller's fresh passkey proof, atomically (Gate's `claimFreshStepUp`): of concurrent acts on one proof
   * exactly one is answered `true`. Absent for a caller with no proved device, which holds none. Called only by a remote
   * widen, inside the patch queue and before the write; never read from a body and never a snapshot of admission.
   */
  readonly claimFreshPasskey?: () => boolean;
}

export interface SecuritySettingsChange {
  readonly view: SecuritySettingsView;
  readonly devicesExpiring: number;
}

export type SecurityPatchOutcome =
  | { readonly ok: true; readonly change: SecuritySettingsChange }
  | { readonly ok: false; readonly refusal: 'widen-remote'; readonly fields: readonly SecuritySettingField[] }
  | { readonly ok: false; readonly refusal: 'passkey-required'; readonly fields: readonly SecuritySettingField[] }
  | { readonly ok: false; readonly refusal: 'unavailable' };

export interface SecuritySettingsDeps {
  readonly document: SecurityDocumentPort;
  /**
   * The grant journal (`state/gate/grant-audit.jsonl`), where today's service wrote each change line. `security.changed`
   * is NOT written here: the descriptor's `audit: { record }` and the audited-route table write it once per call,
   * for every outcome (`audit/routes.ts`).
   */
  readonly history: GrantHistoryPort;
  readonly clock: { readonly now: () => string };
  /** The command a person runs at the machine to loosen a setting. */
  readonly widenCommand: string;
}

export class SecuritySettingsService {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SecuritySettingsDeps) {}

  #read(): {
    readonly settings: SecuritySettings;
    readonly source: SecuritySettingsSource;
    readonly updatedAt?: string;
  } {
    let document: SecurityDocument;
    try {
      document = this.deps.document.read();
    } catch {
      document = { kind: 'damaged' };
    }
    switch (document.kind) {
      case 'document':
        return {
          settings: document.settings,
          source: 'document',
          ...(document.updatedAt === undefined ? {} : { updatedAt: document.updatedAt }),
        };
      case 'defaults':
        return { settings: DEFAULT_SECURITY_SETTINGS, source: 'defaults' };
      case 'damaged':
        return { settings: DAMAGED_SECURITY_SETTINGS, source: 'damaged' };
    }
  }

  /** The settings in force. Synchronous, because enforcement must never wait on a file. */
  current(): SecuritySettings {
    return this.#read().settings;
  }

  view(caller: SecurityCaller): SecuritySettingsView {
    const read = this.#read();
    return {
      settings: read.settings,
      source: read.source,
      mayWiden: caller.hostLocal,
      widenCommand: this.deps.widenCommand,
      ...(read.updatedAt === undefined
        ? {}
        : { updatedAt: read.updatedAt as SecuritySettingsView['updatedAt'] & string }),
    };
  }

  async patch(patch: SecuritySettingsPatch, caller: SecurityCaller): Promise<SecurityPatchOutcome> {
    const operation = this.#queue.then(async () => await this.#patchNow(patch, caller));
    this.#queue = operation.catch(() => undefined);
    return await operation;
  }

  async #patchNow(patch: SecuritySettingsPatch, caller: SecurityCaller): Promise<SecurityPatchOutcome> {
    const read = this.#read();
    // A damaged document is not a base to change; only the machine may replace it, whole.
    if (read.source === 'damaged' && !caller.hostLocal) return { ok: false, refusal: 'unavailable' };
    const current = read.settings;
    const next: SecuritySettings = { ...current, ...patch };
    const widened = SECURITY_SETTING_FIELDS.filter(field => widensSecurity(field, current[field], next[field]));
    const remoteWiden = widened.length > 0 && !caller.hostLocal;
    if (remoteWiden) {
      // Judged before any passkey is asked: a widen no passkey could buy must not ask for one first (G116).
      if (!widened.every(widensWithPasskey)) return { ok: false, refusal: 'widen-remote', fields: widened };
      // CLAIMED here, in the queue and before the write, never read from the admission snapshot: of two requests
      // admitted on ONE proof (two widens, or a widen and a config loosening) exactly one takes it. No restore: a write
      // that then fails has used the proof up, and the person confirms again.
      if (caller.claimFreshPasskey?.() !== true) return { ok: false, refusal: 'passkey-required', fields: widened };
    }
    const changes = SECURITY_SETTING_FIELDS.filter(field => current[field] !== next[field]).map(
      field => `security.${field}=${String(current[field])}->${String(next[field])}`,
    );
    if (remoteWiden) changes.push(PASSKEY_WIDEN_JOURNAL_LINE);
    if (changes.length > 0) await this.deps.document.write(next);
    // Recorded even when nothing moved, as the grant journal records an empty patch: an attempt is part of the history.
    await this.deps.history.record({
      at: this.deps.clock.now() as GrantAuditEntryView['at'],
      actor: caller.actor,
      changes,
    });
    return { ok: true, change: { view: this.view(caller), devicesExpiring: 0 } };
  }
}
