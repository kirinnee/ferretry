import { describe, expect, it } from 'bun:test';
import { startupModelArguments } from '../../../../src/lib/session/harness/startup.ts';

describe('startupModelArguments', () => {
  it('renders a validated model id as the stable startup argv pair', () => {
    const model = 'claude-opus-4-8';

    expect(startupModelArguments(model)).toEqual(['--model', model]);
  });
});
