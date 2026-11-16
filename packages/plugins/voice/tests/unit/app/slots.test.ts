import { describe, expect, test } from 'bun:test';
import { isSlotName } from '@ferretry/app';
import { panelsInSlot } from '@ferretry/app/testing';
import { CONVERSATION_ABOVE_COMPOSER_SLOT } from '@ferretry/plugin-conversation/contract';

describe('the slot Conversation offers above its composer and Claude Code, Agenda and Voice fill', () => {
  test('Voice puts its auto-read in the slot Conversation offers above its composer', () => {
    expect(CONVERSATION_ABOVE_COMPOSER_SLOT).toBe('conversation.above-composer');
    expect(isSlotName(CONVERSATION_ABOVE_COMPOSER_SLOT)).toBe(true);
    expect(panelsInSlot(CONVERSATION_ABOVE_COMPOSER_SLOT)).toContain('voice.auto-read');
  });
});
