import { describe, expect, it } from 'bun:test';
import {
  blocksAsDefault,
  defaultCandidates,
  moveConversation,
  movePlanSentence,
  moveTargets,
  removeLabel,
  renameProblem,
  runningOnRuntime,
  runtimeActionRefusal,
} from '../../../../../src/features/fleet/runtimes/runtime-actions-model.ts';
import { machine, RUNTIMES, runtime } from '../account-support.ts';

const ALL = RUNTIMES.runtimes;
const CODEX = ALL.find(entry => entry.name === 'codex-default') ?? runtime({ name: 'codex-default' });
const AGENT = ALL.find(entry => entry.name === 'claude-agent') ?? runtime({ name: 'claude-agent' });

describe('renameProblem', () => {
  it('should call the current name a no-op, a taken one a clash, and a free one fine', () => {
    expect(renameProblem('codex-default', CODEX, ALL, 'studio')).toEqual({
      message: 'It is already called codex-default.',
    });
    expect(renameProblem('claude-agent', CODEX, ALL, 'studio')?.message).toBe(
      'claude-agent is already a runtime on studio.',
    );
    expect(renameProblem('codex-work', CODEX, ALL, 'studio')).toBeNull();
  });
});

describe('runtimeActionRefusal', () => {
  it('should say why only when the machine refused this browser', () => {
    expect(runtimeActionRefusal(null)).toBeNull();
    expect(runtimeActionRefusal({ kind: 'open' })).toBeNull();
    expect(runtimeActionRefusal({ kind: 'step-up' })).toBeNull();
    expect(runtimeActionRefusal({ kind: 'unreadable' })).toBeNull();
    expect(runtimeActionRefusal({ kind: 'refused', refusal: 'not-granted' })?.length).toBeGreaterThan(0);
  });
});

describe('the default runtime', () => {
  it('should block removing only the runtime the machine names as its default', () => {
    expect(blocksAsDefault(AGENT, machine({ defaultRuntime: 'claude-agent' }))).toBe(true);
    expect(blocksAsDefault(AGENT, machine({ defaultRuntime: null }))).toBe(false);
    expect(blocksAsDefault(AGENT, null)).toBe(false);
  });

  it('should offer only the other agent runtimes as the new default', () => {
    expect(defaultCandidates(AGENT, ALL)).toEqual([]);
    expect(defaultCandidates(CODEX, ALL).map(entry => entry.name)).toEqual(['claude-agent']);
  });
});

describe('moving the ferrets', () => {
  it('should offer the runtimes that can launch, the same CLI first', () => {
    const unavailable = runtime({ name: 'claude-off', launch: { available: false, reason: 'Sign in to launch' } });
    expect(moveTargets(AGENT, [...ALL, unavailable]).map(entry => entry.name)).toEqual([
      'claude-default',
      'claude-review',
      'claude-work',
      'codex-default',
    ]);
  });

  it('should resume a conversation on the same CLI and convert it across', () => {
    const ferret = { id: 's-1', name: 'Fisher', harness: 'claude' } as const;
    expect(moveConversation(ferret, AGENT)).toBe('resume');
    expect(moveConversation(ferret, CODEX)).toBe('convert');
  });

  it('should read the ferrets from an apply preview, and none from any other', () => {
    const base = {
      id: 'p',
      revision: 'r',
      change: { kind: 'runtime.remove', name: 'x' },
      summary: 's',
      consequences: [],
      expiresAt: '2026-10-13T08:15:00.000Z',
      state: 'pending',
    } as const;
    const ferret = { id: 's-1', name: 'Fisher', harness: 'claude' } as const;
    expect(
      runningOnRuntime({
        ...base,
        preview: { kind: 'apply', operations: [], documents: [], runtimes: [], runningSessions: [ferret] },
      }),
    ).toEqual([ferret]);
    expect(
      runningOnRuntime({ ...base, preview: { kind: 'apply', operations: [], documents: [], runtimes: [] } }),
    ).toEqual([]);
    expect(
      runningOnRuntime({ ...base, preview: { kind: 'executor', executor: 'setup', description: 'Import' } }),
    ).toEqual([]);
  });

  it('should say exactly what the confirm button does', () => {
    expect(removeLabel(CODEX, 2, null)).toBe('Remove codex-default');
    expect(removeLabel(CODEX, 0, 'claude-default')).toBe('Remove codex-default');
    expect(removeLabel(CODEX, 1, 'claude-default')).toBe('Move 1 ferret to claude-default and remove codex-default');
    expect(movePlanSentence(1, null)).toBe('It keeps running until it ends.');
    expect(movePlanSentence(2, null)).toBe('They keep running until they end.');
    expect(movePlanSentence(1, 'claude-default')).toBe(
      'The ferret restarts on claude-default first, with its conversation, then the runtime is removed.',
    );
  });
});
