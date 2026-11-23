import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';

describe('board manifest', () => {
  test('#1552 no route, tool, verb or app action lets a card ask or be answered', () => {
    const names = [
      ...manifest.actions.routes.map(route => route.key),
      ...manifest.actions.agentTools.map(tool => tool.name),
      ...manifest.actions.cli.map(verb => verb.verb),
      ...manifest.actions.app.map(action => action.id),
    ];
    expect(names.filter(name => /answer|reply/i.test(name))).toEqual([]);
  });
  test('no import and no session routes; the verbs are `task`, and no verb line spells `card`', () => {
    const keys = manifest.actions.routes.map(route => route.key);
    expect(keys.some(key => /import|\/sessions\//.test(key))).toBe(false);
    expect(manifest.actions.cli.some(verb => verb.verb.includes('import'))).toBe(false);
    const verbs = manifest.actions.cli.map(verb => verb.verb);
    expect(verbs.filter(verb => verb.startsWith('task ')).length).toBe(26);
    expect(verbs.some(verb => /^card\b/u.test(verb))).toBe(false);
  });
  test('each task route is answered again under its former path, by the same descriptor (same guard, grant and audit)', () => {
    const byKey = new Map<string, Record<string, unknown>>(
      manifest.actions.routes.map(route => [route.key, route as unknown as Record<string, unknown>] as const),
    );
    const taskKeys = [...byKey.keys()].filter(key => key.includes('/v1/board/tasks'));
    expect(taskKeys).toHaveLength(5);
    for (const key of taskKeys) {
      const former = key.replace('/v1/board/tasks', '/v1/board/cards').replace(':taskId', ':cardId');
      const { key: _was, path: _wasPath, ...current } = byKey.get(key) ?? {};
      const { key: _former, path: _formerPath, ...old } = byKey.get(former) ?? {};
      expect([former, byKey.has(former)]).toEqual([former, true]);
      expect(old).toEqual(current);
    }
  });
  test('the owner’s writes are audited under the task kinds, by the former path too', () => {
    const kinds = manifest.actions.routes
      .filter(route => route.key.startsWith('POST /v1/board/tasks') || route.key.startsWith('POST /v1/board/cards'))
      .map(route => [route.key, 'record' in route.audit ? String(route.audit.record) : null]);
    expect(kinds).toEqual([
      ['POST /v1/board/tasks', 'task.created'],
      ['POST /v1/board/cards', 'task.created'],
      ['POST /v1/board/tasks/:taskId', 'task.acted'],
      ['POST /v1/board/cards/:cardId', 'task.acted'],
      ['POST /v1/board/tasks/:taskId/start', 'task.started'],
      ['POST /v1/board/cards/:cardId/start', 'task.started'],
    ]);
  });
  test('the progress tool is task_progress, and card_progress is its old name', () => {
    const tools = new Map(manifest.actions.agentTools.map(tool => [tool.name, tool] as const));
    expect(tools.get('task_progress')?.summary).toBe('Rewrite one task’s progress (now, doneSoFar, next).');
    expect(tools.get('card_progress')?.summary).toBe('old name of task_progress');
    expect(tools.get('card_progress')?.audit).toEqual(tools.get('task_progress')?.audit);
  });
  test('the app has the task screen, and the card screen stays for the links made before the rename', () => {
    expect(manifest.ui.screens.map(screen => [screen.id, screen.path])).toEqual([
      ['board', 'board/:project?'],
      ['task', 'task/:id'],
      ['card', 'card/:id'],
    ]);
    expect(manifest.actions.app.map(action => action.id)).toEqual(['task.move', 'task.start']);
  });
  test('the owner’s acts are person routes: the board switch and starting a ferret; plans are Accounts’, not Board’s', () => {
    const person = new Set<string>(
      manifest.actions.routes.filter(route => route.caller === 'person').map(route => route.key),
    );
    for (const key of ['PUT /v1/board/projects/:projectId/switch', 'POST /v1/board/tasks/:taskId/start'])
      expect(person.has(key)).toBe(true);
    expect([...person].filter(key => key.includes('/plans'))).toEqual([]);
  });
  test('it takes the card ask source, start.decide, sitrep.lines, turn.ended, ferret.started (D2 #12) and Conversation’s search.sources and reference.catalog (&), Ferrets’ session.archive-keeps, Asks’ agenda.context (board), Ferrets’ launch.parts (the compaction lines), uses Conversation, and offers card.moving', () => {
    expect(manifest.hooks.takes.map(take => take.hook.name)).toEqual([
      'ask.sources',
      'start.decide',
      'sitrep.lines',
      'turn.ended',
      'ferret.started',
      'search.sources',
      'reference.catalog',
      'session.archive-keeps',
      'agenda.context',
      'launch.parts',
    ]);
    expect(manifest.hooks.takes[0]?.key).toBe('card');
    expect(manifest.hooks.offers.map(offer => offer.hook.name)).toEqual(['task.moving']);
    expect(Object.keys(manifest.uses ?? {})).toEqual(['projects', 'conversation']);
  });
  test('state files are the §9.2 five plus the ferret focus, all format 1', () => {
    expect(manifest.data.state.map(file => [file.path, file.format])).toEqual([
      ['cards/*.json', 1],
      ['counters.json', 1],
      ['boards/*.json', 1],
      ['sweep.json', 1],
      ['focus.json', 1],
      ['github.json', 1],
    ]);
  });
});
