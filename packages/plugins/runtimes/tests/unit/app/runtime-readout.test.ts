import { describe, expect, it } from 'bun:test';
import { type RuntimeSessionView, runtimeReadout } from '../../../app/lib/session-view.ts';

const view = (
  config: Partial<RuntimeSessionView['config']> = {},
  state: Partial<RuntimeSessionView['state']> = {},
): RuntimeSessionView => ({
  config: { id: 'zoe', harness: 'claude-code', ...config },
  state: { status: 'idle', ...state },
});

describe('the composer status line reads the runtime as model · thinking · speed', () => {
  it('says all three when the ferret has them, the harness’s own report first', () => {
    expect(
      runtimeReadout(
        view(
          { model: 'claude-sonnet-5-5', launchReasoningEffort: 'low', launchFast: false },
          { observedModel: 'claude-opus-5-5', observedReasoningEffort: 'high', observedFast: true },
        ),
      ),
    ).toBe('claude-opus-5-5 · high · fast');
  });

  it('falls back to what the ferret was launched with, and leaves out what it has not got', () => {
    expect(runtimeReadout(view({ model: 'claude-sonnet-5-5', launchReasoningEffort: 'medium' }))).toBe(
      'claude-sonnet-5-5 · medium',
    );
    expect(runtimeReadout(view({ model: 'claude-sonnet-5-5', launchFast: true }))).toBe('claude-sonnet-5-5 · fast');
    expect(runtimeReadout(view({ model: 'claude-sonnet-5-5' }, { observedFast: false }))).toBe('claude-sonnet-5-5');
  });

  it('is a plain word, never blank or `undefined`, when nothing is known', () => {
    expect(runtimeReadout(view())).toBe('Default model');
    expect(runtimeReadout(view({}, { observedModel: '  ', observedReasoningEffort: ' ' }))).toBe('Default model');
  });
});
