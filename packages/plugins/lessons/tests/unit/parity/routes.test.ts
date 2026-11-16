/**
 * The Lessons-owned R rows of docs/design/rebuild-parity.tsv, one test per row, each named by its id. Every route is
 * driven through the real daemon half on the kernel's test host; today's path is named beside its 5.0 path (the
 * `learning` → `lessons` / `sessions` → `ferrets` / `agent` moves are recorded in descriptor-parity-changes.tsv, and
 * `descriptor-parity` compares the descriptor fields). Rows blocked on another subsystem are `test.skip` with the seam.
 */
import { describe, expect, test } from 'bun:test';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import { ferret, owner } from '@ferretry/kernel/testing';
import manifest from '../../../manifest.ts';
import { LESSONS_CONFIG } from '../../../contract/index.ts';
import { lessonsHost, realLessonsConfig } from './host.ts';

const json = (response: { readonly body?: unknown }): any => JSON.parse(String(response.body));

/** A host with one ferret that filed one Global lesson (the owner's words as its evidence). */
async function withLesson() {
  const world = await lessonsHost();
  world.ferrets.add({ id: ferretId('f1'), name: 'hadi', folder: '/work/repo', mode: 'interactive' });
  await world.host.tool('lessons_suggest', { rule: 'Use bun, not Python.', scope: 'global' }, { as: ferret('f1') });
  const [lesson] = json(await world.host.request('GET', '/v1/lessons/proposals', { as: owner() })) as { id: string }[];
  return { ...world, id: lesson?.id as string };
}

const declared = new Set<string>(manifest.actions.routes.map(route => route.key));

