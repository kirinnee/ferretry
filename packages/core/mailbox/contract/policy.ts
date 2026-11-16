import { type CapabilityAxis, type CapabilityDemand, policyRef } from '@ferretry/kernel/contract';

/** `capability: cap('fleet', 'use')`: the demands the send routes ask the operator about. Gate owns the vocabulary. */
export const cap = (name: 'fleet' | 'terminal', axis: CapabilityAxis): CapabilityDemand => ({
  capability: policyRef('capability', name),
  axis,
});

/**
 * Audit kinds the send routes write, one per writing route. Their names are the ones the audit log has always held
 * (`conversation.*`); the Mailbox now owns the routes that record them, and a record already written keeps its name.
 */
export const MESSAGE_SENT_AUDIT = policyRef('audit', 'conversation.message-sent');
export const TURN_INTERRUPTED_AUDIT = policyRef('audit', 'conversation.turn-interrupted');
export const QUEUE_EDITED_AUDIT = policyRef('audit', 'conversation.queue-edited');
export const QUEUE_CANCELLED_AUDIT = policyRef('audit', 'conversation.queue-cancelled');
export const SEND_RETRIED_AUDIT = policyRef('audit', 'conversation.send-retried');
export const SEND_CANCELLED_AUDIT = policyRef('audit', 'conversation.send-cancelled');
export const SEND_ENTERED_AUDIT = policyRef('audit', 'conversation.send-entered');
export const COMPOSER_ACTED_AUDIT = policyRef('audit', 'conversation.composer-acted');
