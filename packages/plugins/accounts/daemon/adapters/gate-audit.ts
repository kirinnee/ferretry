import { auditKind, type GateApi } from '@ferretry/core-gate/contract';
import type { AuditSink } from '../lib/local-ports.ts';

/**
 * Accounts' one audit sink: every record goes to Gate (`GateApi.audit`), which stamps and keeps it.
 * TODO(gate contract): `cause` is approved additively; it is preserved at the call until Gate accepts it.
 */
export const gateAuditSink = (gate: Pick<GateApi, 'audit'>): AuditSink => ({
  record: async entry => await gate.audit({ ...entry, event: auditKind(entry.event) }),
});
