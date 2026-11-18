import { describe, expect, test } from 'bun:test';
import { panelsInSlot } from '@ferretry/app/testing';
import {
  AGENDA_CONVERSATION_SLOT as CONVERSATION_WRITES,
  CONVERSATION_ABOVE_COMPOSER_SLOT,
} from '@ferretry/plugin-conversation/contract';
import { AGENDA_BANNER_SLOT, AGENDA_CONVERSATION_SLOT } from '../../../contract/index.ts';

describe('the slot Agenda offers and Conversation fills', () => {
  test('Conversation writes the name Agenda owns, and contributes the ferret’s conversation to it', () => {
    expect(CONVERSATION_WRITES).toBe(AGENDA_CONVERSATION_SLOT);
    expect(panelsInSlot(AGENDA_CONVERSATION_SLOT)).toEqual(['conversation.agenda-conversation']);
  });
});

describe('the slot Agenda offers under its header and Access fills', () => {
  test('Access puts its "notifications are off" line under the Agenda header, as v4 did on the Inbox', () => {
    expect(AGENDA_BANNER_SLOT.startsWith('agenda.')).toBe(true);
    expect(panelsInSlot(AGENDA_BANNER_SLOT)).toEqual(['access.agenda-notifications-off']);
  });
});

describe('the slot Conversation offers above its composer and Claude Code, Agenda and Voice fill', () => {
  test('Agenda puts its ferret agenda line in the slot Conversation offers above its composer', () => {
    expect(panelsInSlot(CONVERSATION_ABOVE_COMPOSER_SLOT)).toContain('agenda.ferret-agenda-line');
  });
});
