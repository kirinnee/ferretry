/**
 * Moving the records of one conversation to another folder: which records move, which are dropped and which make the
 * move refuse. Pure; the real `claude --worktree` transcript this was written against is moved in
 * tests/integration/claude-harness-relocate.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import { claudeProjectFolder } from '../../../daemon/lib/harness/claude-path.ts';
import {
  hasRealTurn,
  type Json,
  type MovePlan,
  recordMover,
  sourceFolders,
} from '../../../daemon/lib/harness/relocate-records.ts';

const OLD = '/src/work/app';
const plan = (over: Partial<MovePlan> = {}): MovePlan => ({
  from: [`${OLD}/.claude/worktrees/wt1`, OLD],
  to: '/dst/wt',
  home: '/dst/home',
  oldId: 'old-id',
  newId: 'new-id',
  spell: claudeProjectFolder,
  ...over,
});
const moved = (record: Json, over: Partial<MovePlan> = {}): Json => {
  const result = recordMover(plan(over))(record);
  if (!('record' in result)) throw new Error(JSON.stringify(result));
  return result.record;
};

describe('sourceFolders', () => {
  it('names the folder it was filed under and every checkout a worktree record names, longest first', () => {
    const records: Json[] = [
      {
        type: 'worktree-state',
        worktreeSession: { originalCwd: OLD, worktreePath: `${OLD}/.claude/worktrees/wt1`, n: 1 },
      },
      { type: 'x', list: [{ preEnterOriginalCwd: `${OLD}/` }] },
      'text' as never,
    ];
    expect(sourceFolders(records, `${OLD}/.claude/worktrees/wt1`)).toEqual([`${OLD}/.claude/worktrees/wt1`, OLD]);
  });

  it('leaves out a folder that is not absolute and the root itself', () => {
    expect(sourceFolders([{ originalCwd: 'relative/dir' }, { originalCwd: '/' }], undefined)).toEqual([]);
  });
});

describe('hasRealTurn', () => {
  it('is true for a user or assistant record with a message, and false for notes alone or a meta record', () => {
    expect(hasRealTurn([{ type: 'user', message: { role: 'user', content: 'hi' } }])).toBe(true);
    expect(hasRealTurn([{ type: 'assistant', message: {} }])).toBe(true);
    expect(hasRealTurn([{ type: 'last-prompt' }, { type: 'user' }, { type: 'user', isMeta: true, message: {} }])).toBe(
      false,
    );
  });
});

describe('recordMover', () => {
  it('drops a worktree binding', () => {
    expect(recordMover(plan())({ type: 'worktree-state', worktreeSession: { originalCwd: OLD } })).toEqual({
      drop: true,
    });
  });

  it('moves a folder key into the new folder and keeps one elsewhere, and renames only its own id', () => {
    const result = moved({
      type: 'user',
      cwd: `${OLD}/.claude/worktrees/wt1/pkg`,
      other: { cwd: '/tmp/elsewhere', sessionId: 'old-id', forkedFrom: 'old-id' },
      sessionId: 'old-id',
      message: { content: `look in ${OLD}/x` },
    });
    expect(result).toEqual({
      type: 'user',
      cwd: '/dst/wt/pkg',
      other: { cwd: '/tmp/elsewhere', sessionId: 'new-id', forkedFrom: 'old-id' },
      sessionId: 'new-id',
      message: { content: `look in ${OLD}/x` },
    });
  });

  it('keeps every record whole when the id does not change and nothing is of the source', () => {
    const result = recordMover(plan({ newId: 'old-id' }))({ type: 'user', sessionId: 'old-id', cwd: '/tmp/x' });
    expect(result).toEqual({ record: { type: 'user', sessionId: 'old-id', cwd: '/tmp/x' }, changed: false });
  });

  it('moves a folder written inside a sentence, a list, and the memory folder of the source machine, in a context record', () => {
    const dashed = claudeProjectFolder(OLD);
    const result = moved({
      type: 'attachment',
      systemPrompt: [`Primary working directory: ${OLD}/.claude/worktrees/wt1`, 'no path', 7],
      note: `memory at \`/cfg/a/projects/${dashed}/memory/\` and ${OLD}-two stays`,
      workingDirectory: OLD,
      deep: { cwd: `file:///${OLD.slice(1)}` },
    });
    expect(result).toEqual({
      type: 'attachment',
      systemPrompt: ['Primary working directory: /dst/wt', 'no path', 7],
      note: `memory at \`/dst/home/projects/${claudeProjectFolder('/dst/wt')}/memory/\` and ${OLD}-two stays`,
      workingDirectory: '/dst/wt',
      deep: { cwd: 'file:///dst/wt' },
    });
  });

  it('refuses a record of a kind it does not know that carries a folder of the source, as a path or as its dashed spelling', () => {
    for (const record of [
      { type: 'mystery', where: `${OLD}/src` },
      { where: OLD },
      { type: 'mystery', [claudeProjectFolder(OLD)]: 1 },
    ]) {
      const refused = recordMover(plan())(record);
      expect('refusal' in refused).toBe(true);
    }
    expect((recordMover(plan())({ type: 'mystery', where: OLD }) as { refusal: string }).refusal).toContain(
      '"mystery"',
    );
  });

  it('lets a record of an unknown kind through when it holds nothing of the source, and with no folder known nothing is of it', () => {
    expect(recordMover(plan())({ type: 'mystery', where: '/elsewhere' })).toEqual({
      record: { type: 'mystery', where: '/elsewhere' },
      changed: false,
    });
    expect(recordMover(plan({ from: [] }))({ type: 'mystery', where: OLD })).toEqual({
      record: { type: 'mystery', where: OLD },
      changed: false,
    });
  });
});
