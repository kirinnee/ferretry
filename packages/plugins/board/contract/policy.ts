import { type CapabilityAxis, type CapabilityDemand, policyRef } from '@ferretry/kernel/contract';

/** A grant demand on a capability Gate owns (`fleet`, `terminal`). Gate owns the vocabulary; Board adds none. */
export const cap = (capability: string, axis: CapabilityAxis): CapabilityDemand => ({
  capability: policyRef('capability', capability),
  axis,
});
export const narrowing = (demand: CapabilityDemand): CapabilityDemand => ({ ...demand, narrowing: true });

// Audit kinds this plugin adds.
export const CARD_CREATED_AUDIT = policyRef('audit', 'card.created');
export const CARD_ACTED_AUDIT = policyRef('audit', 'card.acted');
export const CARD_STARTED_AUDIT = policyRef('audit', 'card.started');
export const BOARD_SKIPPED_AUDIT = policyRef('audit', 'board.skipped');
export const LANES_CHANGED_AUDIT = policyRef('audit', 'board.lanes-changed');
export const BOARD_SWITCHED_AUDIT = policyRef('audit', 'board.switched');
export const PLAN_STAGED_AUDIT = policyRef('audit', 'plan.staged');
export const PLAN_COMMITTED_AUDIT = policyRef('audit', 'plan.committed');
export const PLAN_CONFIRMED_AUDIT = policyRef('audit', 'plan.confirmed');
export const PLAN_STAGE_DROPPED_AUDIT = policyRef('audit', 'plan.stage-dropped');
export const PLAN_REVOKED_AUDIT = policyRef('audit', 'plan.revoked');
