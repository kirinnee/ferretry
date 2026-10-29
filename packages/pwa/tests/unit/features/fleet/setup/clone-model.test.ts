import { describe, expect, it } from 'bun:test';
import {
  CLONE_FLOW_KIND,
  CLONE_NO_DEFAULT,
  cloneDefaultView,
  cloneOriginName,
  clonePreview,
  cloneSharesSentence,
  cloneSlots,
  cloneSourceState,
  cloneSteps,
  copiesRows,
  documentSize,
  existingSentence,
  runnableTitle,
} from '../../../../../src/features/fleet/setup/clone-model.ts';
import type { MachineReach } from '../../../../../src/features/fleet/shell/machine-reach.ts';
import { bundle, credentialView, FRESH_MACHINE, machineView } from './setup-support.ts';

describe('cloneSteps', () => {
  it('has Source, Preview and Done when the target has nothing to keep', () => {
    expect(cloneSteps(false).map(step => step.id)).toEqual(['source', 'preview', 'done']);
  });

  it('inserts Existing setup before Done when the target already has a setup', () => {
    const steps = cloneSteps(true);
    expect(steps.map(step => step.id)).toEqual(['source', 'preview', 'existing', 'done']);
    expect(steps.map(step => step.label)).toEqual(['Source', 'Preview', 'Existing setup', 'Done']);
  });

  it('marks only Done as final', () => {
    expect(
      cloneSteps(true)
        .filter(step => step.final === true)
        .map(step => step.id),
    ).toEqual(['done']);
  });

  it('names its flow kind', () => {
    expect(CLONE_FLOW_KIND).toBe('clone');
  });
});

describe('cloneSourceState', () => {
  it('is checking while the machine has not answered', () => {
    expect(cloneSourceState(undefined, 'work-linux')).toEqual({ kind: 'checking' });
    expect(cloneSourceState({ kind: 'checking' }, 'work-linux')).toEqual({ kind: 'checking' });
  });

  it('is disabled with the wake sentence when the machine is offline (E27)', () => {
    expect(cloneSourceState({ kind: 'offline' }, 'work-linux')).toEqual({
      kind: 'disabled',
      reason: 'work-linux is asleep or offline. Wake it to copy from it.',
    });
  });

  it('is disabled with the machine own reason when its setup is unreadable', () => {
    const reach: MachineReach = { kind: 'unreadable', reason: 'This machine runs an older Ferretry.' };
    expect(cloneSourceState(reach, 'work-linux')).toEqual({
      kind: 'disabled',
      reason: 'This machine runs an older Ferretry.',
    });
  });

  it('is disabled when the machine is not set up', () => {
    const reach: MachineReach = { kind: 'online', machine: FRESH_MACHINE };
    expect(cloneSourceState(reach, 'work-linux')).toEqual({
      kind: 'disabled',
      reason: 'Not set up yet. Nothing to copy.',
    });
  });

  it('is ready with the runtime count when the machine is set up', () => {
    const reach: MachineReach = { kind: 'online', machine: machineView({ runtimeCount: 3 }) };
    expect(cloneSourceState(reach, 'work-linux')).toEqual({ kind: 'ready', runtimeCount: 3 });
  });
});

