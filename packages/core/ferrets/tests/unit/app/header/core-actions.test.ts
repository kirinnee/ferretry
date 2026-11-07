import { describe, expect, it } from 'bun:test';
import {
  CORE_FERRET_ACTIONS,
  type CoreActionContext,
  FERRET_ACTION_IDS,
} from '../../../../app/features/header/core-actions.ts';
import { ferretActionSections } from '../../../../app/features/header/registry.ts';
import type { FerretState } from '../../../../contract/index.ts';
import { ferretSummary } from './support.ts';

const noop = (): void => undefined;

const context = (state: FerretState, overrides: Partial<CoreActionContext> = {}): CoreActionContext => ({
  ferret: ferretSummary('a1', { state }),
  name: 'Hadi',
  canControl: true,
  copyId: noop,
  openMove: noop,
  restart: async () => undefined,
  stop: async () => undefined,
  resume: async () => undefined,
  renderRename: () => null,
  ...overrides,
});

const idsFor = (ctx: CoreActionContext): readonly string[] =>
  ferretActionSections(CORE_FERRET_ACTIONS, ctx)
    .flatMap(section => section.entries)
    .map(entry => entry.id);

describe('FERRET_ACTION_IDS', () => {
  it('names every id the core actions, and other surfaces, address by', () => {
    expect(Object.values(FERRET_ACTION_IDS)).toEqual([
      'rename',
      'copy-id',
      'pin',
      'move-login',
      'move-harness',
      'move-machine',
      'restart',
      'earlier-conversation',
      'resume',
      'stop',
    ]);
  });
});

describe('CORE_FERRET_ACTIONS — pinning', () => {
  const entryFor = (ctx: CoreActionContext) =>
    ferretActionSections(CORE_FERRET_ACTIONS, ctx)
      .flatMap(section => section.entries)
      .find(entry => entry.id === FERRET_ACTION_IDS.pin);

  it('offers Pin to top only where the host can pin, and asks to pin', async () => {
    expect(entryFor(context('working'))).toBeUndefined();
    const asked: boolean[] = [];
    const entry = entryFor(
      context('working', {
        setPinned: async pinned => {
          asked.push(pinned);
        },
      }),
    );
    expect(entry?.label).toBe('Pin to top');
    if (entry?.kind === 'run') await entry.run();
    expect(asked).toEqual([true]);
  });

  it('offers Unpin on a pinned ferret, even a stopped one, and asks to unpin', async () => {
    const asked: boolean[] = [];
    const entry = entryFor(
      context('stopped', {
        ferret: ferretSummary('a1', { state: 'stopped', pinnedAt: '2026-11-02T10:00:00.000Z' as never }),
        setPinned: async pinned => {
          asked.push(pinned);
        },
      }),
    );
    expect(entry?.label).toBe('Unpin');
    if (entry?.kind === 'run') await entry.run();
    expect(asked).toEqual([false]);
  });

  it('is withheld from a connection that may not control the ferret', () => {
    expect(entryFor(context('working', { canControl: false, setPinned: async () => undefined }))).toBeUndefined();
  });
});

describe('CORE_FERRET_ACTIONS — a controlled, running ferret', () => {
  it('offers rename, copy id, move, and a Restart confirm and Stop, but no resume', () => {
    expect(idsFor(context('working'))).toEqual([
      FERRET_ACTION_IDS.rename,
      FERRET_ACTION_IDS.copyId,
      FERRET_ACTION_IDS.move,
      FERRET_ACTION_IDS.machine,
      FERRET_ACTION_IDS.restart,
      FERRET_ACTION_IDS.stop,
    ]);
  });

  it('draws the sections in the registry’s group order: ferret, move, danger', () => {
    const sections = ferretActionSections(CORE_FERRET_ACTIONS, context('working'));
    expect(sections.map(section => section.group)).toEqual(['ferret', 'move', 'danger']);
  });

  it('offers Go back to the earlier conversation only where the host can, as a confirm after Restart', async () => {
    let asked = 0;
    const offered = context('working', {
      restartOnEarlierConversation: async () => {
        asked += 1;
      },
    });
    const ids = idsFor(offered);
    expect(idsFor(context('working'))).not.toContain(FERRET_ACTION_IDS.earlierConversation);
    expect(ids.indexOf(FERRET_ACTION_IDS.earlierConversation)).toBe(ids.indexOf(FERRET_ACTION_IDS.restart) + 1);
    expect(idsFor({ ...offered, ferret: ferretSummary('a1', { state: 'stopped' }) })).not.toContain(
      FERRET_ACTION_IDS.earlierConversation,
    );
    const entry = ferretActionSections(CORE_FERRET_ACTIONS, offered)
      .flatMap(section => section.entries)
      .find(found => found.id === FERRET_ACTION_IDS.earlierConversation);
    expect(entry?.label).toBe('Go back to the earlier conversation…');
    if (entry?.kind === 'confirm') await entry.run();
    expect(asked).toBe(1);
  });

  it('move to another machine exists but is always unavailable', () => {
    const sections = ferretActionSections(CORE_FERRET_ACTIONS, context('working'));
    const machine = sections.flatMap(section => section.entries).find(entry => entry.id === FERRET_ACTION_IDS.machine);
    expect(machine?.unavailable).toBe('later');
  });

  it('carries the ferret’s runtime as the Move to another login detail', () => {
    const sections = ferretActionSections(
      CORE_FERRET_ACTIONS,
      context('working', { ferret: ferretSummary('a1', { runtime: 'nero' }) }),
    );
    const move = sections.flatMap(section => section.entries).find(entry => entry.id === FERRET_ACTION_IDS.move);
    expect(move?.detail).toBe('nero');
  });

  it('runs copyId, openMove and the confirm actions through the context handed to it', async () => {
    const calls: string[] = [];
    const ctx = context('working', {
      copyId: () => calls.push('copy'),
      openMove: () => calls.push('move'),
      restart: async () => {
        calls.push('restart');
      },
      stop: async () => {
        calls.push('stop');
      },
    });
    const sections = ferretActionSections(CORE_FERRET_ACTIONS, ctx);
    const entry = (id: string) => sections.flatMap(section => section.entries).find(item => item.id === id);
    const copyEntry = entry(FERRET_ACTION_IDS.copyId);
    if (copyEntry?.kind === 'run') copyEntry.run();
    const moveEntry = entry(FERRET_ACTION_IDS.move);
    if (moveEntry?.kind === 'run') moveEntry.run();
    const restartEntry = entry(FERRET_ACTION_IDS.restart);
    if (restartEntry?.kind === 'confirm') await restartEntry.run();
    const stopEntry = entry(FERRET_ACTION_IDS.stop);
    if (stopEntry?.kind === 'confirm') await stopEntry.run();
    expect(calls).toEqual(['copy', 'move', 'restart', 'stop']);
  });
});

