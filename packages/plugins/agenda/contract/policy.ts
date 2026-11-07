import { type CapabilityAxis, type CapabilityDemand, policyRef } from '@ferretry/kernel/contract';

/** A grant demand on a capability Gate owns (`fleet`, …). Gate owns the vocabulary; Agenda adds none. */
export const cap = (capability: string, axis: CapabilityAxis): CapabilityDemand => ({
  capability: policyRef('capability', capability),
  axis,
});

/** Audit kinds this plugin adds. */
export const AGENDA_CLEARED_AUDIT = policyRef('audit', 'agenda.cleared-agents');
export const AGENDA_MODE_CHANGED_AUDIT = policyRef('audit', 'agenda.mode-changed');
export const MACHINE_AGENDA_ACTED_AUDIT = policyRef('audit', 'agenda.machine-acted');
