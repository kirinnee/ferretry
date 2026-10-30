import { describe, expect, it } from 'bun:test';
import type { ManagedWorktreeView } from '@ferretry/protocol';
import {
  agendaLabel,
  agendaOn,
  charsLabel,
  effortLabel,
  harnessLabel,
  hypermediaLabel,
  hypermediaOn,
  INFO_HINT,
  INFO_TAB_LABEL,
  INFO_TABS,
  INFO_TABS_WITHOUT_BOARD,
  LAUNCH_SECTION_LABEL,
  launchInstructionFacts,
  learningLabel,
  lineage,
  loginScope,
  modelFacts,
  packLabel,
  packOn,
  remoteControlLabel,
  scrollToShow,
  worktreeFact,
} from '../../../../src/features/session-info/info-model.ts';
import { sessionView } from '../../../support/sessions.ts';

describe('INFO_TABS', () => {
  it('orders the seven tabs, names each one, and drops Tasks for a host with no board', () => {
    expect(INFO_TABS).toEqual(['overview', 'tasks', 'runtime', 'usage', 'folder', 'signals', 'surfaces']);
    expect(INFO_TABS_WITHOUT_BOARD).toEqual(['overview', 'runtime', 'usage', 'folder', 'signals', 'surfaces']);
    expect(INFO_TAB_LABEL.tasks).toBe('Tasks');
    expect(INFO_TAB_LABEL.overview).toBe('Overview');
    expect(INFO_TAB_LABEL.folder).toBe('Context');
    expect(Object.keys(INFO_HINT)).toContain('worktree');
  });
});

describe('harnessLabel / loginScope', () => {
  it('says Codex for a codex ferret, Claude Code for everything else', () => {
    expect(harnessLabel(sessionView('s', { config: { harness: 'codex' } }))).toBe('Codex');
    expect(harnessLabel(sessionView('s', { config: { harness: 'claude' } }))).toBe('Claude Code');
  });

  it('scopes the login chip to the harness that owns it', () => {
    expect(loginScope(sessionView('s', { config: { harness: 'codex' } }))).toBe('Codex-only');
    expect(loginScope(sessionView('s', { config: { harness: 'claude' } }))).toBe('Claude-only');
  });
});

describe('modelFacts', () => {
  it('is neither requested nor observed, and never a mismatch, before either is known', () => {
    const view = sessionView('s', { config: { model: undefined, modelHint: undefined }, state: {} });
    expect(modelFacts(view)).toEqual({ requested: null, observed: null, mismatch: false });
  });

  it('prefers a --model flag over the resolved model and the hint', () => {
    const view = sessionView('s', {
      config: { harnessFlags: ['--model', 'opus'], model: 'claude-sonnet-5', modelHint: 'claude-opus-5' },
    });
    expect(modelFacts(view).requested).toBe('opus');
  });

  it('is not a mismatch while only one side is known', () => {
    const noObserved = sessionView('s', { config: { model: 'opus' }, state: { observedModel: undefined } });
    expect(modelFacts(noObserved)).toEqual({ requested: 'opus', observed: null, mismatch: false });
  });

  it('is not a mismatch when the observed model contains the requested alias, case- and variant-insensitive', () => {
    const view = sessionView('s', {
      config: { model: 'OPUS' },
      state: { observedModel: 'claude-opus-4-5-20251101[1m]' },
    });
    expect(modelFacts(view)).toEqual({
      requested: 'OPUS',
      observed: 'claude-opus-4-5-20251101[1m]',
      mismatch: false,
    });
  });

  it('is a mismatch when both are known and genuinely differ', () => {
    const view = sessionView('s', { config: { model: 'opus' }, state: { observedModel: 'claude-haiku-5' } });
    expect(modelFacts(view)).toEqual({ requested: 'opus', observed: 'claude-haiku-5', mismatch: true });
  });
});

describe('effortLabel', () => {
  it('reads the CLI’s own report, else the launch level, else the harness default', () => {
    expect(effortLabel(sessionView('s', { state: { observedReasoningEffort: 'high' } }))).toBe('high');
    expect(
      effortLabel(
        sessionView('s', { state: { observedReasoningEffort: undefined }, config: { launchReasoningEffort: 'low' } }),
      ),
    ).toBe('low');
    expect(
      effortLabel(
        sessionView('s', {
          state: { observedReasoningEffort: undefined },
          config: { launchReasoningEffort: undefined },
        }),
      ),
    ).toBe('default');
  });
});

