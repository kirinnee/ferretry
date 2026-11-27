import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';

describe('projects manifest', () => {
  test('declares the registry routes with their security descriptors', () => {
    const routes = manifest.actions.routes;
    expect(routes.map(route => route.key)).toEqual([
      'GET /v1/projects',
      'POST /v1/projects',
      'DELETE /v1/projects/:id',
      'GET /v1/projects/folders',
      'POST /v1/projects/folders',
      'PUT /v1/projects/:id/accounts',
      'GET /v1/projects/:id/repos',
      'GET /v1/projects/:id/files',
      'GET /v1/projects/:id/files/status',
      'POST /v1/projects/:id/files/rescan',
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

describe('projects first-run steps', () => {
  test('project setup is followed by Connect GitHub: two device pages in one "Projects" segment', () => {
    expect(manifest.onboarding.map(step => [step.id, step.order, step.side, step.group, step.stepHost])).toEqual([
      ['folders', 90, 'client', 'Projects', true],
      ['github', 91, 'client', 'Projects', true],
    ]);
    const slots = manifest.ui.panels.filter(panel => panel.slot === 'onboarding.step').map(panel => panel.id);
    expect(slots).toEqual(['onboarding-step', 'github-step']);
  });
});

describe('projects launch roots', () => {
  test('takes launch.roots under its one key: the known projects are what Ferrets reads', () => {
    expect(manifest.hooks.takes.map(take => [take.hook.name, 'key' in take ? take.key : undefined])).toEqual([
      ['launch.roots', 'projects'],
      ['ferret.started', undefined],
    ]);
  });
});
