/**
 * Access's composition (today's `createPairing` in `daemon/bin/fyd.ts`, the part that is Access's): the pairing,
 * device-grant, passkey/step-up and push services, wired to the kernel ports, Gate and Connections, and the four
 * values Access provides to the kernel and Gate — the `device` and `pair` session modes, the `credentials:device`
 * provider and the `step-up:device` witness.
 *
 * Built synchronously (`build` may not await); the services open their state on first use through `ready()`, the way
 * today's daemon opened them before serving. Until they are open, a session mode refuses and the credential provider
 * answers `unknown` — both fail closed.
 */
import {
  type CredentialProvider,
  DEFAULT_SECURITY_SETTINGS,
  type DeviceHolderStanding,
  type GateApi,
  type SecuritySettings,
  type StepUpWitness,
} from '@ferretry/core-gate/contract';
import {
  type Cancel,
  errorResponse,
  type HolderId,
  type KernelPorts,
  type ModeHolder,
  type ModeRedeemed,
  type ModeRedemption,
  type RouteHandler,
  type SessionMode,
} from '@ferretry/kernel/contract';
import type { ConnectionsApi } from '@ferretry/plugin-connections/contract';
import { epochMs, instantFromEpochMs, milliseconds } from '@ferretry/std';
import { z } from 'zod';
import {
  type AccessApi,
  type ConnectionAdvertisement,
  type Buzz,
  DevicesChanged,
  PairedDeviceIdSchema,
  PairingDeviceNameSchema,
  type PasskeyVerifier,
  type StagedStepUp,
  type StagedStepUpAct,
} from '../contract/index.ts';
import { JournalGrantAudit } from './adapters/grants/runtime-grant-ports.ts';
import { NodePairingCryptography } from './adapters/pairing/node-pairing-cryptography.ts';
import { StatePairingRepository } from './adapters/pairing/state-pairing-repository.ts';
import { WebCryptoPasskeyCrypto } from './adapters/passkeys/webcrypto-passkey-crypto.ts';
import { StatePushRepository } from './adapters/push/state-push-repository.ts';
import { WebPushFetchTransport } from './adapters/push/web-push-transport.ts';
import { StateVapidKeys } from './adapters/push/webcrypto-vapid-keys.ts';
import { StatePasskeyStore } from './adapters/step-up/state-passkey-store.ts';
import { StateUnlockLedger } from './adapters/step-up/state-unlock-ledger.ts';
import {
  type CapabilityGuard,
  DeviceGrantService,
  decideCapability,
  describeGrantRefusal,
  type GrantEvaluation,
  isGovernedCaller,
} from './lib/grants/index.ts';
import {
  AuditedPairingService,
  LiveDeviceConnections,
  PairingDeviceRegistry,
  type PairingService,
  PushNewDeviceAlert,
} from './lib/pairing/index.ts';
import {
  DeviceKeySchema,
  deviceRotateMessage,
  type Ed25519Verifier,
  verifyDeviceProof,
} from './lib/proof/device-proof.ts';
import { PairedPushDevices, PushService } from './lib/push/index.ts';
import { pairingRoutes } from './lib/routes/pairing.ts';
import { pushRoutes } from './lib/routes/push.ts';
import { stepUpRoutes } from './lib/routes/step-up.ts';
import {
  ChallengeLedger,
  PasskeysChangedSignal,
  passkeyVerifier,
  StepUpRegistry,
  StepUpService,
} from './lib/step-up/index.ts';
import type { ApiRoute } from './lib/wire.ts';
import { stepUpProvider } from './step-up-provider.ts';

/**
 * What Access needs from the host that no kernel or plugin port gives yet (sent to the lead): the daemon identity
 * (kernel), the app origins a passkey may answer for,
 * and the Ed25519 check a key rotation's proof needs (kernel wire). The real ports replace this one by one.
 */
export interface AccessHost {
  identity(): { readonly daemonId: string; readonly daemonName: string };
  allowedOrigins(): readonly string[];
  readonly ed25519: Ed25519Verifier;
  /** The command a remedy sentence names (`fy`). */
  readonly clientName: string;
}

export interface AccessRuntimeDeps {
  readonly kernel: KernelPorts;
  readonly gate: GateApi;
  readonly connections: () => ConnectionsApi | undefined;
  readonly host: AccessHost;
  /** The plugin that staged an act's subject (`step-up.stages:<act>`), or nothing when no plugin provides it. */
  readonly stages?: (act: StagedStepUpAct) => StagedStepUp | undefined;
}