describe('CORE_FERRET_ACTIONS — state decides restart vs. resume vs. stop', () => {
  it('offers Resume, but neither Restart nor Stop, once a ferret is stopped', () => {
    const ids = idsFor(context('stopped'));
    expect(ids).toContain(FERRET_ACTION_IDS.resume);
    expect(ids).not.toContain(FERRET_ACTION_IDS.restart);
    expect(ids).not.toContain(FERRET_ACTION_IDS.stop);
  });

  it('offers Restart and Stop while running or at its prompt, never Resume', () => {
    for (const state of ['working', 'idle', 'starting'] as const) {
      const ids = idsFor(context(state));
      expect(ids).toContain(FERRET_ACTION_IDS.restart);
      expect(ids).toContain(FERRET_ACTION_IDS.stop);
      expect(ids).not.toContain(FERRET_ACTION_IDS.resume);
    }
  });

  it('marks the Stop entry danger and the Restart entry not', () => {
    const entries = ferretActionSections(CORE_FERRET_ACTIONS, context('working')).flatMap(section => section.entries);
    expect(entries.find(entry => entry.id === FERRET_ACTION_IDS.stop)?.danger).toBe(true);
    expect(entries.find(entry => entry.id === FERRET_ACTION_IDS.restart)?.danger).toBeUndefined();
  });

  it('says what Restart does: relaunch on the same login, resume the conversation', () => {
    const restart = ferretActionSections(CORE_FERRET_ACTIONS, context('working'))
      .flatMap(section => section.entries)
      .find(entry => entry.id === FERRET_ACTION_IDS.restart);
    expect(restart?.kind === 'confirm' ? restart.consequence : '').toBe(
      'It relaunches on the same login and resumes the conversation.',
    );
  });
});

describe('CORE_FERRET_ACTIONS — a read-only connection', () => {
  it('offers only Copy ferret id, whatever the state', () => {
    expect(idsFor(context('working', { canControl: false }))).toEqual([FERRET_ACTION_IDS.copyId]);
    expect(idsFor(context('stopped', { canControl: false }))).toEqual([FERRET_ACTION_IDS.copyId]);
  });
});

describe('CORE_FERRET_ACTIONS — Move to the other harness', () => {
  const convertLabel = (ctx: CoreActionContext): string | undefined =>
    ferretActionSections(CORE_FERRET_ACTIONS, ctx)
      .flatMap(section => section.entries)
      .find(entry => entry.id === FERRET_ACTION_IDS.convert)?.label;

  it('says Move to Codex… on a Claude ferret and Move to Claude… on a Codex one, right after Move to another login', () => {
    let opened = 0;
    const claude = context('working', {
      openConvert: () => {
        opened += 1;
      },
    });
    expect(convertLabel(claude)).toBe('Move to Codex…');
    const ids = idsFor(claude);
    expect(ids.indexOf(FERRET_ACTION_IDS.convert)).toBe(ids.indexOf(FERRET_ACTION_IDS.move) + 1);
    const entry = ferretActionSections(CORE_FERRET_ACTIONS, claude)
      .flatMap(section => section.entries)
      .find(found => found.id === FERRET_ACTION_IDS.convert);
    if (entry?.kind === 'run') entry.run();
    expect(opened).toBe(1);
    const codex = context('working', {
      openConvert: noop,
      ferret: ferretSummary('a1', { harness: 'codex' }),
    });
    expect(convertLabel(codex)).toBe('Move to Claude…');
  });

  it('is absent when the host offers no move or the connection cannot control the ferret', () => {
    expect(idsFor(context('working'))).not.toContain(FERRET_ACTION_IDS.convert);
    expect(idsFor(context('working', { openConvert: noop, canControl: false }))).not.toContain(
      FERRET_ACTION_IDS.convert,
    );
  });
});
