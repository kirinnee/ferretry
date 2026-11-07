import { ApiError, type ApiResponse, type CallContext, type ConfigFileDef } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { milliseconds } from '@ferretry/std';
import {
  AdminTokenFile,
  type AuditDraft,
  AuditLogFile,
  Bearers,
  Credentials,
  type CapabilityName,
  type CredentialProvider,
  type DeviceHolderStanding,
  type FerretBearerDirectory,
  type GateApi,
  type GateConfig,
  GateConfigFile,
  GatePolicyChanged,
  type MemberHolderStanding,
  securitySettingsOf,
  StepUp,
  WardenTokenFile,
} from '../contract/index.ts';
import manifest, { AuditKeptFile, AuditKeptRotatedFile, AuditRotatedFile, GrantAuditFile } from '../manifest.ts';
import { StateGrantHistory } from './adapters/grants/state-grant-history.ts';
import { GateConfigNotSaved, GateConfigWriter } from './adapters/config/gate-config-writer.ts';
import { grantsNamedIn } from './lib/grants/provenance.ts';
import { GrantService } from './lib/grants/service.ts';
import { type GateConfigSource, policyInEffect } from './lib/policy/in-effect.ts';
import { StateAuditJournal } from './adapters/audit/state-audit-journal.ts';
import { StateTokens } from './adapters/tokens/state-tokens.ts';
import { GateAdmission } from './lib/api/admission.ts';
import type { GateTokens } from './lib/api/authentication.ts';
import { AUDIT_FOLD_WINDOW_MS, AuditLog } from './lib/audit/service.ts';
import { gateRoutes, grantRoutes } from './lib/routes.ts';
import { SecuritySettingsService } from './lib/security/service.ts';
import { FailClosedStepUps } from './lib/step-up/witness.ts';

/** The binary's name, for sentences that name a command (two-name model: the shell owns the real value). */
const CLIENT_NAME = 'fy';

/**
 * Gate's daemon half (§2.2): provides the kernel-bound admission and Gate's port, records the audit log, and serves
 * the audit read and the security settings. Every answer it gives is computed per call from live state: the tokens
 * (loaded once), `gate.yaml` in effect, and the `credentials` / `bearers` providers Access, Catalogs and Ferrets bind.
 */
