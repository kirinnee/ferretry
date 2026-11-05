import { describe, expect, it } from 'bun:test';
import type { RuntimeModelChoice } from '@ferretry/protocol';
import {
  codexStartupEffortRefusal,
  planStartupEffort,
  startupEffort,
  startupModelArguments,
} from '../../../../src/lib/session/harness/startup.ts';
import { launchReasoningEffort } from '../../../../src/lib/session/harness/launch-effort.ts';
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

  it('lowercases the level, as a relaunch does, so both spell it the way the catalog does', () => {
    expect(startupEffort('codex', ' High ')).toEqual({ kind: 'argv', effort: 'high' });
    expect(startupEffort('claude', 'XHigh')).toEqual({ kind: 'command', effort: 'xhigh' });
  });

  it('normalises exactly as the document records it, so a level the launch rejects is carried as none (and refused by the plan)', () => {
    for (const level of ['x_high', '9', 'a'.repeat(30), 'two words']) {
      expect(startupEffort('codex', level)).toBeUndefined();
      expect(startupEffort('claude', level)).toBeUndefined();
      expect(launchReasoningEffort(level, undefined)).toBeUndefined();
    }
    for (const level of [' High ', 'xhigh', 'x-high']) {
      expect(startupEffort('codex', level)?.effort).toBe(launchReasoningEffort(level, undefined));
    }
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
      'the Codex model catalog could not be read, so reasoning level high cannot be checked for gpt-6.1-sol; retry, or start without --effort',
    );
  });

  it('says why the catalog could not be read when the probe gave its error', () => {
    expect(codexStartupEffortRefusal('gpt-6.1-sol', 'high', new Error('app-server timed out after 10s'))).toBe(
      'the Codex model catalog could not be read (app-server timed out after 10s), so reasoning level high cannot be checked for gpt-6.1-sol; retry, or start without --effort',
    );
  });
});

describe('the plan for a start’s reasoning level', () => {
  const catalog: readonly RuntimeModelChoice[] = [
    {
      value: 'gpt-6.1-sol',
      label: 'GPT-6.1-Sol',
      reasoningEfforts: [{ value: 'medium' }, { value: 'high' }],
      defaultReasoningEffort: 'medium',
    },
  ];

  it('puts a checked Codex level on the argv and types no runtime command', () => {
    expect(planStartupEffort('codex', 'gpt-6.1-sol', ' High ', catalog)).toEqual({
      kind: 'planned',
      argvEffort: 'high',
    });
  });

  it('turns a Claude level into the effort command and puts nothing on the argv, whatever the catalog', () => {
    expect(planStartupEffort('claude', 'claude-opus-5-5', 'xhigh', undefined)).toEqual({
      kind: 'planned',
      startupRuntime: { action: 'effort', effort: 'xhigh' },
    });
  });

  it('refuses a non-blank level that is not a reasoning level, instead of starting without it', () => {
    for (const level of ['x_high', '9', 'two words']) {
      for (const harness of ['codex', 'claude'] as const) {
        expect(planStartupEffort(harness, 'm', level, undefined)).toEqual({
          kind: 'refused',
          cause: 'invalid',
          reason: `${level} is not a reasoning level`,
        });
      }
    }
  });

  it('plans nothing when no level was asked for, and does not need the catalog', () => {
    expect(planStartupEffort('codex', 'gpt-6.1-sol', undefined, undefined)).toEqual({ kind: 'planned' });
    expect(planStartupEffort('claude', 'claude-opus-5-5', '  ', undefined)).toEqual({ kind: 'planned' });
  });

  it('refuses with the probe’s own error and a remedy when the catalog could not be read', () => {
    expect(planStartupEffort('codex', 'gpt-6.1-sol', 'high', new Error('spawn codex ENOENT'))).toEqual({
      kind: 'refused',
      cause: 'catalog_unreadable',
      reason:
        'the Codex model catalog could not be read (spawn codex ENOENT), so reasoning level high cannot be checked for gpt-6.1-sol; retry, or start without --effort',
    });
  });

  it('tells a catalog that was never read (a retry may work) from one that was read and does not list it', () => {
    expect(planStartupEffort('codex', 'gpt-6.1-sol', 'high', undefined)).toMatchObject({
      kind: 'refused',
      cause: 'catalog_unreadable',
    });
    expect(planStartupEffort('codex', 'gpt-6.1-sol', 'xhigh', catalog)).toMatchObject({
      kind: 'refused',
      cause: 'unservable',
    });
  });

  it('refuses a model the login does not list', () => {
    expect(planStartupEffort('codex', 'gpt-gone', 'high', catalog)).toEqual({
      kind: 'refused',
      cause: 'unservable',
      reason: "model gpt-gone is not in this Codex login's current catalog",
    });
  });

  it('refuses a level the model does not advertise', () => {
    expect(planStartupEffort('codex', 'gpt-6.1-sol', 'xhigh', catalog)).toEqual({
      kind: 'refused',
      cause: 'unservable',
      reason: 'xhigh is not advertised for Codex model gpt-6.1-sol',
    });
  });
});
