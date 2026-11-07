import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';

describe('projects manifest', () => {
  test('declares the registry routes with their security descriptors', () => {
    const routes = manifest.actions.routes;
    expect(routes.map(route => route.key)).toEqual([
      'GET /v1/projects',
      'POST /v1/projects',
      'DELETE /v1/projects/:id',
    ]);
    for (const route of routes) expect(route.minimum).toBe('operator');
    expect(routes[2]?.caller).toBe('person');
  });
  test('owns exactly one state file, format 1, and needs nothing', () => {
    expect(manifest.data.state.map(file => [file.path, file.format])).toEqual([['projects.json', 1]]);
    expect('needs' in manifest).toBe(false);
  });
  test('every verb is a `project` verb and every halve is skeleton', async () => {
    expect(manifest.actions.cli.every(verb => verb.verb.startsWith('project '))).toBe(true);
    for (const half of ['daemon', 'app', 'cli']) expect(await import(`../../${half}/index.ts`)).toBeDefined();
  });
});
