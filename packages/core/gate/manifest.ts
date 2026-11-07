import { type ConfigDef, defineState } from '@ferretry/kernel/contract';
import { definePlugin, route, verb } from '@ferretry/kernel/manifest';
import {
  AdminTokenFile,
  AdmissionPort,
  AUDIT_KINDS,
  AuditLogFile,
  AuditRecordSchema,
  Bearers,
  cap,
  Credentials,
  GateConfigFile,
  GatePolicyChanged,
  GatePort,
  StepUp,
  WardenTokenFile,
} from './contract/index.ts';

/**
 * The audit's other three files (today's `audit.1.jsonl`, `audit-kept.jsonl`, `audit-kept.1.jsonl`): the
 * general store's rotated file and the kept store a flood cannot reach (F-0075…F-0078). Declared here rather than in
 * the frozen contract because no other package reads them.
 */
export const AuditRotatedFile = defineState({
  name: 'audit-rotated',
  path: 'audit.1.jsonl',
  store: 'jsonl',
  format: 1,
  schema: AuditRecordSchema,
  mode: 0o600,
});
export const AuditKeptFile = defineState({
  name: 'audit-kept',
  path: 'audit-kept.jsonl',
  store: 'jsonl',
  format: 1,
  schema: AuditRecordSchema,
  mode: 0o600,
});
export const AuditKeptRotatedFile = defineState({
  name: 'audit-kept-rotated',
  path: 'audit-kept.1.jsonl',
  store: 'jsonl',
  format: 1,
  schema: AuditRecordSchema,
  mode: 0o600,
});

/** `state/gate/grant-audit.jsonl` (F-0251): who changed a daemon-wide grant, when. Parsed by the daemon half. */
export const GrantAuditFile = defineState({ name: 'grant-audit', path: 'grant-audit.jsonl', store: 'jsonl', format: 1, mode: 0o600 });

/**
 * Gate (§2.2): checks every call before it runs. Core; cannot be turned off. It provides the kernel-bound admission,
 * offers the `credentials`, `step-up` and `bearers` hooks, and serves the audit read and the security settings with
 * today's descriptors (R-0048, R-0133, R-0224).
 */
export default definePlugin({
  id: 'gate',
  title: 'Gate',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  words: [
    { word: 'call', means: 'one request to the daemon', insteadOf: ['request'] },
    { word: 'local', means: "arrived through this machine's own listener", insteadOf: ['loopback'] },
    { word: 'audit', means: 'the record of security acts', insteadOf: ['security log'] },
  ],
  provides: { gate: GatePort, admission: AdmissionPort },
  actions: {
    routes: [
      // The log is not only the device list: it says which secrets were used and which terminals were typed into, so
      // it is `pairing.configure`, not `pairing.use` (G169). A warden is refused by the `operator` minimum.
      route('GET /v1/audit', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('pairing', 'configure'),
        noStore: true,
        audit: { skip: 'reading the audit is not itself a security act' },
        guard: { none: 'names and ids of security acts only; never a pane, page or vault value' },
      }),
      // How strict the machine is, readable before the unlock, so the app can say why (R-0133).
      route('GET /v1/security', {
        minimum: 'operator',
        caller: 'any',
        unlockExempt: true,
        noStore: true,
        audit: { skip: 'a read of the security settings' },
        guard: { none: 'six security settings and their source; no secret' },
      }),
      // Tighten from anywhere, loosen only at the machine (G111–G116).
      route('PATCH /v1/security', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('pairing', 'configure'),
        noStore: true,
        // The service journals `security.changed` itself, with each field's old and new value and the
        // `security.loosened-with=passkey` line (G115), which a status-only record could not carry.
        audit: { skip: 'SecuritySettingsService records security.changed with the change lines itself' },
        guard: { none: 'six security settings and their source; no secret' },
      }),
      // The grant surface (lead decision: Gate declares /v1/grants*). The read is not capability-gated: a restricted UI
      // must be able to discover why it is restricted (G124). A subject of the decision may read it, a warden included.
      route('GET /v1/grants', {
        minimum: 'authenticated',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read of the grants in effect' },
        guard: { none: 'capability names, booleans and refusal reasons only' },
      }),
      // Names devices, so not a warden's to read (G160).
      route('GET /v1/grants/audit', {
        minimum: 'operator',
        caller: 'person',
        noStore: true,
        audit: { skip: 'reading the grant history is not itself a security act' },
        guard: { none: 'actors and capability axes only' },
      }),
      // Not route-gated: may this caller change X is asked per capability in the patch (G122, G123).
      route('PATCH /v1/grants', {
        minimum: 'operator',
        caller: 'person',
        noStore: true,
        audit: { record: AUDIT_KINDS['grants.changed'] },
        guard: { none: 'capability names, booleans and refusal reasons only' },
      }),
    ],
    cli: [
      verb('daemon config', { summary: 'read and change what a caller NOT on this host may do' }),
      verb('daemon config ls', { summary: 'show every capability, both axes, and where each value came from' }),
      verb('daemon config list', { summary: 'the same as daemon config ls' }),
      verb('daemon config history', { summary: 'who changed a grant on this machine, and when' }),
      verb('daemon config log', { summary: 'who changed a grant on this machine, and when' }),
      verb('daemon config set <capability>', { summary: 'grant or revoke one capability, by axis' }),
      verb('daemon audit', {
        summary: 'show the audit: who was paired, removed or refused, and what was done, newest first',
      }),
      verb('daemon security', { summary: 'read and change this machine’s security settings' }),
      verb('daemon security show', {
        summary: 'show every setting, its bounds and where the values came from',
      }),
      verb('daemon security set <field> <value>', { summary: 'change one setting' }),
    ],
  },
  data: {
    state: [
      AdminTokenFile,
      WardenTokenFile,
      AuditLogFile,
      AuditRotatedFile,
      AuditKeptFile,
      AuditKeptRotatedFile,
      GrantAuditFile,
    ],
    // Cast: the leaf's `DataSection.config` is `ConfigDef<unknown>[]`, contravariant in `loosens`, so no typed config
    // fits it. Reported to the lead (a leaf change: `ConfigDef<any>`); drop the cast when it lands.
    config: [GateConfigFile as ConfigDef<any>],
    publishes: [GatePolicyChanged],
  },
  hooks: {
    offers: [{ hook: Credentials }, { hook: StepUp }, { hook: Bearers }],
  },
});
