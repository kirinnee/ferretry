import type { ConfigDef } from '@ferretry/kernel/contract';
import { definePlugin } from '@ferretry/kernel/manifest';
import {
  AdminTokenFile,
  AdmissionPort,
  AuditLogFile,
  Bearers,
  Credentials,
  GateConfigFile,
  GatePolicyChanged,
  GatePort,
  StepUp,
  WardenTokenFile,
} from './contract/index.ts';

/**
 * Gate (§2.2): checks every call before it runs. Core; cannot be turned off. Its routes (audit, security settings,
 * step-up, the ferret credential) are added by the Gate port with today's descriptors; the day-1 spine declares the
 * contract surface only.
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
  data: {
    state: [AdminTokenFile, WardenTokenFile, AuditLogFile],
    // Cast: the leaf's `DataSection.config` is `ConfigDef<unknown>[]`, contravariant in `loosens`, so no typed config
    // fits it. Reported to the lead (a leaf change: `ConfigDef<any>`); drop the cast when it lands.
    config: [GateConfigFile as ConfigDef<any>],
    publishes: [GatePolicyChanged],
  },
  hooks: {
    offers: [{ hook: Credentials }, { hook: StepUp }, { hook: Bearers }],
  },
});
