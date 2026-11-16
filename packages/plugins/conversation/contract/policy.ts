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