describe('clonePreview', () => {
  it('counts components without model sets, then model sets, profiles, runtimes and logins', () => {
    const preview = clonePreview(bundle(), machineView());
    expect(preview.components).toBe(2);
    expect(preview.modelSets).toBe(1);
    expect(preview.profiles).toBe(1);
    expect(preview.runtimes).toBe(3);
    expect(preview.logins).toBe(2);
    expect(preview.notCopied).toEqual([]);
  });

  it('flags a home path found in the own JSON of a component (E30)', () => {
    const preview = clonePreview(bundle(), machineView());
    expect(preview.checkPaths).toContainEqual({ title: 'MCP server · notes', path: '/home/me/bin/notes-server' });
  });

  it('flags a home path found in the file a component names (E30)', () => {
    const preview = clonePreview(bundle(), machineView());
    expect(preview.checkPaths).toContainEqual({ title: 'Instructions · default', path: '/Users/me/notes.md' });
  });

  it('flags nothing when no component mentions a home folder', () => {
    const preview = clonePreview(
      bundle({
        components: { skills: { review: { note: 'plain' } }, hooks: { stop: { file: 'components/hooks/missing.sh' } } },
        files: [],
      }),
      machineView(),
    );
    expect(preview.checkPaths).toEqual([]);
  });

  it('titles a component of an unknown kind by the kind itself', () => {
    const preview = clonePreview(
      bundle({ components: { widgets: { gizmo: { path: '/Users/me/gizmo' } } }, files: [] }),
      machineView(),
    );
    expect(preview.checkPaths).toEqual([{ title: 'widgets · gizmo', path: '/Users/me/gizmo' }]);
  });

  it('titles a model set that mentions a home folder as a Model set', () => {
    const preview = clonePreview(
      bundle({ components: { modelSets: { claude: { models: ['opus'], home: '/home/me/models' } } }, files: [] }),
      machineView(),
    );
    expect(preview.checkPaths).toEqual([{ title: 'Model set · claude', path: '/home/me/models' }]);
  });

  it('tolerates a component that is not an object', () => {
    const preview = clonePreview(
      bundle({ components: { settings: { odd: 'a string', list: ['x'], none: null } }, files: [] }),
      machineView(),
    );
    expect(preview.components).toBe(3);
    expect(preview.checkPaths).toEqual([]);
  });

  it('names a tool a copied runtime needs that the target lacks (E29)', () => {
    const preview = clonePreview(bundle(), machineView());
    expect(preview.missingTools).toEqual(['codex']);
  });

  it('names no missing tool when the target has every tool the runtimes need', () => {
    const target = machineView({
      tools: [
        { harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' },
        { harness: 'codex', label: 'Codex', installed: true, command: '/usr/local/bin/codex' },
      ],
    });
    expect(clonePreview(bundle(), target).missingTools).toEqual([]);
  });

  it('ignores a login that no copied runtime uses when naming missing tools', () => {
    const preview = clonePreview(
      bundle({ runtimes: { 'claude-default': { credential: 'claude-work', profile: 'default' } } }),
      machineView(),
    );
    expect(preview.missingTools).toEqual([]);
    expect(preview.logins).toBe(2);
  });

  it('ignores a runtime with no credential id', () => {
    const preview = clonePreview(bundle({ runtimes: { bare: { profile: 'default' } } }), machineView());
    expect(preview.missingTools).toEqual([]);
    expect(preview.runtimes).toBe(1);
  });

  it('treats every tool as installed when the target is unknown', () => {
    expect(clonePreview(bundle(), null).missingTools).toEqual([]);
  });

  it('carries what the source could not copy, with the reason', () => {
    const notCopied = [{ path: 'components/skills/big.zip', reason: 'Too large to carry.' }];
    expect(clonePreview(bundle({ notCopied }), machineView()).notCopied).toEqual(notCopied);
  });
});

describe('copiesRows', () => {
  it('lists each count with its word, singular or plural', () => {
    const rows = copiesRows({
      components: 3,
      modelSets: 1,
      profiles: 0,
      runtimes: 2,
      logins: 2,
      signIns: 1,
      apiKeyLogins: 1,
      checkPaths: [],
      missingTools: [],
      notCopied: [],
      runnables: [],
      problem: null,
      skipped: 0,
    });
    expect(rows.map(row => row.title)).toEqual(['3 components', '1 model set', '0 profiles', '2 runtimes']);
    expect(rows[0]?.detail).toBe('Instructions, MCP servers, skills, settings and hooks');
    expect(rows[1]?.detail).toBeUndefined();
  });
});

describe('existingSentence', () => {
  it('says what the target already has and asks what should happen', () => {
    expect(existingSentence('studio-mac', 2, 3)).toBe(
      'studio-mac already has 2 profiles and 3 runtimes. What should happen to them?',
    );
    expect(existingSentence('studio-mac', 1, 1)).toBe(
      'studio-mac already has 1 profile and 1 runtime. What should happen to them?',
    );
  });
});

describe('cloneSlots', () => {
  const signedIn = {
    word: 'healthy',
    label: 'Signed in',
    reason: 'signed_in',
    explanation: 'Signed in.',
    lastCheckInconclusive: false,
  } as unknown as ReturnType<typeof credentialView>['status'];

  it('keeps only empty slots cloned from the source, the busiest first (E31)', () => {
    const quiet = credentialView('quiet', { clonedFrom: 'work-linux' });
    const busy = credentialView('busy', { clonedFrom: 'work-linux', usedBy: ['a', 'b', 'c'] as never });
    const middle = credentialView('middle', { clonedFrom: 'work-linux', usedBy: ['a'] as never });
    const elsewhere = credentialView('elsewhere', { clonedFrom: 'other-box', usedBy: ['a', 'b'] as never });
    const own = credentialView('own');
    const done = credentialView('done', { clonedFrom: 'work-linux', status: signedIn });
    expect(cloneSlots([quiet, busy, elsewhere, middle, own, done], 'work-linux').map(slot => slot.id)).toEqual([
      'busy',
      'middle',
      'quiet',
    ]);
  });

  it('is empty when nothing was cloned from the source', () => {
    expect(cloneSlots([credentialView('own')], 'work-linux')).toEqual([]);
  });
});

describe('the review of what a copy runs (cross-machine §3a)', () => {
  it('lists every component that could make the target run something, instructions included', () => {
    const preview = clonePreview(bundle(), machineView());
    expect(preview.runnables.map(runnable => runnable.reference)).toEqual(['instructions/default', 'mcp/notes']);
    expect(preview.runnables[1]?.entries[0]).toEqual({
      label: 'Starts',
      text: '/home/me/bin/notes-server',
      document: false,
    });
  });

  it('leaves a skipped component out of every count, and counts it as left out', () => {
    const preview = clonePreview(bundle(), machineView(), ['mcp/notes']);
    expect(preview.components).toBe(1);
    expect(preview.skipped).toBe(1);
    expect(preview.checkPaths).not.toContainEqual({ title: 'MCP server · notes', path: '/home/me/bin/notes-server' });
    // Still listed, so the person can tick it back.
    expect(preview.runnables.map(runnable => runnable.reference)).toEqual(['instructions/default', 'mcp/notes']);
  });

  it('titles a runnable by its kind and name, and sizes a document by its lines', () => {
    expect(runnableTitle({ reference: 'hooks/guard', kind: 'hooks', name: 'guard', entries: [] })).toBe(
      'Hooks · guard',
    );
    expect(documentSize('a\nb\n')).toBe('2 lines');
    expect(documentSize('one')).toBe('1 line');
  });

  it('says what the source shares with the target before anything is picked (§3d)', () => {
    expect(cloneSharesSentence('work-linux')).toBe(
      'work-linux receives a copy of the instructions, skills, settings and hooks of the machine you pick, so only pick one whose setup you’re happy for work-linux to see. A sign-in never leaves it; an API key does only sealed, with your passkey.',
    );
  });
});

describe('cloneOriginName', () => {
  const names = new Map([['sha256:work', 'Work laptop']]);

  it('names a copy by the reader’s own label for the machine the browser verified', () => {
    expect(cloneOriginName({ clonedFrom: 'work-mac', clonedFromDaemon: 'sha256:work' }, names)).toBe('Work laptop');
  });

  it('falls back to the name the source gave itself, said to be only that', () => {
    expect(cloneOriginName({ clonedFrom: 'work-mac', clonedFromDaemon: 'sha256:gone' }, names)).toBe(
      'work-mac (the name it gave itself)',
    );
    expect(cloneOriginName({ clonedFrom: 'work-mac' }, names)).toBe('work-mac (the name it gave itself)');
  });

  it('is undefined for something that was not copied', () => {
    expect(cloneOriginName({}, names)).toBeUndefined();
  });
});

describe('a bundle the review could misread (review H1)', () => {
  it('carries the target’s refusal, so the screen never offers to copy it', () => {
    const orphan = bundle({ files: [...bundle().files, { path: 'components/hooks/mine.json', content: '{}' }] });
    expect(clonePreview(orphan, machineView()).problem).toBe(
      'The setup from work-linux carries components/hooks/mine.json, which none of its components uses, so none of it can be copied.',
    );
    expect(clonePreview(bundle(), machineView()).problem).toBeNull();
  });
});

describe('cloneDefaultView', () => {
  it('selects none and sends nothing when the machine had no default to lose', () => {
    // Act
    const view = cloneDefaultView({
      bundle: bundle(),
      mode: 'replace',
      machineName: 'Liftoff MBP',
      targetDefault: undefined,
      sourceDefault: undefined,
      picked: undefined,
    });

    // Assert
    expect(view.selected).toBe(CLONE_NO_DEFAULT);
    expect(view.send).toBeUndefined();
  });

  it('sends null when the person picks none for a machine that had a default', () => {
    // Act
    const view = cloneDefaultView({
      bundle: bundle(),
      mode: 'replace',
      machineName: 'Liftoff MBP',
      targetDefault: 'claude-kirin',
      sourceDefault: undefined,
      picked: null,
    });

    // Assert
    expect(view.selected).toBe(CLONE_NO_DEFAULT);
    expect(view.send).toBeNull();
  });
});
