import { describe, expect, it } from 'bun:test';
import type { FleetToolInstallOutcome } from '@ferretry/protocol';
import {
  type InstallPhase,
  installedSentence,
  installingSentence,
  installLabel,
  type MissingTool,
  phaseAfter,
  runnableTools,
  toolCommand,
} from '../../../../../src/features/fleet/setup/install-model.ts';

const runnable = (harness: 'claude' | 'codex', command: string): MissingTool => ({
  harness,
  label: harness === 'claude' ? 'Claude Code' : 'Codex',
  installed: false,
  install: { kind: 'runnable', command },
});

const blocked = (harness: 'claude' | 'codex', manualCommand: string): MissingTool => ({
  harness,
  label: harness === 'claude' ? 'Claude Code' : 'Codex',
  installed: false,
  install: { kind: 'no-package-manager', reason: 'No package manager was found on studio-mac.', manualCommand },
});

const CLAUDE_COMMAND = 'npm install -g @anthropic-ai/claude-code';
const CODEX_MANUAL = 'npm install -g @openai/codex';

describe('runnableTools', () => {
  it('keeps only the tools the machine can install itself', () => {
    const tools = [runnable('claude', CLAUDE_COMMAND), blocked('codex', CODEX_MANUAL)];
    expect(runnableTools(tools)).toEqual([runnable('claude', CLAUDE_COMMAND)]);
  });

  it('returns nothing when no tool can be installed from here', () => {
    expect(runnableTools([blocked('claude', CLAUDE_COMMAND), blocked('codex', CODEX_MANUAL)])).toEqual([]);
  });

  it('returns nothing for an empty list', () => {
    expect(runnableTools([])).toEqual([]);
  });
});

describe('toolCommand', () => {
  it('shows the command a runnable tool would run', () => {
    expect(toolCommand(runnable('claude', CLAUDE_COMMAND))).toBe(CLAUDE_COMMAND);
  });

  it('shows the manual command for a tool with no package manager', () => {
    expect(toolCommand(blocked('codex', CODEX_MANUAL))).toBe(CODEX_MANUAL);
  });
});

describe('installLabel', () => {
  it('nudges the person to pick when nothing is picked', () => {
    expect(installLabel(0)).toBe('Pick a tool to install');
  });

  it('names a single tool in the singular', () => {
    expect(installLabel(1)).toBe('Install 1 tool');
  });

  it('names several tools in the plural', () => {
    expect(installLabel(2)).toBe('Install 2 tools');
  });
});

describe('installingSentence', () => {
  it('names the harnesses and the machine while the install runs', () => {
    expect(installingSentence(['claude', 'codex'], 'studio-mac')).toBe(
      'Installing Claude Code and Codex on studio-mac…',
    );
  });

  it('names a single harness without a conjunction', () => {
    expect(installingSentence(['codex'], 'studio-mac')).toBe('Installing Codex on studio-mac…');
  });
});

describe('phaseAfter', () => {
  it('is done with every harness when each install succeeded', () => {
    const outcomes: FleetToolInstallOutcome[] = [
      { harness: 'claude', outcome: 'installed', command: CLAUDE_COMMAND },
      { harness: 'codex', outcome: 'installed', command: CODEX_MANUAL },
    ];
    const phase = phaseAfter(['claude', 'codex'], outcomes);
    expect(phase).toEqual({ kind: 'done', installed: ['claude', 'codex'] });
  });

  it('leaves out a tool that was already installed, since nothing new was installed', () => {
    const outcomes: FleetToolInstallOutcome[] = [{ harness: 'claude', outcome: 'already-installed' }];
    expect(phaseAfter(['claude'], outcomes)).toEqual({ kind: 'done', installed: [] });
  });

  it('names only the tools this request installed when others were already there', () => {
    const outcomes: FleetToolInstallOutcome[] = [
      { harness: 'claude', outcome: 'already-installed' },
      { harness: 'codex', outcome: 'installed', command: CODEX_MANUAL },
    ];
    expect(phaseAfter(['claude', 'codex'], outcomes)).toEqual({ kind: 'done', installed: ['codex'] });
  });

  it('is done with nothing installed when there were no outcomes', () => {
    expect(phaseAfter(['claude'], [])).toEqual({ kind: 'done', installed: [] });
  });

  it('is failed with the failures and the requested harnesses when an install failed', () => {
    const outcomes: FleetToolInstallOutcome[] = [
      { harness: 'claude', outcome: 'installed', command: CLAUDE_COMMAND },
      {
        harness: 'codex',
        outcome: 'failed',
        cause: 'no-package-manager',
        reason: 'No package manager was found on studio-mac.',
        manualCommand: CODEX_MANUAL,
      },
    ];
    expect(phaseAfter(['claude', 'codex'], outcomes)).toEqual({
      kind: 'failed',
      harnesses: ['claude', 'codex'],
      failures: [
        {
          harness: 'codex',
          reason: 'No package manager was found on studio-mac.',
          manualCommand: CODEX_MANUAL,
        },
      ],
    });
  });

  it('lists every failure when more than one install failed', () => {
    const outcomes: FleetToolInstallOutcome[] = [
      {
        harness: 'claude',
        outcome: 'failed',
        cause: 'needs-admin',
        reason: 'Needs an administrator password.',
        manualCommand: CLAUDE_COMMAND,
      },
      {
        harness: 'codex',
        outcome: 'failed',
        cause: 'timed-out',
        reason: 'The install took too long.',
        manualCommand: CODEX_MANUAL,
      },
    ];
    const phase = phaseAfter(['claude', 'codex'], outcomes);
    expect(phase.kind).toBe('failed');
    if (phase.kind !== 'failed') throw new Error('expected a failed phase');
    expect(phase.failures.map(failure => failure.harness)).toEqual(['claude', 'codex']);
    expect(phase.failures.map(failure => failure.manualCommand)).toEqual([CLAUDE_COMMAND, CODEX_MANUAL]);
  });

  it('shows the failure as failed even when another tool succeeded', () => {
    const outcomes: FleetToolInstallOutcome[] = [
      { harness: 'claude', outcome: 'already-installed' },
      {
        harness: 'codex',
        outcome: 'failed',
        cause: 'could-not-start',
        reason: 'The installer would not start.',
        manualCommand: CODEX_MANUAL,
      },
    ];
    const phase: InstallPhase = phaseAfter(['claude', 'codex'], outcomes);
    expect(phase.kind).toBe('failed');
  });
});

describe('installedSentence', () => {
  it('says nothing needed installing when no harness was installed', () => {
    expect(installedSentence([])).toBe('Nothing needed installing.');
  });

  it('names one installed harness', () => {
    expect(installedSentence(['claude'])).toBe('Installed Claude Code.');
  });

  it('names several installed harnesses as a sentence', () => {
    expect(installedSentence(['claude', 'codex'])).toBe('Installed Claude Code and Codex.');
  });
});
