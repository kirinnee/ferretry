import { describe, expect, it } from 'bun:test';
import type { SessionStatus } from '@ferretry/protocol';
import {
  CORE_SESSION_ACTIONS,
  type CoreActionContext,
  SESSION_ACTION_IDS,
} from '../../../../src/features/session-actions/core-actions.ts';
import { sessionActionSections } from '../../../../src/features/session-actions/registry.ts';
import { sessionView } from '../../../support/sessions.ts';

const noop = (): void => undefined;

const context = (status: SessionStatus, overrides: Partial<CoreActionContext> = {}): CoreActionContext => ({
  view: sessionView('a1', { state: { status } }),
  name: 'Hadi',
  canControl: true,
  copyId: noop,
  openMigrate: noop,
  restart: async () => undefined,
  stop: async () => undefined,
  resume: async () => undefined,
  renderRename: () => null,
  renderFork: () => null,
  ...overrides,
});

const idsFor = (ctx: CoreActionContext): readonly string[] =>
  sessionActionSections(CORE_SESSION_ACTIONS, ctx)
    .flatMap(section => section.entries)
    .map(entry => entry.id);

describe('SESSION_ACTION_IDS', () => {
  it('names every id the core actions, and other surfaces, address by', () => {
    expect(Object.values(SESSION_ACTION_IDS)).toEqual([
      'rename',
      'fork',
      'copy-id',
      'move-login',
      'move-harness',
      'move-machine',
      'add-mcp',
      'restart',
      'earlier-conversation',
      'resume',
      'stop',
    ]);
  });
});

describe('CORE_SESSION_ACTIONS — a controlled, running ferret', () => {
  it('offers rename, fork, copy id, move, and a Restart confirm, but no resume and no Add MCP without a renderer', () => {
    const ids = idsFor(context('running'));
    expect(ids).toEqual([
      SESSION_ACTION_IDS.rename,
      SESSION_ACTION_IDS.fork,
      SESSION_ACTION_IDS.copyId,
      SESSION_ACTION_IDS.migrate,
      SESSION_ACTION_IDS.machine,
      SESSION_ACTION_IDS.restart,
      SESSION_ACTION_IDS.stop,
    ]);
  });

  it('draws the sections in the registry’s group order: session, move, tools, danger', () => {
    const sections = sessionActionSections(CORE_SESSION_ACTIONS, context('running', { renderAddMcp: () => null }));
    expect(sections.map(section => section.group)).toEqual(['session', 'move', 'tools', 'danger']);
    expect(sections.find(section => section.group === 'tools')?.entries.map(entry => entry.id)).toEqual([
      SESSION_ACTION_IDS.addMcp,
    ]);
  });

  it('offers Add MCP server only when the host can render it', () => {
    expect(idsFor(context('running'))).not.toContain(SESSION_ACTION_IDS.addMcp);
    expect(idsFor(context('running', { renderAddMcp: () => null }))).toContain(SESSION_ACTION_IDS.addMcp);
  });

  it('offers Go back to the earlier conversation only where the host can, as a confirm after Restart', async () => {
    let asked = 0;
    const offered = context('running', {
      restartOnEarlierConversation: async () => {
        asked += 1;
      },
    });
    const ids = idsFor(offered);
    expect(idsFor(context('running'))).not.toContain(SESSION_ACTION_IDS.earlierConversation);
    expect(ids.indexOf(SESSION_ACTION_IDS.earlierConversation)).toBe(ids.indexOf(SESSION_ACTION_IDS.restart) + 1);
    expect(idsFor({ ...offered, view: sessionView('a1', { state: { status: 'stopped' } }) })).not.toContain(
      SESSION_ACTION_IDS.earlierConversation,
    );
    const entry = sessionActionSections(CORE_SESSION_ACTIONS, offered)
      .flatMap(section => section.entries)
      .find(found => found.id === SESSION_ACTION_IDS.earlierConversation);
    expect(entry?.label).toBe('Go back to the earlier conversation…');
    if (entry?.kind === 'confirm') await entry.run();
    expect(asked).toBe(1);
  });

  it('move to another machine exists but is always unavailable', () => {
    const sections = sessionActionSections(CORE_SESSION_ACTIONS, context('running'));
    const machine = sections.flatMap(section => section.entries).find(entry => entry.id === SESSION_ACTION_IDS.machine);
    expect(machine?.unavailable).toBe('later');
  });

  it('carries the ferret’s login as the Move to another login detail', () => {
    const sections = sessionActionSections(
      CORE_SESSION_ACTIONS,
      context('running', { view: sessionView('a1', { config: { agent: 'nero' } }) }),
    );
    const migrate = sections.flatMap(section => section.entries).find(entry => entry.id === SESSION_ACTION_IDS.migrate);
    expect(migrate?.detail).toBe('nero');
  });

  it('runs copyId, openMigrate and the confirm actions through the context handed to it', async () => {
    const calls: string[] = [];
    const ctx = context('running', {
      copyId: () => calls.push('copy'),
      openMigrate: () => calls.push('migrate'),
      restart: async () => {
        calls.push('restart');
      },
      stop: async () => {
        calls.push('stop');
      },
    });
    const sections = sessionActionSections(CORE_SESSION_ACTIONS, ctx);
    const entry = (id: string) => sections.flatMap(section => section.entries).find(item => item.id === id);
    const copyEntry = entry(SESSION_ACTION_IDS.copyId);
    if (copyEntry?.kind === 'run') copyEntry.run();
    const migrateEntry = entry(SESSION_ACTION_IDS.migrate);
    if (migrateEntry?.kind === 'run') migrateEntry.run();
    const restartEntry = entry(SESSION_ACTION_IDS.restart);
    if (restartEntry?.kind === 'confirm') await restartEntry.run();
    const stopEntry = entry(SESSION_ACTION_IDS.stop);
    if (stopEntry?.kind === 'confirm') await stopEntry.run();
    expect(calls).toEqual(['copy', 'migrate', 'restart', 'stop']);
  });
});

