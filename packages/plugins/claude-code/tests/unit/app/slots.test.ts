import { describe, expect, test } from 'bun:test';
import { isSlotName } from '@ferretry/app';
import { consumesOf, dependenciesOf, panelsInSlot } from '@ferretry/app/testing';

/**
 * Claude Code fills a slot Conversation offers and imports nothing of Conversation, so it writes the name as a literal;
 * Conversation's contract and the Voice and Agenda suites pin the same literal.
 */
const ABOVE_COMPOSER = 'conversation.above-composer';

describe('the slot Conversation offers above its composer and Claude Code, Agenda and Voice fill', () => {
  test('Claude Code writes the name Conversation owns, and puts its two cards there', () => {
    expect(isSlotName(ABOVE_COMPOSER)).toBe(true);
    expect(panelsInSlot(ABOVE_COMPOSER).filter(panel => panel.startsWith('claude-code.'))).toEqual([
      'claude-code.permission-request',
      'claude-code.harness-dialog',
    ]);
  });

  test('Claude Code imports nothing of Conversation: the two agree by name, and this test is the pairing', () => {
    expect(consumesOf('claude-code')).not.toContain('conversation');
    expect(dependenciesOf('claude-code').needs).toEqual(['ferrets']);
  });
});