export default implementDaemon(manifest, {
  build(ctx) {
    const { kernel, hooks } = ctx;
    const log = kernel.log.child('gate');

    // ─── tokens: loaded before anything is served; until then every bearer is refused (fail closed) ─────────────
    // ONE load, shared: the eager load and the start job await the same promise, so two loads can never mint twice
    // and leave the accepted token different from the persisted one (today awaits one credential load). A failed
    // load is forgotten, so the start job tries again.
    let tokens: GateTokens | undefined;
    const tokenStore = new StateTokens(kernel.state, { admin: AdminTokenFile, warden: WardenTokenFile });
    let loading: Promise<void> | undefined;
    const loadTokens = (): Promise<void> => {
      loading ??= tokenStore.load().then(
        loaded => {
          tokens = loaded;
        },
        (error: unknown) => {
          loading = undefined;
          throw error;
        },
      );
      return loading;
    };
    loadTokens().catch(error => log.error('the daemon tokens could not be loaded', { reason: String(error) }));
    kernel.jobs.add({ id: 'gate.tokens', schedule: { onceAfterStart: true }, run: loadTokens });

    // ─── policy: `gate.yaml` in effect; only a missing file is the product default (G6, G152), damage is
    // undetermined (G153, G154): the kernel's `fileState` tells the two apart.
    const gateFile = GateConfigFile as ConfigFileDef<GateConfig>;
    const policySource: GateConfigSource = {
      file: () => kernel.config.file(gateFile),
      fileState: () => kernel.config.fileState(gateFile),
    };
    const policy = (): GateConfig | undefined => policyInEffect(policySource);
    // ─── provenance (G155): which capabilities `gate.yaml` NAMES, read from its raw text ───────────────────────
    const configFiles = kernel.configFiles;
    const target = { plugin: manifest.id, def: gateFile };
    let namedGrants: readonly CapabilityName[] = [];
    const readProvenance = async (): Promise<void> => {
      if (configFiles === undefined) return;
      try {
        const read = await configFiles.read(target);
        namedGrants = read?.exists === true && read.text !== undefined ? grantsNamedIn(Bun.YAML.parse(read.text)) : [];
      } catch {
        // An unreadable file names nothing it can prove: every capability reads as the product's answer.
        namedGrants = [];
      }
    };
    void readProvenance();
    let generation = 0;

    // ─── audit ──────────────────────────────────────────────────────────────────────────────────────────────────
    const audit = new AuditLog({
      journal: new StateAuditJournal(kernel.state, {
        general: { live: AuditLogFile, rotated: AuditRotatedFile },
        kept: { live: AuditKeptFile, rotated: AuditKeptRotatedFile },
      }),
      clock: { now: () => kernel.clock.now(), nowMs: () => kernel.clock.nowMs() },
      failures: message => log.warn(message),
    });
    const record = async (draft: AuditDraft): Promise<void> => await audit.record(draft);
    // J-0004/J-0114: a burst that STOPS is still written down.
    kernel.jobs.add({
      id: 'gate.audit-flush',
      schedule: { every: milliseconds(AUDIT_FOLD_WINDOW_MS) },
      run: async () => await audit.flush(),
    });
    kernel.lifecycle.onStop(async () => await audit.flush(Number.POSITIVE_INFINITY));

    // ─── providers the security path binds ─────────────────────────────────────────────────────────────────────
    const provided = <V>(value: V | 'unavailable'): V | undefined => (value === 'unavailable' ? undefined : value);
    const devices = (): CredentialProvider<DeviceHolderStanding> | undefined =>
      provided(hooks.provider(Credentials, 'device')) as CredentialProvider<DeviceHolderStanding> | undefined;
    const members = (): CredentialProvider<MemberHolderStanding> | undefined =>
      provided(hooks.provider(Credentials, 'member')) as CredentialProvider<MemberHolderStanding> | undefined;
    const ferrets = (): FerretBearerDirectory | undefined => provided(hooks.provider(Bearers, 'ferret'));

    // `step-up:device` (Access alone): read live, so a provider that goes away is no step-up at once (fail closed).
    const stepUps = new FailClosedStepUps(() => provided(hooks.provider(StepUp, 'device')));
    /** The kind of a config file, for an audit record: the plugin that declares it, never the path or a name in it. */
    const configKind = (path: string): string | undefined =>
      configFiles
        ?.declarations()
        .find(({ def }) => (def.shape === 'file' ? def.file === path : path.startsWith(`${def.collection}/`)))?.plugin;

    const admission = new GateAdmission({
      tokens: () => tokens,
      ferrets,
      devices,
      members,
      policy,
      stepUps,
      now: () => kernel.clock.now(),
      refused: draft => {
        void record(draft);
      },
      recorded: draft => {
        void record(draft);
      },
      configKind,
      clientName: CLIENT_NAME,
    });
    // Every policy generation change re-asks the open streams (G149) and is announced.
    kernel.config.watch(gateFile, () => {
      void readProvenance();
      generation += 1;
      kernel.events.publish(GatePolicyChanged, { generation });
      admission.policyChanged();
    });
    const writer = new GateConfigWriter(() => configFiles, target);

    const security = new SecuritySettingsService({
      document: {
        read: () => {
          const current = policy();
          return current === undefined
            ? { kind: 'damaged' }
            : { kind: 'document', settings: securitySettingsOf(current.security) };
        },
        // The member unlock is not a `/v1/security` setting: the block is written back with it unchanged.
        write: async settings => {
          const current = policy();
          if (current === undefined) throw new GateConfigNotSaved('gate.yaml could not be read, so nothing was saved');
          await writer.write('security', { ...settings, memberUnlockDays: current.security.memberUnlockDays });
        },
      },
      audit: record,
      clock: { now: () => kernel.clock.now() },
      widenCommand: `${CLIENT_NAME} daemon security set`,
    });

    const grants = new GrantService({
      document: {
        read: () => policy()?.grants,
        written: () => namedGrants,
        write: async next => await writer.write('grants', next),
      },
      history: new StateGrantHistory(kernel.state, GrantAuditFile),
      clock: { now: () => kernel.clock.now() },
      clientName: CLIENT_NAME,
    });

    const routes = gateRoutes({ audit, security });
    const grantHandlers = grantRoutes(grants);
    const gate: GateApi = { audit: record, policy };
    /** A save the config writer did not make answers 503 with its sentence; nothing was applied. */
    const savingConfig =
      (handler: (call: CallContext) => Promise<ApiResponse>) =>
      async (call: CallContext): Promise<ApiResponse> => {
        try {
          return await handler(call);
        } catch (error) {
          if (error instanceof GateConfigNotSaved) throw new ApiError(503, error.message, 'config_not_saved');
          throw error;
        }
      };

    return {
      routes: {
        'GET /v1/audit': routes['GET /v1/audit'],
        'GET /v1/security': routes['GET /v1/security'],
        'PATCH /v1/security': savingConfig(routes['PATCH /v1/security']),
        'GET /v1/grants': grantHandlers['GET /v1/grants'],
        'GET /v1/grants/audit': grantHandlers['GET /v1/grants/audit'],
        'PATCH /v1/grants': savingConfig(grantHandlers['PATCH /v1/grants']),
      },
      provides: { gate, admission },
    };
  },
});
