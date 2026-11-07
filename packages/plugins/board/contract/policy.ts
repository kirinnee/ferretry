import { type CapabilityAxis, type CapabilityDemand, policyRef } from '@ferretry/kernel/contract';

/** A grant demand on a capability Gate owns (`fleet`, `terminal`). Gate owns the vocabulary; Board adds none. */
export const cap = (capability: string, axis: CapabilityAxis): CapabilityDemand => ({
  capability: policyRef('capability', capability),
  axis,
});

// Audit kinds this plugin adds.
export const CARD_CREATED_AUDIT = policyRef('audit', 'card.created');
export const CARD_ACTED_AUDIT = policyRef('audit', 'card.acted');
export const CARD_STARTED_AUDIT = policyRef('audit', 'card.started');
export const BOARD_SKIPPED_AUDIT = policyRef('audit', 'board.skipped');
export const LANES_CHANGED_AUDIT = policyRef('audit', 'board.lanes-changed');
export const BOARD_SWITCHED_AUDIT = policyRef('audit', 'board.switched');
