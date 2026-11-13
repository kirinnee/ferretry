import { describe, expect, test } from 'bun:test';
import { CONVERSATION_ABOVE_COMPOSER_SLOT } from '../../../../conversation/contract/slots.ts';
import app from '../../../app/index.ts';
import manifest from '../../../manifest.ts';

const half = app.build?.({ manifest, client: {} as never });

/** Today's Settings › Agent CLIs entry for Claude Code is this plugin's one Settings tab. */
describe('app parity', () => {
  test('S-0413 the machine tools panel for the agent CLI is the Claude Code settings tab', () => {
    expect(manifest.ui?.settings?.map(tab => [tab.id, tab.label])).toEqual([['claude-code', 'Claude Code']]);
    expect(typeof half?.settings['claude-code']).toBe('function');
  });

  test('S-0440 the settings navigation entry for the agent CLIs is the tab in the manifest', () => {
    expect(manifest.ui?.settings?.some(tab => tab.id === 'claude-code')).toBe(true);
  });

  test('S-0441 the settings catalog link resolves to a tab this app half draws', () => {
    expect(Object.keys(half?.settings ?? {})).toEqual(['claude-code']);
  });

  test('G31 G32 the two answer cards draw above the composer, in this order', () => {
    const above = (ids: readonly string[] | undefined) => ids?.filter(id => id !== 'onboarding-step');
    expect(above(manifest.ui?.panels?.map(panel => panel.id))).toEqual(['permission-request', 'harness-dialog']);
    expect(above(Object.keys(half?.panels ?? {}))).toEqual(['permission-request', 'harness-dialog']);
  });

  test('G31 G32 both cards are contributed to the slot Conversation offers above its composer', () => {
    const slots = (manifest.ui?.panels ?? [])
      .filter(panel => panel.id !== 'onboarding-step')
      .map(panel => [panel.id, panel.slot]);
    expect(slots).toEqual([
      ['permission-request', CONVERSATION_ABOVE_COMPOSER_SLOT],
      ['harness-dialog', CONVERSATION_ABOVE_COMPOSER_SLOT],
    ]);
  });

  test('S14 the first-run step panel is contributed to the onboarding.step slot, beside the two cards', () => {
    expect(manifest.ui?.panels?.find(panel => panel.id === 'onboarding-step')?.slot).toBe('onboarding.step');
    expect(Object.keys(half?.panels ?? {})).toContain('onboarding-step');
  });
});
