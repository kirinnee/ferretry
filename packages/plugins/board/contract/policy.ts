import { type CapabilityAxis, type CapabilityDemand, policyRef } from '@ferretry/kernel/contract';

/** A grant demand on a capability Gate owns (`fleet`, `terminal`). Gate owns the vocabulary; Board adds none. */
export const cap = (capability: string, axis: CapabilityAxis): CapabilityDemand => ({
  capability: policyRef('capability', capability),
  axis,
});

// Audit kinds this plugin adds. (Rows written before the rename say `card.created`, `card.acted` and `card.started`;
// Gate's audit read spells them as these.)
export const TASK_CREATED_AUDIT = policyRef('audit', 'task.created');
export const TASK_ACTED_AUDIT = policyRef('audit', 'task.acted');
export const TASK_STARTED_AUDIT = policyRef('audit', 'task.started');
export const BOARD_SKIPPED_AUDIT = policyRef('audit', 'board.skipped');
export const LANES_CHANGED_AUDIT = policyRef('audit', 'board.lanes-changed');
export const BOARD_SWITCHED_AUDIT = policyRef('audit', 'board.switched');
