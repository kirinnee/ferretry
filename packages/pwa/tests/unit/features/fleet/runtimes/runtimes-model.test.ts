import { describe, expect, it } from 'bun:test';
import type { FleetRuntimeView } from '@ferretry/protocol';
import {
  harnessInstalled,
  KIND_NAMES,
  launchLabel,
  layerRows,
  modelRows,
  modelSetNote,
  profileFit,
  profilesFitFirst,
  profileSummary,
  runtimeDefaultModel,
  runtimeNameProblem,
  runtimeProfileLine,
  sameLoginAndProfile,
  slug,
  suggestedRuntimeName,
  uniqueName,
} from '../../../../../src/features/fleet/runtimes/runtimes-model.ts';
import { COMPONENTS, machine, PROFILES, profile, RUNTIMES, runtime } from '../account-support.ts';

const named = (...names: string[]): FleetRuntimeView[] => names.map(name => runtime({ name }));

const profileNamed = (name: string) => {
  const found = PROFILES.profiles.find(candidate => candidate.name === name);
  if (found === undefined) throw new Error(name);
  return found;
};

const runtimeNamed = (name: string) => {
  const found = RUNTIMES.runtimes.find(candidate => candidate.name === name);
  if (found === undefined) throw new Error(name);
  return found;
};

const modelSetOf = (overrides: Record<string, unknown>): FleetRuntimeView =>
  runtime({
    name: 'r',
    modelSet: {
      source: 'model-set',
      name: 'Claude models',
      models: [
        { id: 'Opus 5.5', available: false },
        { id: 'Sonnet 5.5', available: true },
      ],
      declaredDefault: 'Opus 5.5',
      default: 'Sonnet 5.5',
      ...overrides,
    } as FleetRuntimeView['modelSet'],
  });

describe('names', () => {
  it('picks the first free name', () => {
    expect(uniqueName('claude', new Set())).toBe('claude');
    expect(uniqueName('claude', new Set(['claude']))).toBe('claude-2');
    expect(uniqueName('claude', new Set(['claude', 'claude-2', 'claude-3']))).toBe('claude-4');
  });

  it('slugs to lower-case letters, digits and single dashes', () => {
    expect(slug('Agent work')).toBe('agent-work');
    expect(slug('  --Hello,   World!-- ')).toBe('hello-world');
    expect(slug('!!!')).toBe('');
  });

  it('prefills harness plus profile, made unique', () => {
    expect(suggestedRuntimeName('claude', 'Default', [])).toBe('claude-default');
    expect(suggestedRuntimeName('claude', 'Default', named('claude-default'))).toBe('claude-default-2');
    expect(suggestedRuntimeName('codex', 'Agent work', [])).toBe('codex-agent-work');
    expect(suggestedRuntimeName('codex', '???', [])).toBe('codex-runtime');
  });

  it('asks for a name, and says why one cannot be used', () => {
    const taken = named('claude-default', 'my-name');
    expect(runtimeNameProblem('', taken, 'studio-mac')).toEqual({ message: 'Give the runtime a name.' });
    expect(runtimeNameProblem('my name', taken, 'studio-mac')).toEqual({
      message: 'Use only letters, digits and dashes.',
      suggestion: 'my-name-2',
    });
    expect(runtimeNameProblem('!!!', taken, 'studio-mac')).toEqual({
      message: 'Use only letters, digits and dashes.',
      suggestion: 'runtime',
    });
    expect(runtimeNameProblem('claude-default', taken, 'studio-mac')).toEqual({
      message: 'claude-default is already a runtime on studio-mac.',
      suggestion: 'claude-default-2',
    });
    expect(runtimeNameProblem('Fresh-1', taken, 'studio-mac')).toBeNull();
  });
});

describe('sameLoginAndProfile', () => {
  it('finds the runtime that already uses this login and profile', () => {
    expect(sameLoginAndProfile(RUNTIMES.runtimes, 'claude-personal', 'Review')?.name).toBe('claude-review');
    expect(sameLoginAndProfile(RUNTIMES.runtimes, 'claude-personal', 'Nope')).toBeUndefined();
    expect(sameLoginAndProfile(RUNTIMES.runtimes, 'nobody', 'Default')).toBeUndefined();
  });
});

