import { describe, expect, it } from 'bun:test';
import type { RuntimeModelChoice } from '@ferretry/protocol';
import {
  codexStartupEffortRefusal,
  startupEffort,
  startupModelArguments,
} from '../../../../src/lib/session/harness/startup.ts';
import { buildLaunchArgv } from '../../../../src/lib/session/launch/argv.ts';

describe('startupModelArguments', () => {
  it('renders a validated model id as the stable startup argv pair', () => {
    const model = 'claude-opus-4-8';

    expect(startupModelArguments(model)).toEqual(['--model', model]);
  });
});

describe('how a start carries its reasoning level', () => {
  it('puts a Codex level on the launch argv, so nothing is typed into a Codex that is still starting', () => {
    // Arrange
    const effort = startupEffort('codex', 'high');

    // Act — the argv the start builds from that answer.
    const argv = buildLaunchArgv({
      harness: 'codex',
      executable: '/fleet/bin/codex-work',
      remoteControl: [],
      transcript: [],
      readableFolders: [],
      model: 'gpt-6.1-sol',
      ...(effort?.kind === 'argv' ? { effort: effort.effort } : {}),
      harnessFlags: [],
    });

    // Assert
    expect(effort).toEqual({ kind: 'argv', effort: 'high' });
    expect(argv).toEqual(['/fleet/bin/codex-work', '--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="high"']);
  });

  it('keeps a Claude level as the command it answers locally before turn one', () => {
    expect(startupEffort('claude', 'xhigh')).toEqual({ kind: 'command', effort: 'xhigh' });
  });

  it('carries nothing when no level, or only a blank one, was asked for', () => {
    expect(startupEffort('codex', undefined)).toBeUndefined();
    expect(startupEffort('codex', '  ')).toBeUndefined();
    expect(startupEffort('claude', '')).toBeUndefined();
  });

  it('trims the level it carries', () => {
    expect(startupEffort('codex', ' high ')).toEqual({ kind: 'argv', effort: 'high' });
  });
});

describe('which Codex levels a start may launch at', () => {
  const catalog: readonly RuntimeModelChoice[] = [
    {
      value: 'gpt-6.1-sol',
      label: 'GPT-6.1-Sol',
      reasoningEfforts: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      defaultReasoningEffort: 'low',
    },
    { value: 'gpt-fixed', label: 'Fixed', reasoningEfforts: [] },
  ];

  it('lets through a level the login advertises for the model', () => {
    expect(codexStartupEffortRefusal('gpt-6.1-sol', 'high', catalog)).toBeUndefined();
  });

  it('refuses a level the model does not take, before a pane exists to fail in', () => {
    expect(codexStartupEffortRefusal('gpt-6.1-sol', 'ultra', catalog)).toBe(
      'ultra is not advertised for Codex model gpt-6.1-sol',
    );
    expect(codexStartupEffortRefusal('gpt-fixed', 'high', catalog)).toBe(
      'high is not advertised for Codex model gpt-fixed',
    );
  });

  it('refuses a model the login does not list', () => {
    expect(codexStartupEffortRefusal('gpt-gone', 'high', catalog)).toBe(
      "model gpt-gone is not in this Codex login's current catalog",
    );
  });

  it('refuses when the catalog could not be read, because nothing then says the level is real', () => {
    expect(codexStartupEffortRefusal('gpt-6.1-sol', 'high', undefined)).toBe(
      'the Codex model catalog could not be read, so reasoning level high cannot be checked for gpt-6.1-sol',
    );
  });
});
