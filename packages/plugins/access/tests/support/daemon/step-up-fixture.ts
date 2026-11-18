import { DEFAULT_SECURITY_SETTINGS } from '@ferretry/core-gate/contract';
import type { SecuritySettings } from '../../../daemon/lib/wire.ts';
import {
  ChallengeLedger,
  type DeviceKeyRotationPort,
  type PasskeyStore,
  PasskeysChangedSignal,
  passkeyVerifier,
  type StepUpCaller,
  StepUpRegistry,
  StepUpService,
  type StepUpSubject,
  type StoredPasskey,
  type UnlockLedgerPort,
} from '../../../daemon/lib/step-up/index.ts';
import { CHALLENGE, ORIGIN, webCrypto } from './passkey-authenticator.ts';
import { deviceId } from '../../unit/daemon/push/support.ts';

/**
 * The step-up service over the REAL WebAuthn verifier, shared by the unit file that proves its verdicts and the perf
 * file that bounds one answer. It reads no clock.
 */

export const PAIRED_AT_MS = Date.parse('2026-10-13T10:00:00.000Z');
/** A real timer port: the passkeys-changed signal bounds a hung listener with it. */
export const after = (ms: number, fn: () => void): (() => void) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};
export const OTHER_ORIGIN = 'https://ferretry.example.com';

class MemoryPasskeys implements PasskeyStore {
  rows: StoredPasskey[] = [];
  async list(id: string) {
    return this.rows.filter(row => row.deviceId === id);
  }
  async holder(credentialId: string) {
    return this.rows.find(row => row.credentialId === credentialId)?.deviceId;
  }
  async add(passkey: StoredPasskey) {
    this.rows.push(passkey);
  }
  /** The adapter's compare-and-set, so a counter that did not move refuses here as it does there. */
  async updateSignCount(id: string, credentialId: string, signCount: number) {
    const row = this.rows.find(candidate => candidate.deviceId === id && candidate.credentialId === credentialId);
    if (row === undefined || (row.signCount >= signCount && (row.signCount !== 0 || signCount !== 0))) return false;
    this.rows = this.rows.map(candidate => (candidate === row ? { ...row, signCount } : candidate));
    return true;
  }
  async forgetDevice(id: string) {
    this.rows = this.rows.filter(row => row.deviceId !== id);
  }
}

export const phone: StepUpSubject = { deviceId: deviceId('a'), appSession: 'tab-one' };
/** A second paired device, for the cases where one device's passkey must never work for another. */
export const laptop: StepUpSubject = { deviceId: deviceId('b'), appSession: 'laptop-tab' };
export const remote = (subject: StepUpSubject = phone): StepUpCaller => ({ device: subject, hostLocal: false });

/** The `register-confirm` challenge, distinct from {@link CHALLENGE} so the two can never be mixed up here. */
export const CONFIRM = Uint8Array.from({ length: 32 }, (_, index) => (index * 11 + 5) & 0xff);

export function fixture(
  options: {
    nowMs?: number;
    origins?: readonly string[];
    paired?: boolean;
    settings?: Partial<SecuritySettings>;
    /** Whether the machine's settings are wired at all; absent means the service is built without them. */
    withSettings?: boolean;
    rotation?: DeviceKeyRotationPort;
    /** The step-up window in force, in minutes, which a case may change after the fact; the default otherwise. */
    window?: { minutes: number };
    /** The challenges the daemon "randomly" issues, in order; the last repeats. */
    challenges?: readonly Uint8Array[];
    announce?: (notice: unknown) => Promise<unknown>;
    /** The phone's paired name; `Phone` otherwise. */
    deviceName?: string;
    /** This machine's name as pairing knows it; `studio` otherwise. */
    machineName?: string;
    /** The client program this machine runs (`binaries.client`); absent wires none, as an older machine does. */
    clientName?: string;
    /** Where unlocks are kept across a restart; absent keeps them in memory only. */
    unlocks?: UnlockLedgerPort;
    /** Told after a device is forgotten with its passkeys; absent tells nobody. */
    passkeysChanged?: PasskeysChangedSignal;
    /** `false` builds the verifier without its offline check of a kept proof. */
    offline?: boolean;
  } = {},
) {
  const clock = { now: options.nowMs ?? PAIRED_AT_MS + 60_000 };
  const directory = { paired: options.paired !== false };
  const issued = [...(options.challenges ?? [CHALLENGE])];
  const announced: unknown[] = [];
  const store = new MemoryPasskeys();
  // Both of the phone's tabs hold a live session throughout, so a step-up is judged on its window and
  // binding alone; what ends a span is the span tests' subject.
  const window = options.window;
  const registry = new StepUpRegistry(
    { nowMs: () => clock.now },
    window === undefined ? undefined : () => window.minutes,
  );
  registry.open(phone);
  registry.open({ ...phone, appSession: 'tab-two' });
  const audited: { readonly actor: string; readonly changes: readonly string[] }[] = [];
  const verifier = passkeyVerifier(webCrypto);
  const service = new StepUpService({
    store,
    verifier:
      options.offline === false
        ? { verifyRegistration: verifier.verifyRegistration, verifyAssertion: verifier.verifyAssertion }
        : verifier,
    registry,
    challenges: new ChallengeLedger(),
    // The software authenticator signs over a known challenge, so the daemon "randomly" issues it.
    random: { bytes: length => ((issued.length > 1 ? issued.shift() : issued[0]) ?? CHALLENGE).slice(0, length) },
    clock: { nowMs: () => clock.now },
    devices: {
      device: async id =>
        !directory.paired || (id !== phone.deviceId && id !== laptop.deviceId)
          ? undefined
          : {
              name: id === phone.deviceId ? (options.deviceName ?? 'Phone') : 'Laptop',
              createdAt: new Date(PAIRED_AT_MS).toISOString(),
            },
    },
    allowedOrigins: () => options.origins ?? [ORIGIN, OTHER_ORIGIN],
    relyingPartyName: 'Ferretry',
    machineName: options.machineName ?? 'studio',
    ...(options.clientName === undefined ? {} : { clientName: options.clientName }),
    ...(options.withSettings === true || options.settings !== undefined
      ? { settings: () => ({ ...DEFAULT_SECURITY_SETTINGS, ...options.settings }) }
      : {}),
    ...(options.rotation === undefined ? {} : { rotation: options.rotation }),
    ...(options.unlocks === undefined ? {} : { unlocks: options.unlocks }),
    ...(options.passkeysChanged === undefined ? {} : { passkeysChanged: options.passkeysChanged }),
    audit: {
      record: async entry => {
        audited.push(entry);
      },
    },
    announce:
      options.announce ??
      (async notice => {
        announced.push(notice);
      }),
  });
  return { clock, store, registry, service, audited, announced, directory };
}