describe('profileFit', () => {
  it('P7: refuses a profile for the other tool, and a mixed one in its own sentence', () => {
    expect(profileFit(profile({ name: 'C', scope: { kind: 'scoped', scope: 'codex' } }), 'claude')).toEqual({
      fits: false,
      reason: 'Codex only — this login is Claude Code',
    });
    expect(profileFit(profile({ name: 'C', scope: { kind: 'scoped', scope: 'codex' } }), 'codex')).toEqual({
      fits: true,
      notes: [],
    });
    expect(profileFit(profile({ name: 'M', scope: { kind: 'mixed', sentence: 'Profile M mixes.' } }), 'codex')).toEqual(
      {
        fits: false,
        reason: 'Profile M mixes.',
      },
    );
  });

  it('fits freely when the profile says nothing about the harness', () => {
    expect(profileFit(profile({ name: 'Bare', harnesses: [] }), 'codex')).toEqual({ fits: true, notes: [] });
  });

  it('refuses a profile with nothing for this harness, in the daemon’s words', () => {
    expect(profileFit(profileNamed('Claude hooks'), 'codex')).toEqual({
      fits: false,
      reason: 'Only Claude settings. Nothing here applies on Codex.',
    });
  });

  it('fits cleanly with no notes', () => {
    expect(profileFit(profileNamed('Default'), 'claude')).toEqual({ fits: true, notes: [] });
  });

  it('notes what is skipped and what is only partly supported', () => {
    expect(profileFit(profileNamed('Default'), 'codex')).toEqual({
      fits: true,
      notes: ['Claude settings will be skipped on Codex', 'Partly supported on Codex'],
    });
  });

  it('names Codex settings when Claude is the one skipping', () => {
    const skipping = profile({
      name: 'Odd',
      harnesses: [
        {
          harness: 'claude',
          available: { available: true },
          applied: [],
          skipped: [{ reference: 'settings/Codex settings', sentence: 'Skipped.' }],
          conflicts: [],
          partial: [],
        },
      ],
    });
    expect(profileFit(skipping, 'claude')).toEqual({
      fits: true,
      notes: ['Codex settings will be skipped on Claude Code'],
    });
  });
});

describe('profileSummary', () => {
  it('counts the parts for the named harness; the scope is the badge beside it', () => {
    expect(profileSummary(profileNamed('Default'), 'codex')).toBe('3 parts');
    expect(profileSummary(profileNamed('Default'), 'claude')).toBe('2 parts');
  });

  it('falls back to the first stack with no harness, or one the profile lacks', () => {
    expect(profileSummary(profileNamed('Review'))).toBe('2 parts');
    expect(profileSummary(profileNamed('Review'), undefined)).toBe('2 parts');
  });

  it('says no parts when the profile has no stack at all', () => {
    expect(profileSummary(profile({ name: 'Bare', layers: ['profile/Default'], harnesses: [] }), 'claude')).toBe(
      '0 parts',
    );
  });
});

describe('profilesFitFirst', () => {
  it('puts what this login can use first, each group in the catalogue order', () => {
    const codexOnly = profile({ name: 'Codex', scope: { kind: 'scoped', scope: 'codex' } });
    const generic = profile({ name: 'Shared' });
    const claudeOnly = profile({ name: 'Claude', scope: { kind: 'scoped', scope: 'claude' } });
    expect(profilesFitFirst([codexOnly, generic, claudeOnly], 'claude').map(entry => entry.profile.name)).toEqual([
      'Shared',
      'Claude',
      'Codex',
    ]);
  });
});

describe('harnessInstalled', () => {
  it('assumes yes until the machine has answered', () => {
    expect(harnessInstalled(null, 'codex')).toBe(true);
  });

  it('reads the machine’s tools', () => {
    expect(harnessInstalled(machine(), 'codex')).toBe(true);
    expect(
      harnessInstalled(
        machine({ tools: [{ harness: 'claude', label: 'Claude Code', installed: true, command: 'claude' }] }),
        'codex',
      ),
    ).toBe(false);
    expect(
      harnessInstalled(
        machine({ tools: [{ harness: 'codex', label: 'Codex', installed: false, command: 'codex' }] }),
        'codex',
      ),
    ).toBe(false);
  });
});

describe('launchLabel', () => {
  it('waits for an offline machine before anything else', () => {
    const blocked = runtime({ name: 'claude-default', launch: { available: false, reason: 'Sign in first.' } });
    expect(launchLabel(blocked, 'studio-mac', false)).toBe('Waiting for studio-mac');
    expect(launchLabel(runtimeNamed('claude-default'), 'studio-mac', false)).toBe('Waiting for studio-mac');
  });

  it('says Launch with the name, or why it cannot', () => {
    expect(launchLabel(runtimeNamed('claude-default'), 'studio-mac', true)).toBe('Launch claude-default');
    expect(
      launchLabel(
        runtime({ name: 'claude-default', launch: { available: false, reason: 'Sign in first.' } }),
        'studio-mac',
        true,
      ),
    ).toBe('Sign in first.');
  });
});