describe('worktreeFact', () => {
  const tree = (overrides: Partial<ManagedWorktreeView> = {}): ManagedWorktreeView =>
    ({
      path: '/work/app',
      branch: 'main',
      removedAt: undefined,
      live: undefined,
      ...overrides,
    }) as unknown as ManagedWorktreeView;

  it('is unknown while the worktree list is unread', () => {
    expect(worktreeFact(sessionView('s', { config: { cwd: '/work/app' } }), null)).toEqual({ kind: 'unknown' });
  });

  it('is the main checkout when the folder is in no managed worktree', () => {
    const view = sessionView('s', { config: { cwd: '/work/elsewhere' } });
    expect(worktreeFact(view, [tree()])).toEqual({ kind: 'main' });
  });

  it('matches the deepest containing worktree, skips a removed one, and reads dirty from its live status', () => {
    const view = sessionView('s', { config: { cwd: '/work/app/packages/pwa' } });
    const outer = tree({ path: '/work/app', branch: 'main' });
    const removed = tree({ path: '/work/app/packages', branch: 'gone', removedAt: '2026-10-01T00:00:00.000Z' });
    const inner = tree({
      path: '/work/app/packages/pwa',
      branch: 'feat/info',
      live: {
        branch: 'feat/info',
        detached: false,
        undetermined: [],
        status: {
          staged: false,
          unstaged: true,
          untracked: false,
          ignored: false,
          conflicted: false,
          dirtySubmodule: false,
          truncated: false,
        },
      },
    });
    expect(worktreeFact(view, [outer, removed, inner])).toEqual({
      kind: 'worktree',
      path: '/work/app/packages/pwa',
      branch: 'feat/info',
      dirty: true,
    });
  });

  it('is clean when every status flag is false, and dirty-unknown when there is no live status at all', () => {
    const view = sessionView('s', { config: { cwd: '/work/app' } });
    const clean = tree({
      live: {
        branch: 'main',
        detached: false,
        undetermined: [],
        status: {
          staged: false,
          unstaged: false,
          untracked: false,
          ignored: false,
          conflicted: false,
          dirtySubmodule: false,
          truncated: false,
        },
      },
    });
    const cleanFact = worktreeFact(view, [clean]);
    expect(cleanFact).toMatchObject({ kind: 'worktree', dirty: false });

    const unread = tree({ live: undefined });
    const unknownFact = worktreeFact(view, [unread]);
    expect(unknownFact).toMatchObject({ kind: 'worktree', dirty: null });
  });

  it('matches a folder exactly equal to the worktree root, not only a sub-path', () => {
    const view = sessionView('s', { config: { cwd: '/work/app' } });
    expect(worktreeFact(view, [tree({ path: '/work/app' })]).kind).toBe('worktree');
    // A root that merely shares a prefix is not a containing worktree.
    expect(worktreeFact(view, [tree({ path: '/work/app-other' })]).kind).toBe('main');
  });
});

describe('lineage', () => {
  it('is started by you when there is no parent', () => {
    const view = sessionView('child', { config: { parent: undefined } });
    expect(lineage(view, [view])).toEqual({ parent: null, children: [] });
  });

  it('names a parent not among the sessions read as its bare id', () => {
    const view = sessionView('child', { config: { parent: 'ghost-parent' } });
    expect(lineage(view, [view]).parent).toBe('ghost-parent');
  });

  it('resolves a parent that is among the sessions read, and lists this ferret’s children', () => {
    const parent = sessionView('parent');
    const child = sessionView('child', { config: { parent: 'parent' } });
    const sibling = sessionView('sibling', { config: { parent: 'child' } });
    const result = lineage(child, [parent, child, sibling]);
    expect(result.parent).toBe(parent);
    expect(result.children).toEqual([sibling]);
  });

  it('has no children when no sessions were handed in at all', () => {
    expect(lineage(sessionView('solo'), undefined)).toEqual({ parent: null, children: [] });
  });
});

describe('learningLabel', () => {
  it('says what the ferret was told to do, not what it has done', () => {
    expect(learningLabel(true)).toBe('On · instructed to file lessons');
    expect(learningLabel(false)).toBe('Off · not instructed');
  });

  it('explains the row in one line that points at Actions', () => {
    expect(INFO_HINT.learning).toBe(
      'Passive learning only controls whether this ferret is instructed to file lessons with fy lesson suggest. Change it in Actions.',
    );
  });
});

