import { describe, expect, test } from 'bun:test';
import { contributedSlots, panelsInSlot } from '@ferretry/app/testing';
import { ACTIONS_ROW_SLOT, FILES_SEARCH_SLOT } from '@ferretry/core-ferrets/contract';
import { CONVERSATION_SLOTS } from '../../../contract/index.ts';

describe('the slot Conversation offers above its composer and Claude Code, Agenda and Voice fill', () => {
  test('every panel contributed to a conversation.* slot is one of the slots Conversation’s contract names', () => {
    const named: readonly string[] = CONVERSATION_SLOTS;
    const contributed = contributedSlots('conversation.');
    expect(contributed.length).toBeGreaterThan(0);
    for (const slot of contributed) expect(named).toContain(slot);
  });
});

describe('the slots Conversation fills in Ferrets', () => {
  test('Conversation puts its Interrupt row in the Actions ▾ menu and its file search in Ferrets’ search, through the names Ferrets owns', () => {
    expect(panelsInSlot(ACTIONS_ROW_SLOT)).toContain('conversation.interrupt-row');
    expect(panelsInSlot(ACTIONS_ROW_SLOT)).toContain('conversation.stuck-messages-row');
    expect(panelsInSlot(FILES_SEARCH_SLOT)).toContain('conversation.files-search');
  });
});