describe('the lessons routes', () => {
  test('R-0109 GET /v1/learning/status is GET /v1/lessons/status: enabled, pending counts, passive default', async () => {
    const { host } = await withLesson();
    const status = json(await host.request('GET', '/v1/lessons/status', { as: owner() }));
    expect(status).toMatchObject({ enabled: true, pending: { total: 1 }, passiveDefault: true });
  });

  test('R-0103 GET /v1/learning/config is GET /v1/lessons/config', async () => {
    const { host } = await lessonsHost();
    expect(json(await host.request('GET', '/v1/lessons/config', { as: owner() }))).toMatchObject({ agent: 'claude' });
  });

  test('R-0104 GET /v1/learning/proposals is GET /v1/lessons/proposals, narrowed by ?state', async () => {
    const { host } = await withLesson();
    expect(json(await host.request('GET', '/v1/lessons/proposals', { as: owner() }))).toHaveLength(1);
    const accepted = await host.request('GET', '/v1/lessons/proposals', { as: owner(), query: { state: 'accepted' } });
    expect(json(accepted)).toEqual([]);
    expect((await host.request('GET', '/v1/lessons/proposals', { as: owner(), query: { state: 'x' } })).status).toBe(
      400,
    );
  });

  test('R-0299 POST /v1/learning/proposals/:id is POST /v1/lessons/proposals/:id: a verdict writes no file', async () => {
    const { host, id } = await withLesson();
    const answer = await host.request('POST', `/v1/lessons/proposals/${id}`, {
      as: owner(),
      body: { action: 'accept' },
    });
    expect(answer.status).toBe(200);
    expect(json(answer).state).toBe('accepted');
    expect(host.state('lessons').raw({ path: 'global.json' } as never)).toBeUndefined();
  });

  test('R-0106 GET /v1/learning/proposals/:id/patch is GET /v1/lessons/proposals/:id/patch', async () => {
    const { host, id } = await withLesson();
    const patch = json(await host.request('GET', `/v1/lessons/proposals/${id}/patch`, { as: owner() }));
    expect(patch.contents).toContain('Use bun, not Python.');
  });

  test('R-0105 R-0300 apply-preview answers the diff and etag; apply writes exactly that, only with that etag', async () => {
    const { host, id } = await withLesson();
    await host.request('POST', `/v1/lessons/proposals/${id}`, { as: owner(), body: { action: 'accept' } });
    const preview = json(await host.request('GET', `/v1/lessons/proposals/${id}/apply-preview`, { as: owner() }));
    expect(preview.diff).toContain('+- Use bun, not Python.');
    const stale = await host.request('POST', `/v1/lessons/proposals/${id}/apply`, { as: owner(), body: { etag: 'x' } });
    expect(stale.status).toBe(409);
    const applied = await host.request('POST', `/v1/lessons/proposals/${id}/apply`, {
      as: owner(),
      body: { etag: preview.etag },
    });
    expect(applied.status).toBe(200);
    expect(json(applied).state).toBe('applied');
    const global = json(await host.request('GET', '/v1/lessons/global', { as: owner() }));
    expect(global.text).toContain('- Use bun, not Python.');
    // A ferret never applies: the route is a person's.
    const byFerret = await host.request('POST', `/v1/lessons/proposals/${id}/apply`, {
      as: ferret('f1'),
      body: { etag: preview.etag },
    });
    expect(byFerret.status).toBe(403);
  });

  test('R-0108 GET /v1/learning/sessions is GET /v1/lessons/ferrets: which ferrets are instructed', async () => {
    const { host, ferrets } = await lessonsHost();
    ferrets.add({ id: ferretId('f2'), name: 'kofi', folder: '/work/repo' });
    await host.request('PATCH', '/v1/ferrets/f2/lessons', { as: owner(), body: { passive: false } });
    const listed = json(await host.request('GET', '/v1/lessons/ferrets', { as: owner() }));
    expect(listed).toEqual([expect.objectContaining({ ferretId: 'f2', passive: false, setBy: 'owner' })]);
  });

  test('R-0228 PATCH /v1/sessions/:sessionId/learning is PATCH /v1/ferrets/:ferretId/lessons', async () => {
    const { host, ferrets } = await lessonsHost();
    ferrets.add({ id: ferretId('f2'), name: 'kofi', folder: '/work/repo', state: 'stopped' });
    const answer = json(
      await host.request('PATCH', '/v1/ferrets/f2/lessons', { as: owner(), body: { passive: true } }),
    );
    expect(answer.lessons).toMatchObject({ ferretId: 'f2', passive: true });
    expect(answer.reinstructed).toBe(false);
    expect(
      (await host.request('PATCH', '/v1/ferrets/nobody/lessons', { as: owner(), body: { passive: true } })).status,
    ).toBe(404);
  });

  test('R-0245 POST /v1/agent/lessons is POST /v1/lessons/suggest: the ferret is the credential’s, never the body’s', async () => {
    const { host, ferrets } = await lessonsHost();
    ferrets.add({ id: ferretId('f1'), name: 'hadi', folder: '/work/repo' });
    const filed = await host.request('POST', '/v1/lessons/suggest', {
      as: ferret('f1'),
      body: { tool: 'lessons.suggest', rule: 'Use bun.', scope: 'global' },
    });
    expect(filed.status).toBe(200);
    expect(json(filed).outcome).toBe('filed');
    const anonymousFiling = await host.request('POST', '/v1/lessons/suggest', {
      as: owner(),
      body: { tool: 'lessons.suggest', rule: 'Use bun.', scope: 'global' },
    });
    expect(anonymousFiling.status).toBe(403);
  });

  test('R-0301 POST /v1/learning/run is POST /v1/lessons/run: an ingest-only run answers its manifest', async () => {
    const { host } = await lessonsHost();
    const answer = await host.request('POST', '/v1/lessons/run', { as: owner(), body: { spawn: false } });
    expect(answer.status).toBe(200);
    expect(json(answer).minerFerrets).toEqual([]);
  });

  test('R-0304 POST /v1/learning/scan/estimate is POST /v1/lessons/scan/estimate: it spends nothing', async () => {
    const { host, ferrets } = await lessonsHost();
    ferrets.add({ id: ferretId('f1'), name: 'hadi', folder: '/work/repo', state: 'stopped' });
    const estimate = json(
      await host.request('POST', '/v1/lessons/scan/estimate', {
        as: owner(),
        body: { scope: { kind: 'not-passive' } },
      }),
    );
    // The fake conversation has no transcript for f1, so it is counted as skipped rather than read.
    expect(estimate.ferrets + estimate.skipped).toBe(1);
    expect(estimate.agent).toBe('claude');
    // Nothing to read means no miner and nothing to spend (today's `usd: 0` for zero miners).
    expect(estimate).toMatchObject({ miners: 0, usd: 0 });
    expect(ferrets.starts).toEqual([]);
  });

  test('R-0107 R-0303 GET /v1/lessons/scan reports no scan; cancel without one says so', async () => {
    const { host } = await lessonsHost();
    expect(json(await host.request('GET', '/v1/lessons/scan', { as: owner() }))).toEqual({});
    const cancel = await host.request('POST', '/v1/lessons/scan/cancel', { as: owner(), body: {} });
    expect(cancel.status).toBe(404);
  });

  test('every Lessons R row has its 5.0 route declared', () => {
    for (const key of [
      'GET /v1/lessons/config',
      'GET /v1/lessons/proposals',
      'GET /v1/lessons/proposals/:id/apply-preview',
      'GET /v1/lessons/proposals/:id/patch',
      'GET /v1/lessons/scan',
      'GET /v1/lessons/ferrets',
      'GET /v1/lessons/status',
      'PATCH /v1/lessons/config',
      'PATCH /v1/ferrets/:ferretId/lessons',
      'POST /v1/lessons/suggest',
      'POST /v1/lessons/proposals/:id',
      'POST /v1/lessons/proposals/:id/apply',
      'POST /v1/lessons/run',
      'POST /v1/lessons/scan',
      'POST /v1/lessons/scan/cancel',
      'POST /v1/lessons/scan/estimate',
    ])
      expect(declared.has(key)).toBe(true);
  });

  test('R-0222 PATCH /v1/learning/config is PATCH /v1/lessons/config: the switch is written into lessons.yaml by the kernel writer, comments kept', async () => {
    const real = realLessonsConfig();
    await real.handEdit('# how often the miner runs\nbatchSize: 5\n');
    const { host } = await lessonsHost({ realConfig: real });

    const answer = await host.request('PATCH', '/v1/lessons/config', { as: owner(), body: { passiveDefault: false } });

    expect(answer.status).toBe(200);
    expect(json(answer)).toMatchObject({ passiveDefault: false, batchSize: 5 });
    expect(json(answer).held).toBeUndefined();
    expect(json(await host.request('GET', '/v1/lessons/config', { as: owner() })).passiveDefault).toBe(false);
    const text = await real.text();
    expect(text).toContain('# how often the miner runs');
    expect(text).toContain('batchSize: 5');
    expect(text).toContain('passiveDefault: false');
  });

  test('R-0222 GAP (no owner both-versions write on 5.0, not parity) the owner flipping the switch while a hand edit naming a secret is held is refused 409, and nothing is lost', async () => {
    // Today the owner's save is made to both versions and is in effect at once; 5.0 refuses it instead of holding it.
    const real = realLessonsConfig();
    await real.handEdit('passiveDefault: true\n');
    // A hand edit that names a secret waits for the owner; the version before it stays in effect.
    const heldText = 'passiveDefault: true\nmodel: ${secret:MINER_MODEL}\n';
    await real.handEdit(heldText);
    expect(real.port.fileState(LESSONS_CONFIG)).toMatchObject({ state: 'held' });
    const { host } = await lessonsHost({ realConfig: real });

    const answer = await host.request('PATCH', '/v1/lessons/config', { as: owner(), body: { passiveDefault: false } });

    expect(answer.status).toBe(409);
    expect(json(answer)).toMatchObject({
      code: 'config_held',
      error: 'lessons.yaml has a change waiting for your approval; confirm or discard it first, then save again.',
    });
    expect(json(await host.request('GET', '/v1/lessons/config', { as: owner() })).passiveDefault).toBe(true);
    expect(await real.text()).toBe(heldText);
    expect(real.port.fileState(LESSONS_CONFIG)).toMatchObject({ state: 'held', inEffect: true });
  });

  test("R-0222 an owner save while a hand edit raising mining spend is held is refused 409 config_held: the held edit stays held and is never put into effect, even where Gate's judge would apply the owner's call", async () => {
    const real = realLessonsConfig({ judge: 'owner-at-machine' });
    await real.handEdit('maxMinersPerRun: 2\n');
    const heldText = 'maxMinersPerRun: 50\nminSpawnGapMinutes: 0\n';
    await real.handEdit(heldText);
    expect(real.port.fileState(LESSONS_CONFIG)).toMatchObject({ state: 'held', inEffect: true });
    const { host } = await lessonsHost({ realConfig: real });

    const answer = await host.request('PATCH', '/v1/lessons/config', { as: owner(), body: { passiveDefault: false } });

    expect(answer.status).toBe(409);
    expect(json(answer)).toMatchObject({ code: 'config_held' });
    expect(await real.text()).toBe(heldText);
    expect(real.port.fileState(LESSONS_CONFIG)).toMatchObject({ state: 'held', inEffect: true });
    expect(json(await host.request('GET', '/v1/lessons/config', { as: owner() }))).toMatchObject({
      passiveDefault: true,
      maxMinersPerRun: 2,
      minSpawnGapMinutes: 30,
    });
  });

  test("R-0222 an owner save over a BROKEN lessons.yaml writes the whole settings in effect plus the switch, so a spend raise planted beside the broken value is overwritten and never put into effect, even where Gate's judge would apply the owner's call", async () => {
    // Today's `writePassiveDefault` renders the WHOLE settings in effect plus `passiveDefault`; patching only the switch
    // over the disk text would repair the file and carry every other key on it into effect with the owner's save.
    const real = realLessonsConfig({ judge: 'owner-at-machine' });
    await real.handEdit('# the owner keeps notes here\nmaxMinersPerRun: 2\n');
    await real.handEdit(
      '# the owner keeps notes here\npassiveDefault: 7\nmaxMinersPerRun: 50\nminSpawnGapMinutes: 0\n',
    );
    expect(real.port.fileState(LESSONS_CONFIG)).toMatchObject({ state: 'invalid', inEffect: true });
    const { host } = await lessonsHost({ realConfig: real });

    const answer = await host.request('PATCH', '/v1/lessons/config', { as: owner(), body: { passiveDefault: false } });

    expect(answer.status).toBe(200);
    expect(json(answer).held).toBeUndefined();
    expect(json(answer)).toMatchObject({ passiveDefault: false, maxMinersPerRun: 2, minSpawnGapMinutes: 30 });
    expect(json(await host.request('GET', '/v1/lessons/config', { as: owner() }))).toMatchObject({
      passiveDefault: false,
      maxMinersPerRun: 2,
      minSpawnGapMinutes: 30,
    });
    expect(real.port.fileState(LESSONS_CONFIG)).toMatchObject({ state: 'valid' });
    expect(real.port.file(LESSONS_CONFIG)).toEqual({ maxMinersPerRun: 2, passiveDefault: false });
    const text = await real.text();
    expect(text).toContain('# the owner keeps notes here');
    expect(text).not.toContain('50');
    expect(text).not.toContain('minSpawnGapMinutes');
    // A default nobody stated is not written in.
    expect(text).not.toContain('enabled');
  });

  test('R-0222 a raw secret typed into the switch is refused, and an owner save over a lessons.yaml holding one overwrites it with the settings in effect; the value is never echoed', async () => {
    const pasted = ['gh', 'p_', 'Q7'.repeat(14)].join('');
    const real = realLessonsConfig();
    await real.handEdit('passiveDefault: true\n');
    await real.handEdit(`passiveDefault: true\nmodel: ${pasted}\n`);
    expect(real.port.fileState(LESSONS_CONFIG)).toMatchObject({ state: 'invalid', inEffect: true });
    const { host } = await lessonsHost({ realConfig: real });

    const typed = await host.request('PATCH', '/v1/lessons/config', { as: owner(), body: { passiveDefault: pasted } });

    expect(typed.status).toBe(400);
    expect(typed.body).not.toContain(pasted);
    expect(await real.text()).toBe(`passiveDefault: true\nmodel: ${pasted}\n`);

    // Today's save renders the whole settings in effect, which state no `model`: the pasted value is written out.
    const answer = await host.request('PATCH', '/v1/lessons/config', { as: owner(), body: { passiveDefault: false } });

    expect(answer.status).toBe(200);
    expect(answer.body).not.toContain(pasted);
    expect(await real.text()).not.toContain(pasted);
    expect(real.port.file(LESSONS_CONFIG)).toEqual({ passiveDefault: false });
    expect(real.port.fileState(LESSONS_CONFIG)).toMatchObject({ state: 'valid' });
    expect(json(await host.request('GET', '/v1/lessons/config', { as: owner() })).passiveDefault).toBe(false);
  });

  test('R-0222 a ferret cannot change the machine default: 403 and lessons.yaml unchanged', async () => {
    const real = realLessonsConfig();
    await real.handEdit('passiveDefault: true\n');
    const { host } = await lessonsHost({ realConfig: real });

    const answer = await host.request('PATCH', '/v1/lessons/config', {
      as: ferret('f1'),
      body: { passiveDefault: false },
    });

    expect(manifest.actions.routes.find(route => route.key === 'PATCH /v1/lessons/config')).toMatchObject({
      minimum: 'operator',
      caller: 'person',
    });
    expect(answer.status).toBe(403);
    expect(await real.text()).toBe('passiveDefault: true\n');
    expect(json(await host.request('GET', '/v1/lessons/config', { as: owner() })).passiveDefault).toBe(true);
  });

  test.skip('R-0302 POST /v1/lessons/scan starts miners … pending port: Ferrets start work folder (D2 #19)', () => {});
});