describe('agenda mode', () => {
  it('reads a session with no switch as off, and an explicit value as itself', () => {
    expect(agendaOn(sessionView('legacy', { config: { mode: 'interactive' } }))).toBe(false);
    expect(agendaOn(sessionView('on', { config: { agenda: true } }))).toBe(true);
    expect(agendaOn(sessionView('off', { config: { agenda: false } }))).toBe(false);
  });

  it('says what the ferret is told, and that a change waits for its next launch', () => {
    expect(agendaLabel(true)).toBe('On · keeps an agenda of open items');
    expect(agendaLabel(false)).toBe('Off · notify rule only');
    expect(INFO_HINT.agenda).toContain('takes effect at its next launch');
  });
});

describe('hypermedia', () => {
  it('reads a session with no switch as its mode default (on interactive, off auto), and an explicit value as itself', () => {
    expect(hypermediaOn(sessionView('legacy', { config: { mode: 'interactive' } }))).toBe(true);
    expect(hypermediaOn(sessionView('legacy-auto', { config: { mode: 'auto' } }))).toBe(false);
    expect(hypermediaOn(sessionView('forced', { config: { mode: 'auto', hypermedia: true } }))).toBe(true);
    expect(hypermediaOn(sessionView('on', { config: { hypermedia: true } }))).toBe(true);
    expect(hypermediaOn(sessionView('off', { config: { hypermedia: false } }))).toBe(false);
  });

  it('says what the ferret is told, and that a change waits for its next start', () => {
    expect(hypermediaLabel(true)).toBe('On · may explain with diagrams and media');
    expect(hypermediaLabel(false)).toBe('Off · plain text');
    expect(INFO_HINT.hypermedia).toContain('takes effect when it next starts');
  });
});

describe('pack', () => {
  it('reads a session from before the switch as on, and only an explicit false as off', () => {
    expect(packOn(sessionView('legacy'))).toBe(true);
    expect(packOn(sessionView('off', { config: { pack: false } }))).toBe(false);
    expect(packLabel(true)).toBe('On · may delegate to sub-ferrets');
    expect(packLabel(false)).toBe('Off · works alone');
    expect(INFO_HINT.pack).toContain('next launch');
  });
});

describe('remoteControlLabel', () => {
  it('reads off unless the session explicitly asked, and not available on Codex', () => {
    expect(remoteControlLabel(sessionView('plain'))).toBe('Off');
    expect(remoteControlLabel(sessionView('on', { config: { remoteControl: true } }))).toBe(
      'On · another device can drive this session',
    );
    expect(remoteControlLabel(sessionView('codex', { config: { harness: 'codex', remoteControl: true } }))).toBe(
      'Not available on Codex',
    );
    expect(INFO_HINT.remoteControl).toContain('next launch');
  });
});

describe('charsLabel', () => {
  it('says a small size whole and a large one in thousands, dropping a bare .0', () => {
    expect(charsLabel(0)).toBe('0 chars');
    expect(charsLabel(999)).toBe('999 chars');
    expect(charsLabel(1000)).toBe('1k chars');
    expect(charsLabel(1234)).toBe('1.2k chars');
  });
});

describe('launchInstructionFacts', () => {
  it('names each recorded section with its size, the mode and the question rule', () => {
    const facts = launchInstructionFacts(
      sessionView('s', {
        state: {
          launchInstructions: {
            sections: [
              { id: 'tools', chars: 640 },
              { id: 'hypermedia', chars: 1180 },
            ],
            mode: 'interactive',
            questions: true,
          },
        },
      }),
    );
    expect(facts).toEqual({
      sections: [
        { id: 'tools', label: 'Ferretry tools · 640 chars' },
        { id: 'hypermedia', label: 'Hypermedia · 1.2k chars' },
      ],
      mode: 'Interactive',
      questions: 'Yes',
    });
  });

  it('says Agent and No for an unattended launch, and nothing for one never recorded', () => {
    const auto = launchInstructionFacts(
      sessionView('s', { state: { launchInstructions: { sections: [], mode: 'auto', questions: false } } }),
    );
    expect(auto).toEqual({ sections: [], mode: 'Agent', questions: 'No' });
    expect(launchInstructionFacts(sessionView('s'))).toBeUndefined();
    expect(Object.keys(LAUNCH_SECTION_LABEL)).toEqual([
      'tools',
      'settings',
      'attention',
      'notify',
      'board',
      'sub-ferret',
      'hypermedia',
      'pack',
      'agenda',
      'learning',
    ]);
  });
});

describe('scrollToShow', () => {
  it('leaves a tab that is already in view, and scrolls to the nearer edge otherwise', () => {
    expect(scrollToShow(50, 60, 40, 100)).toBe(50);
    expect(scrollToShow(100, 20, 40, 100)).toBe(20);
    expect(scrollToShow(0, 260, 60, 100)).toBe(220);
  });
});