describe('CORE_SESSION_ACTIONS — status decides restart vs. resume vs. stop', () => {
  it('offers Resume and Stop, but not Restart, once a ferret is stopped and did not fail to be killed', () => {
    const ids = idsFor(context('stopped'));
    expect(ids).toContain(SESSION_ACTION_IDS.resume);
    expect(ids).not.toContain(SESSION_ACTION_IDS.restart);
    expect(ids).not.toContain(SESSION_ACTION_IDS.stop);
  });

  it('offers Restart and Stop while running, never Resume', () => {
    const ids = idsFor(context('running'));
    expect(ids).toContain(SESSION_ACTION_IDS.restart);
    expect(ids).toContain(SESSION_ACTION_IDS.stop);
    expect(ids).not.toContain(SESSION_ACTION_IDS.resume);
  });

  it('a kill_failed ferret offers Stop again, to retry it, and never Resume or Restart', () => {
    const ids = idsFor(context('kill_failed'));
    expect(ids).toContain(SESSION_ACTION_IDS.stop);
    expect(ids).not.toContain(SESSION_ACTION_IDS.resume);
    expect(ids).not.toContain(SESSION_ACTION_IDS.restart);
  });

  it('marks the Stop entry danger and the Restart entry not', () => {
    const sections = sessionActionSections(CORE_SESSION_ACTIONS, context('running'));
    const entries = sections.flatMap(section => section.entries);
    expect(entries.find(entry => entry.id === SESSION_ACTION_IDS.stop)?.danger).toBe(true);
    expect(entries.find(entry => entry.id === SESSION_ACTION_IDS.restart)?.danger).toBeUndefined();
  });

  it('says an outdated ferret is outdated on Restart, its remedy — a phone bar has no room for the mark', () => {
    const restartOf = (ctx: CoreActionContext) =>
      sessionActionSections(CORE_SESSION_ACTIONS, ctx)
        .flatMap(section => section.entries)
        .find(entry => entry.id === SESSION_ACTION_IDS.restart);
    const outdated = { ...sessionView('a1', { state: { status: 'running' } }), outdated: { sections: ['pack'] } };
    const restart = restartOf(context('running', { view: outdated as CoreActionContext['view'] }));
    expect(restart?.detail).toBe('Outdated');
    expect(restart?.kind === 'confirm' ? restart.consequence : '').toContain('loads the new instructions (Pack mode)');
    const upToDate = restartOf(context('running'));
    expect(upToDate?.detail).toBeUndefined();
    expect(upToDate?.kind === 'confirm' ? upToDate.consequence : '').toBe(
      'It relaunches on the same login and resumes the conversation.',
    );
  });

  it('completed (terminal, not kill_failed) behaves exactly like stopped', () => {
    const ids = idsFor(context('completed'));
    expect(ids).toContain(SESSION_ACTION_IDS.resume);
    expect(ids).not.toContain(SESSION_ACTION_IDS.restart);
    expect(ids).not.toContain(SESSION_ACTION_IDS.stop);
  });
});

describe('CORE_SESSION_ACTIONS — a read-only connection', () => {
  it('offers only Copy session id, whatever the status', () => {
    expect(idsFor(context('running', { canControl: false }))).toEqual([SESSION_ACTION_IDS.copyId]);
    expect(idsFor(context('kill_failed', { canControl: false }))).toEqual([SESSION_ACTION_IDS.copyId]);
  });

  it('never offers Add MCP server, even with a renderer, once control is gone', () => {
    const ids = idsFor(context('running', { canControl: false, renderAddMcp: () => null }));
    expect(ids).not.toContain(SESSION_ACTION_IDS.addMcp);
  });
});

describe('CORE_SESSION_ACTIONS — Move to the other harness', () => {
  const convertLabel = (ctx: CoreActionContext): string | undefined =>
    sessionActionSections(CORE_SESSION_ACTIONS, ctx)
      .flatMap(section => section.entries)
      .find(entry => entry.id === SESSION_ACTION_IDS.convert)?.label;

  it('says Move to Codex… on a Claude ferret and Move to Claude… on a Codex one, right after Move to another login', () => {
    let opened = 0;
    const claude = context('running', {
      openConvert: () => {
        opened += 1;
      },
    });
    expect(convertLabel(claude)).toBe('Move to Codex…');
    const ids = idsFor(claude);
    expect(ids.indexOf(SESSION_ACTION_IDS.convert)).toBe(ids.indexOf(SESSION_ACTION_IDS.migrate) + 1);
    const entry = sessionActionSections(CORE_SESSION_ACTIONS, claude)
      .flatMap(section => section.entries)
      .find(found => found.id === SESSION_ACTION_IDS.convert);
    if (entry?.kind === 'run') entry.run();
    expect(opened).toBe(1);
    const codex = context('running', {
      openConvert: noop,
      view: sessionView('a1', { config: { harness: 'codex' } }),
    });
    expect(convertLabel(codex)).toBe('Move to Claude…');
  });

  it('is absent when the host offers no move or the connection cannot control the ferret', () => {
    expect(idsFor(context('running'))).not.toContain(SESSION_ACTION_IDS.convert);
    expect(idsFor(context('running', { openConvert: noop, canControl: false }))).not.toContain(
      SESSION_ACTION_IDS.convert,
    );
  });
});