interface Wired {
  readonly pairing: PairingService;
  readonly registry: PairingDeviceRegistry;
  readonly stepUp: StepUpService;
  readonly passkeyStore: StatePasskeyStore;
  readonly push: PushService;
  readonly routes: ReadonlyMap<string, RouteHandler>;
}

const DevicePrincipalSchema = z.object({ deviceId: PairedDeviceIdSchema, appSession: z.string().min(1) });
const PairRecordSchema = z.object({
  code: z.string(),
  deviceName: PairingDeviceNameSchema,
  deviceKey: DeviceKeySchema,
});

const routeKey = (route: Pick<ApiRoute, 'method' | 'path'>): string => `${route.method} ${route.path}`;

export class AccessRuntime {
  readonly #deps: AccessRuntimeDeps;
  readonly #stepUpRegistry: StepUpRegistry;
  readonly #connections: LiveDeviceConnections;
  readonly #verifier: PasskeyVerifier;
  #wired: Promise<Wired> | undefined;
  #current: Wired | undefined;
  #generation = 0;
  /** Whoever asked to hear of a generation move (Gate re-asks every open stream of the kind, G149). */
  readonly #watchers = new Set<() => void>();
  /** Every device revoked or expired by this run: `revoked` to Gate, never `unknown` (a device id is never reminted). */
  readonly #revoked = new Set<string>();

