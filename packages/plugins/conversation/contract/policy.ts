import { type CapabilityAxis, type CapabilityDemand, policyRef } from '@ferretry/kernel/contract';

/** Capabilities Conversation's routes ask the operator about. Gate owns the vocabulary; these are today's names. */
export type ConversationCapability = 'fleet' | 'terminal';

/** `capability: cap('fleet', 'use')`. */
export const cap = (name: ConversationCapability, axis: CapabilityAxis): CapabilityDemand => ({
  capability: policyRef('capability', name),
  axis,
});

/** The same demand, only taking away (grant and unlock still asked, never a per-act passkey). */
export const narrowing = (name: ConversationCapability, axis: CapabilityAxis): CapabilityDemand => ({
  ...cap(name, axis),
  narrowing: true,
});

/** Audit kinds this plugin adds (one per writing route). */
export const MESSAGE_SENT_AUDIT = policyRef('audit', 'conversation.message-sent');
export const TURN_INTERRUPTED_AUDIT = policyRef('audit', 'conversation.turn-interrupted');
export const QUEUE_EDITED_AUDIT = policyRef('audit', 'conversation.queue-edited');
export const QUEUE_CANCELLED_AUDIT = policyRef('audit', 'conversation.queue-cancelled');
export const SEND_RETRIED_AUDIT = policyRef('audit', 'conversation.send-retried');
export const SEND_CANCELLED_AUDIT = policyRef('audit', 'conversation.send-cancelled');
export const SEND_ENTERED_AUDIT = policyRef('audit', 'conversation.send-entered');
export const COMPOSER_ACTED_AUDIT = policyRef('audit', 'conversation.composer-acted');
export const QUESTION_ANSWERED_AUDIT = policyRef('audit', 'conversation.question-answered');
export const ATTACHMENT_ADDED_AUDIT = policyRef('audit', 'conversation.attachment-added');
export const ATTACHMENT_UNLOCKED_AUDIT = policyRef('audit', 'conversation.attachment-unlocked');
export const ATTACHMENT_RELOCKED_AUDIT = policyRef('audit', 'conversation.attachment-relocked');
export const COMPACT_AT_CHANGED_AUDIT = policyRef('audit', 'conversation.compact-at-changed');
export const HYPERMEDIA_CHANGED_AUDIT = policyRef('audit', 'conversation.hypermedia-changed');
export const RENDER_SAVED_AUDIT = policyRef('audit', 'conversation.render-saved');
export const DRAFT_EDITED_AUDIT = policyRef('audit', 'conversation.draft-edited');
export const LINKS_ADOPTED_AUDIT = policyRef('audit', 'conversation.links-adopted');
export const RELATED_SEARCHED_AUDIT = policyRef('audit', 'conversation.related-searched');