describe('models', () => {
  it('names the default model, or says what is missing', () => {
    expect(runtimeDefaultModel(runtimeNamed('claude-default'))).toBe('Sonnet 5.5');
    expect(runtimeDefaultModel(runtimeNamed('claude-review'))).toBe('Harness default');
    expect(runtimeDefaultModel(modelSetOf({ default: undefined }))).toBe('No model available');
  });

  it('lists the rows with what this login cannot use, and the default marked', () => {
    expect(modelRows(runtimeNamed('codex-default'))).toEqual([
      { id: 'GPT-6', available: true, isDefault: true },
      { id: 'Opus 5.5', available: false, isDefault: false },
    ]);
    expect(modelRows(runtimeNamed('claude-review'))).toEqual([]);
  });

  it('explains a harness that picks its own model', () => {
    expect(modelSetNote(runtimeNamed('claude-review'))).toBe(
      'No model set in this profile. The harness picks its own default.',
    );
  });

  it('says where the set came from when nothing is unusual', () => {
    expect(modelSetNote(runtimeNamed('claude-default'))).toBe('From Claude models in the Default profile.');
  });

  it('appends the daemon’s note when it has one', () => {
    expect(modelSetNote(modelSetOf({ note: 'Opus is on the Max plan.' }))).toBe(
      'From Claude models in the Default profile. Opus is on the Max plan.',
    );
  });

  it('says so when none of the models can be used', () => {
    expect(modelSetNote(modelSetOf({ default: undefined }))).toBe(
      "From Claude models in the Default profile. None of its models are available on this login, so this runtime can't pick one.",
    );
  });

  it('says where the default moved to when the declared one is out', () => {
    expect(modelSetNote(runtimeNamed('codex-default'))).toBe(
      "From Claude models in the Default profile. Its default, Opus 5.5, isn't available on this login, so this runtime starts on GPT-6, the first one that is.",
    );
  });
});

describe('layerRows', () => {
  it('lists layers newest first, with the notes a reader needs and the ones this harness skips', () => {
    expect(layerRows(profileNamed('Default'), COMPONENTS, 'codex')).toEqual([
      { reference: 'modelSets/Claude models', title: 'Model set · Claude models', notes: [], skipped: false },
      {
        reference: 'settings/Claude settings',
        title: 'Settings · Claude settings',
        notes: ['Claude Code only'],
        skipped: true,
      },
      {
        reference: 'skills/My skills',
        title: 'Skills · My skills',
        notes: ['Partly supported on Codex'],
        skipped: false,
      },
      {
        reference: 'instructions/Main instructions',
        title: 'Instructions · Main instructions',
        notes: [],
        skipped: false,
      },
    ]);
  });

  it('carries a part’s own warnings after its notes', () => {
    expect(layerRows(profileNamed('Claude hooks'), COMPONENTS, 'claude')).toEqual([
      {
        reference: 'hooks/Format on save',
        title: 'Hooks · Format on save',
        notes: ['Claude Code only', 'Command not found: fmt-hook'],
        skipped: false,
      },
    ]);
  });

  it('shows a profile used as a base', () => {
    expect(layerRows(profileNamed('Agent work'), COMPONENTS, 'claude').map(row => row.title)).toEqual([
      'Settings · Agent settings',
      'Profile · Default',
    ]);
    expect(layerRows(profileNamed('Review'), COMPONENTS, 'claude')).toEqual([
      { reference: 'profile/Default', title: 'Profile · Default', notes: ['Used as a base'], skipped: false },
    ]);
  });

  it('copes with no catalog, an unknown part, an unknown kind and a harness the profile lacks', () => {
    const odd = profile({
      name: 'Odd',
      layers: ['skills/Gone', 'mystery/Thing'],
      harnesses: [],
    });
    expect(layerRows(odd, null, 'claude')).toEqual([
      { reference: 'mystery/Thing', title: 'mystery · Thing', notes: [], skipped: false },
      { reference: 'skills/Gone', title: 'Skills · Gone', notes: [], skipped: false },
    ]);
    expect(layerRows(odd, COMPONENTS, 'codex').map(row => row.notes)).toEqual([[], []]);
  });

  it('never says "component" in a kind name', () => {
    expect(Object.values(KIND_NAMES).join(' ')).not.toMatch(/component/iu);
    expect(KIND_NAMES).toEqual({
      instructions: 'Instructions',
      mcp: 'MCP server',
      skills: 'Skills',
      settings: 'Settings',
      hooks: 'Hooks',
      modelSets: 'Model set',
    });
  });
});

describe('runtimeProfileLine', () => {
  it('counts layers, parts and what the harness skipped', () => {
    expect(runtimeProfileLine(runtimeNamed('codex-default'), profileNamed('Default'))).toBe(
      '4 layers · 3 parts · 1 skipped on Codex',
    );
  });

  it('leaves out skipped when none were and layers when the profile is gone', () => {
    expect(runtimeProfileLine(runtimeNamed('claude-default'), profileNamed('Review'))).toBe('1 layer · 2 parts');
    expect(runtimeProfileLine(runtimeNamed('claude-default'), undefined)).toBe('2 parts');
  });
});
