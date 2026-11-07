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
  test('the owner’s acts are person routes: the board switch, a plan’s approval and starting a ferret', () => {
    const person = new Set<string>(
      manifest.actions.routes.filter(route => route.caller === 'person').map(route => route.key),
    );
    for (const key of ['PUT /v1/board/projects/:project/switch', 'POST /v1/board/cards/:id/start'])
      expect(person.has(key)).toBe(true);
    expect([...person].filter(key => key.includes('/plans')).length).toBe(8);
  });
  test('it takes the card ask source, start.decide and sitrep.lines, and offers card.moving', () => {
    expect(manifest.hooks.takes.map(take => take.hook.name)).toEqual(['ask.sources', 'start.decide', 'sitrep.lines']);
    expect(manifest.hooks.takes[0]?.key).toBe('card');
    expect(manifest.hooks.offers.map(offer => offer.hook.name)).toEqual(['card.moving']);
  });
  test('state files are the §9.2 five, all format 1', () => {
    expect(manifest.data.state.map(file => [file.path, file.format])).toEqual([
      ['cards/*.json', 1],
      ['counters.json', 1],
      ['boards/*.json', 1],
      ['sweep.json', 1],
      ['github.json', 1],
    ]);
  });
});