  constructor(deps: AccessRuntimeDeps) {
    this.#deps = deps;
    this.#stepUpRegistry = new StepUpRegistry(
      { nowMs: () => deps.kernel.clock.nowMs() },
      () => this.settings().stepUpWindowMinutes,
    );
    this.#connections = new LiveDeviceConnections(this.#stepUpRegistry);
    this.#verifier = passkeyVerifier(new WebCryptoPasskeyCrypto()) as unknown as PasskeyVerifier;
  }

  /** The security settings in force: Gate's last good `gate.yaml`, or the shipped defaults (unlock on) when unknown. */
  settings(): SecuritySettings {
    return this.#deps.gate.policy()?.security ?? DEFAULT_SECURITY_SETTINGS;
  }

  ready(): Promise<Wired> {
    this.#wired ??= this.#wire().then(
      wired => {
        this.#current = wired;
        return wired;
      },
      (error: unknown) => {
        // Not kept: the next call tries again (a damaged file repaired, an identity port bound).
        this.#wired = undefined;
        throw error;
      },
    );
    return this.#wired;
  }

  async #wire(): Promise<Wired> {
    const { kernel, gate, host } = this.#deps;
    const clock = kernel.clock;
    const repository = new StatePairingRepository(kernel.state);
    const state = await repository.open(host.identity());
    const registry = new PairingDeviceRegistry(state.daemonId, state.devices);
    const grantAudit = new JournalGrantAudit(kernel.state);
    const securityAudit = new JournalGrantAudit(kernel.state, 'security.changed');
    const vapid = new StateVapidKeys(kernel.state);
    const push = new PushService({
      store: new StatePushRepository(kernel.state),
      keys: vapid,
      transport: new WebPushFetchTransport(
        vapid,
        async (input, init) => await kernel.fetch.request(input, init),
        () => clock.nowMs(),
        (ms, fn) => clock.after(milliseconds(ms), fn),
      ),
      devices: new PairedPushDevices(repository),
      clock: { now: () => clock.now() },
      ids: { next: () => crypto.randomUUID() },
    });
    const passkeysChanged = new PasskeysChangedSignal(
      (ms, fn) => clock.after(milliseconds(ms), fn),
      (error, change) => {
        kernel.log.warn('a passkeys listener failed', {
          cause: change.cause,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    let pairing: PairingService | undefined;
    const passkeyStore = new StatePasskeyStore(kernel.state);
    const stepUp = new StepUpService({
      store: passkeyStore,
      verifier: passkeyVerifier(new WebCryptoPasskeyCrypto()),
      registry: this.#stepUpRegistry,
      audit: grantAudit,
      challenges: new ChallengeLedger(),
      random: { bytes: length => crypto.getRandomValues(new Uint8Array(length)) },
      clock: { nowMs: () => clock.nowMs() },
      devices: {
        device: async deviceId => {
          const record = (await repository.list()).find(candidate => candidate.id === deviceId);
          return record === undefined ? undefined : { name: record.name, createdAt: record.createdAt };
        },
      },
      allowedOrigins: () => host.allowedOrigins(),
      relyingPartyName: 'Ferretry',
      machineName: state.daemonName,
      announce: async notice => await push.notify({ payload: notice }),
      settings: () => this.settings(),
      unlocks: this.#unlockWrites(new StateUnlockLedger(kernel.state, state.daemonId)),
      passkeysChanged,
      rotation: {
        keyIssuedAt: deviceId => pairing?.keyIssuedAt(deviceId),
        verify: async ({ transcriptHash, deviceId, deviceKey, proof }) =>
          await verifyDeviceProof(
            host.ed25519,
            deviceKey,
            proof,
            deviceRotateMessage(transcriptHash, deviceId, deviceKey),
          ),
        rotate: async ({ deviceId, deviceKey, transcriptHash }) => {
          if (pairing === undefined || !(await pairing.rotateDeviceKey(deviceId, deviceKey))) return false;
          // Every OTHER session the device holds lapses (4441) and reopens on the new key (R251).
          this.#connections.lapseDevice(deviceId, Buffer.from(transcriptHash).toString('hex'));
          await securityAudit.record({
            kind: 'device.key-rotated',
            actor: `device:${deviceId}`,
            changes: [`device.key-rotated=${deviceId}`],
            at: clock.now(),
          });
          this.#changed(deviceId, 'grants');
          return true;
        },
      },
    });
    // Connections owns the host-facing reach (`advertisement()`). Without it, the honest answer is `none`: the code is
    // still minted, the link is refused and the fix is named (P84).
    const advertised: ConnectionAdvertisement = this.#deps.connections()?.advertisement() ?? {
      advertisement: { kind: 'none', refusal: 'no-port' },
    };
    pairing = new AccessPairingService(
      {
        daemonId: state.daemonId,
        daemonName: state.daemonName,
        advertisement: advertised.advertisement,
        carriers: { current: () => this.#deps.connections()?.carriers() ?? [] },
        ...(advertised.discoveredRelayUrl === undefined ? {} : { discoveredRelayUrl: advertised.discoveredRelayUrl }),
        clock: { now: () => clock.nowMs() },
        cryptography: new NodePairingCryptography(),
        devices: repository,
        credentials: registry,
        // Revoking a device takes its notifications and its passkeys in the same act; standing sign-in rules are
        // Accounts', which hears `access.devices-changed` (`revoked`) and suspends them.
        deviceState: [push, stepUp],
        connections: this.#connections,
        audit: grantAudit,
        idleExpiryDays: () => this.settings().idleExpiryDays,
      },
      {
        log: async draft => await gate.audit(draft),
        alert: new PushNewDeviceAlert(push, state.daemonName, sentence => kernel.log.warn(sentence)),
        failures: sentence => kernel.log.warn(sentence),
      },
      (deviceId, change) => {
        this.#revoked.add(deviceId);
        this.#changed(deviceId, change);
      },
    );
    const unlockNotice = await stepUp.restore();
    // Today's boot step: a grant unused for the idle period is removed before anything is served, and said once.
    const idleExpired = await pairing.expireIdleDevices();
    if (idleExpired > 0)
      kernel.log.info(
        `${idleExpired} paired device${idleExpired === 1 ? '' : 's'} unused for ${this.settings().idleExpiryDays} days ${idleExpired === 1 ? 'was' : 'were'} removed`,
      );
    const deviceGrants = new DeviceGrantService({
      devices: pairing,
      daemonWide: () => gate.policy()?.grants,
      audit: grantAudit,
      clock: { nowMs: () => clock.nowMs() },
      clientName: host.clientName,
      changed: () => {
        this.#connections.recheckAll();
        this.#moved();
      },
    });
    const guard = gateGuard(gate, host.clientName);
    const routes = new Map<string, RouteHandler>();
    for (const route of [
      ...pairingRoutes(pairing, deviceGrants),
      ...pushRoutes(push, guard),
      ...this.#stepUpRoutes(stepUp),
    ])
      routes.set(routeKey(route), route.handle);
    if (unlockNotice !== undefined) kernel.log.warn(unlockNotice);
    return { pairing, registry, stepUp, passkeyStore, push, routes };
  }

  /** Every unlock or lock is persisted through the ledger: each one is a standing change Gate must re-admit on. */
  #unlockWrites(ledger: StateUnlockLedger): StateUnlockLedger {
    const write = ledger.write.bind(ledger);
    ledger.write = async unlocks => {
      this.#generation += 1;
      await write(unlocks);
      this.#notify();
    };
    return ledger;
  }

  /**
   * The step-up routes, with each staged act's binding asked of its provider at the moment a device asks for the
   * challenge (G83, S90): absent provider, no challenge — the same as today's daemon built without that stage.
   */
  #stepUpRoutes(stepUp: StepUpService): readonly ApiRoute[] {
    const stage = (act: StagedStepUpAct): StagedStepUp | undefined => this.#deps.stages?.(act);
    return stepUpRoutes(
      stepUp,
      { boundSubjectOf: id => stage('add-2fa-key')?.subjectOf?.(id, '') },
      { boundSubjectOf: id => stage('approve-task-plan')?.subjectOf?.(id, '') },
      { challengeOf: (id, deviceId) => stage('approve-sign-in-rule')?.challengeOf?.(id, deviceId) },
      { boundSubjectOf: (id, kind, deviceId) => stage('approve-paste-rule')?.subjectOf?.(id, deviceId, kind) },
    );
  }

  /** The standing of some device moved: bump the generation, then tell the watchers (the new standing is readable). */
  #moved(): void {
    this.#generation += 1;
    this.#notify();
  }

  /** Each watcher hears once per move; one that throws never stops the others. */
  #notify(): void {
    for (const watcher of [...this.#watchers]) {
      try {
        watcher();
      } catch {
        // A listener's failure is its own; the others still hear of the move.
      }
    }
  }

  #changed(device: string, change: 'paired' | 'revoked' | 'expired' | 'grants'): void {
    this.#moved();
    const parsed = PairedDeviceIdSchema.safeParse(device);
    if (parsed.success) this.#deps.kernel.events.publish(DevicesChanged, { device: parsed.data, change });
  }

  /** One handler per manifest route key; each waits for the services to open. */
  handler(key: string): RouteHandler {
    return async call => {
      let wired: Wired;
      try {
        wired = await this.ready();
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        return errorResponse(503, `Access could not open its device grants: ${cause}.`, 'plugin_failed');
      }
      const handle = wired.routes.get(key);
      if (handle === undefined) return errorResponse(404, 'no Access route with that key', 'not_found');
      return await handle(call);
    };
  }

  // ─── the values Access provides ───────────────────────────────────────────────────────────────────────────────

  /** `session.modes:device`: a paired device opening a request or stream session with its key. */
  readonly deviceMode: SessionMode = {
    principalKind: 'device',
    holder: async proof => {
      const claim = DevicePrincipalSchema.safeParse(proof.body);
      if (!claim.success) return undefined;
      const wired = await this.ready();
      const key = await wired.pairing.deviceKey(claim.data.deviceId);
      return key === undefined ? undefined : ({ holder: claim.data.deviceId as HolderId, key } satisfies ModeHolder);
    },
    watch: (holder, watch) => {
      const release = this.#connections.track(
        holder,
        () => watch.revoked(),
        watch.appSession,
        () => watch.regranted(),
        {
          key: watch.session,
          end: () => watch.lapsed(),
        },
      );
      return release;
    },
    seen: holder => this.#current?.pairing.seen(holder),
    rotateBy: holder => {
      const at = this.#current?.stepUp.rotateBy(holder);
      return at === undefined ? undefined : instantFromEpochMs(at);
    },
  };

  /** `session.modes:pair`: one redemption of an invite inside a pre-auth session. */
  readonly pairMode: SessionMode = {
    principalKind: 'none',
    redeem: async (attempt: ModeRedemption): Promise<ModeRedeemed | 'refused'> => {
      const record = PairRecordSchema.safeParse(attempt.proof.body);
      if (!record.success) return 'refused';
      const wired = await this.ready();
      const result = await wired.pairing.redeemInSession(
        { ...record.data, prove: attempt.prove },
        // A direct arrival spends the five direct guesses keyed by its peer; every other carrier spends the separate
        // relay budget (P27, P93).
        (attempt.carrier as string) === 'direct' ? { kind: 'direct', rateLimitKey: attempt.peer } : { kind: 'relay' },
      );
      if (result.kind !== 'paired') return 'refused';
      this.#changed(result.response.deviceId, 'paired');
      return { outcome: 'paired', fields: { response: result.response } };
    },
  };

  /** `credentials:device`: what Gate asks about a device, synchronously, from memory. */
  readonly credentials: CredentialProvider<DeviceHolderStanding> & { watch(listener: () => void): Cancel } = {
    standing: (holder, now) => {
      const wired = this.#current;
      if (wired === undefined) return 'unknown';
      const grants = wired.pairing.deviceGrants(holder);
      if (grants === undefined) return this.#revoked.has(holder) ? 'revoked' : 'unknown';
      const until = wired.stepUp.unlockedUntil(holder);
      return {
        kind: 'device',
        holder,
        grants,
        ...(until === undefined || until <= epochMs(now) ? {} : { unlockedUntil: instantFromEpochMs(until) }),
      };
    },
    generation: () => this.#generation,
    /** Today's `recheckAll` on a grant change, pushed: each generation move tells the listener once, until cancelled. */
    watch: listener => {
      this.#watchers.add(listener);
      return () => {
        this.#watchers.delete(listener);
      };
    },
  };

  /** `step-up:device`: Gate's `StepUpWitness`, answered by Access's own step-up service (fail closed while none is open). */
  readonly witness: StepUpWitness = stepUpProvider(() => this.#current?.stepUp);

  /** What other plugins may ask of Access (Catalogs' verifier, Agenda's buzz). */
  readonly port: AccessApi = {
    devices: async () => await (await this.ready()).pairing.devices(),
    passkeys: this.#verifierProxy(),
    holdsPasskey: async deviceId => {
      const { passkeyStore, pairing } = await this.ready();
      if (pairing.deviceGrants(deviceId) === undefined) return false;
      return (await passkeyStore.list(deviceId)).length > 0;
    },
    holds: async (deviceId, credentialId) => {
      const { passkeyStore, pairing } = await this.ready();
      if (pairing.deviceGrants(deviceId) === undefined) return false;
      return (await passkeyStore.holder(credentialId)) === deviceId;
    },
    verifyStoredProof: async (proof, expectedChallenge) =>
      await (await this.ready()).stepUp.verifyStoredProof(proof, expectedChallenge),
    buzz: async (message: Buzz) => {
      const { push } = await this.ready();
      const result = await push.notify({
        payload: {
          version: 1,
          eventKey: message.tag,
          title: message.title,
          body: message.body,
          tag: message.tag,
          url: message.url,
          count: 1,
        },
      });
      return result.delivered;
    },
  };

  #verifierProxy(): PasskeyVerifier {
    return {
      verifyRegistration: async input => await this.#verifier.verifyRegistration(input),
      verifyAssertion: async input => await this.#verifier.verifyAssertion(input),
    };
  }
}

