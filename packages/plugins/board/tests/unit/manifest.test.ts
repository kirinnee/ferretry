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
  test('compatibility is gone: no tasks routes, no import', () => {
    const keys = manifest.actions.routes.map(route => route.key);
    expect(keys.some(key => /\/tasks|import|\/sessions\//.test(key))).toBe(false);
    expect(manifest.actions.cli.some(verb => verb.verb.includes('import') || verb.verb.startsWith('task'))).toBe(false);
  });
  test('the owner’s acts are person routes: the board switch and starting a ferret; plans are Accounts’, not Board’s', () => {
    const person = new Set<string>(
      manifest.actions.routes.filter(route => route.caller === 'person').map(route => route.key),
    );
    for (const key of ['PUT /v1/board/projects/:projectId/switch', 'POST /v1/board/cards/:cardId/start'])
      expect(person.has(key)).toBe(true);
    expect([...person].filter(key => key.includes('/plans'))).toEqual([]);
  });
  test('it takes the card ask source, start.decide, sitrep.lines, turn.ended, ferret.started (D2 #12) and Conversation’s search.sources, uses Conversation, and offers card.moving', () => {
    expect(manifest.hooks.takes.map(take => take.hook.name)).toEqual([
      'ask.sources',
      'start.decide',
      'sitrep.lines',
      'turn.ended',
      'ferret.started',
      'search.sources',
    ]);
    expect(manifest.hooks.takes[0]?.key).toBe('card');
    expect(manifest.hooks.offers.map(offer => offer.hook.name)).toEqual(['card.moving']);
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
