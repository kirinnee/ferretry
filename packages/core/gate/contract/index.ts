/**
 * `@ferretry/core-gate/contract` (§2.1, §7.1, §9.6): the policy vocabulary, Gate's standing on every call (merged into
 * the kernel's `CallStanding` / `MemberStanding`), the `credentials`, `step-up` and `bearers` hooks, `gate.yaml`, the
 * audit log, the inventory projection, and Gate's port. Re-exports the kernel-bound `AdmissionPort` and the
 * kernel-minted `SessionPrincipal` (spine D4, D5).
 */
export {
  type Admission,
  type AdmissionDecision,
  type AdmissionInput,
  AdmissionPort,
  type AdmissionTable,
  type SessionPrincipal,
} from '@ferretry/kernel/contract';
export * from './audit.ts';
export * from './credentials.ts';
export * from './gate-config.ts';
export * from './grants.ts';
export * from './inventory.ts';
export * from './policy.ts';
export * from './port.ts';
export * from './standing.ts';