/**
 * The audited pairing service, telling the runtime when a grant is gone: a revocation (a route names its actor) or the
 * daemon's own idle expiry (no actor). Decided from the registry before and after, so a purge that fails after the
 * grant was removed — the parent throws then — is still reported as the revocation it was.
 */
class AccessPairingService extends AuditedPairingService {
  constructor(
    options: ConstructorParameters<typeof AuditedPairingService>[0],
    audit: ConstructorParameters<typeof AuditedPairingService>[1],
    private readonly gone: (deviceId: string, change: 'revoked' | 'expired') => void,
  ) {
    super(options, audit);
  }

  override async revokeDevice(id: string, actor?: string): Promise<boolean> {
    const held = this.deviceGrants(id) !== undefined;
    try {
      return await super.revokeDevice(id, actor);
    } finally {
      if (held && this.deviceGrants(id) === undefined) this.gone(id, actor === undefined ? 'expired' : 'revoked');
    }
  }
}

/**
 * The grants decision the push routes render (today's `CapabilityGuard` over the daemon-wide document): Gate's
 * policy in force AND the caller's own device record, from the presentation Gate stamped on the call.
 */
export function gateGuard(gate: GateApi, clientName: string): CapabilityGuard {
  const evaluate = (presentation: Parameters<CapabilityGuard['decide']>[1]): GrantEvaluation => ({
    grants: gate.policy()?.grants,
    governed: isGovernedCaller({ loopback: presentation.local }),
    hostLocal: presentation.local,
    stepUp: presentation.stepUp,
    ...(isGovernedCaller({ loopback: presentation.local }) && presentation.deviceGrants !== undefined
      ? { device: presentation.deviceGrants }
      : {}),
  });
  return {
    decide: (demand, presentation) => decideCapability(demand, evaluate(presentation)),
    governance: presentation => {
      const evaluation = evaluate(presentation);
      return { governed: evaluation.governed, decide: demand => decideCapability(demand, evaluation) };
    },
    explain: (demand, refusal) => describeGrantRefusal(demand, refusal, clientName),
  };
}
