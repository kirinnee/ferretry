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
 * The security log's other three files (today's `audit.1.jsonl`, `audit-kept.jsonl`, `audit-kept.1.jsonl`): the
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
        audit: { skip: 'reading the security log is not itself a security act' },
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
        audit: { record: AUDIT_KINDS['security.changed'] },
        guard: { none: 'six security settings and their source; no secret' },
      }),
    ],
    cli: [
      verb('daemon audit', {
        summary: 'show the security log: who was paired, removed or refused, and what was done, newest first',
      }),
      verb('daemon security show', {
        summary: 'show every setting, its bounds and where the values came from',
      }),
      verb('daemon security set <field> <value>', { summary: 'change one setting' }),
    ],
  },
  data: {
    state: [AdminTokenFile, WardenTokenFile, AuditLogFile, AuditRotatedFile, AuditKeptFile, AuditKeptRotatedFile],
    // Cast: the leaf's `DataSection.config` is `ConfigDef<unknown>[]`, contravariant in `loosens`, so no typed config
    // fits it. Reported to the lead (a leaf change: `ConfigDef<any>`); drop the cast when it lands.
    config: [GateConfigFile as ConfigDef<any>],
    publishes: [GatePolicyChanged],
  },
  hooks: {
    offers: [{ hook: Credentials }, { hook: StepUp }, { hook: Bearers }],
  },
});
