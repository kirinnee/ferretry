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
  GrantAuditEntryViewSchema,
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

/**
 * `state/gate/grant-audit.jsonl` (F-0251): who changed a daemon-wide grant, when. Each line is checked on its own
 * against the entry's schema, so one damaged line is counted and the valid ones around it are still read.
 */
export const GrantAuditFile = defineState({
  name: 'grant-audit',
  path: 'grant-audit.jsonl',
  store: 'jsonl',
  format: 1,
  schema: GrantAuditEntryViewSchema,
  mode: 0o600,
});

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
        // Recorded for EVERY outcome — a change, a refused widen, a failed read — by the audited-route table
        // (`daemon/lib/audit/routes.ts`); the service keeps the change lines in the grant journal (G115).
        audit: { record: AUDIT_KINDS['security.changed'] },
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
      verb('daemon config', { summary: 'read and change what a caller NOT on this host may do', args: [] }),
      verb('daemon config ls', {
        summary: 'show every capability, both axes, and where each value came from',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol document instead of the human report' }],
      }),
      verb('daemon config history', {
        summary: 'who changed a grant on this machine, and when',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol document instead of the human listing' }],
      }),
      verb('daemon config set <capability>', {
        summary: 'grant or revoke one capability, by axis',
        args: [
          {
            name: 'capability',
            help: 'the capability: fleet, terminal, browser, filesystem, warden, pairing, secrets or sharing',
          },
        ],
        options: [
          { flag: '--use', help: 'let a remote caller exercise this capability' },
          { flag: '--no-use', help: 'stop a remote caller exercising this capability' },
          { flag: '--configure', help: "let a remote caller change this capability's host settings" },
          { flag: '--no-configure', help: "stop a remote caller changing this capability's host settings" },
        ],
      }),
      verb('daemon audit', {
        summary: 'show the audit: who was paired, removed or refused, and what was done, newest first',
        args: [],
        options: [
          { flag: '--limit <n>', help: 'how many records of each section to show (at most 200)' },
          { flag: '--kept-skip <n>', help: 'skip the newest n security changes, to page back through older ones' },
          { flag: '--json', help: 'print the protocol document instead of the human listing' },
        ],
      }),
      verb('daemon security', { summary: 'read and change this machine’s security settings', args: [] }),
      verb('daemon security show', {
        summary: 'show every setting, its bounds and where the values came from',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol document instead of the human report' }],
      }),
      verb('daemon security set <field> <value>', {
        summary: 'change one setting',
        args: [
          { name: 'field', help: 'the security setting to change' },
          { name: 'value', help: 'the new value' },
        ],
      }),
    ],
  },
  /** Never reached by a ferret, through any root: the admin and warden bearers (`PrivacyDecl`). */
  privacy: {
    private: ['admin-token', 'warden-token'],
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
