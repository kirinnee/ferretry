import { describe, expect, test } from 'bun:test';
import { isSlotName } from '@ferretry/app';
import { consumesOf, dependenciesOf, panelsInSlot } from '@ferretry/app/testing';
import { CLAUDE_CODE_SIGN_IN_SLOT } from '../../../contract/index.ts';

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

describe('the Claude segment of the first run (r10 O7)', () => {
  test('declares its steps in order, with the retired `harness` step gone', async () => {
    const { default: manifest } = await import('../../../manifest.ts');
    const steps = manifest.onboarding ?? [];
    expect(steps.map(step => step.id)).toEqual([
      'installed',
      'sign-in',
      'import-choice',
      'import-settings',
      'import-model-set',
      'import-instructions',
      'import-skills',
      'import-mcp',
      'conversations',
      'import-run',
      'permission',
    ]);
    expect(steps.map(step => step.order)).toEqual([...steps.map(step => step.order)].sort((a, b) => a - b));
  });

  test('puts one page in the onboarding step slot for each page this unit owns', () => {
    expect(panelsInSlot('onboarding.step').filter(panel => panel.startsWith('claude-code.'))).toEqual([
      'claude-code.onboarding-installed',
      'claude-code.onboarding-sign-in',
      'claude-code.onboarding-import-choice',
      'claude-code.onboarding-permission',
    ]);
  });

  test('offers the sign-in slot by the literal Logins writes, and Logins fills it', () => {
    expect(CLAUDE_CODE_SIGN_IN_SLOT).toBe('claude-code.sign-in');
    expect(isSlotName(CLAUDE_CODE_SIGN_IN_SLOT)).toBe(true);
    expect(panelsInSlot(CLAUDE_CODE_SIGN_IN_SLOT)).toEqual(['logins.claude-code-sign-in']);
    expect(consumesOf('claude-code')).not.toContain('logins');
  });
});
