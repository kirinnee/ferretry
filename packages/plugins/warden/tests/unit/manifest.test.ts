import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';

describe('warden manifest', () => {
  test('declares the nine warden routes; a warden may read but never run, configure or leave', () => {
    const routes = manifest.actions.routes;
    expect(routes).toHaveLength(9);
    for (const route of routes) {
      const reads = route.method === 'GET' && route.path !== '/v1/warden/config';
      expect(route.minimum).toBe(reads ? 'authenticated' : 'operator');
    }
  });
  test('the owner’s own acts are person routes', () => {
    const person = manifest.actions.routes.filter(route => route.caller === 'person').map(route => route.path);
    expect(person.sort()).toEqual(['/v1/warden/config', '/v1/warden/investigate', '/v1/warden/leave']);
  });
  test('every body that can carry pane text is declared guarded', () => {
    const guarded = manifest.actions.routes.filter(route => route.guard === 'secrets').map(route => route.path);
    expect(guarded.sort()).toEqual([
      '/v1/warden/agenda',
      '/v1/warden/report',
      '/v1/warden/run',
      '/v1/warden/status',
      '/v1/warden/verdicts',
    ]);
  });
  test('it takes ferret.changed and turn.ended, needs ferrets, conversation and asks, may use Usage, Board, Terminals, Browsers, Runtimes and Voice', () => {
    expect(manifest.hooks.takes.map(take => take.hook.name)).toEqual(['ferret.changed', 'turn.ended']);
    expect(Object.keys(manifest.needs).sort()).toEqual(['asks', 'conversation', 'ferrets']);
    expect(Object.keys(manifest.uses)).toEqual(['usage', 'board', 'terminals', 'browsers', 'runtimes', 'voice']);
  });
  test('state files are format 1 and the blessings file fails narrower, not closed', () => {
    expect(manifest.data.state.every(file => file.format === 1)).toBe(true);
    expect(manifest.data.state.find(file => file.name === 'remembered')?.onDamaged).toEqual({
      narrower: 'reads as no blessings: the warden judges every ferret again',
    });
  });
});
