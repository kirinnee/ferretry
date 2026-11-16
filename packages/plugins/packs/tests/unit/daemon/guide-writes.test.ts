import { describe, expect, test } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { PackRoutingWriteResultSchema, PackViewSchema } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';

/**
 * `fy guide accept` and `fy guide undo` over a fixture daemon (V-0273, V-0277): the routing prompt is written through
 * the kernel's config writer (the one behind `PUT /v1/config/file`), so an accept lands in `packs.yaml`, the next read
 * sees it, and ONE undo puts the replaced prompt back.
 */
const SUGGESTED = { by: 'a model', via: 'a runtime', mode: 'clean-up', at: '2026-11-07T10:00:00.000Z' } as const;
const PROMPT = 'Planning and review: opus at max. Chores: haiku.';

async function host(config?: Record<string, unknown>) {
  const ferrets = new FakeFerrets();
  return await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { ferrets },
    ...(config === undefined ? {} : { config }),
  });
}

describe('guide accept and undo through the configuration writer', () => {
  test('V-0273 accept writes the checked prompt into packs.yaml, and the next read shows it with where it came from', async () => {
    const h = await host({ 'packs.yaml': { enabled: false, routing: { prompt: 'Opus for everything I do.' } } });

    const accepted = await h.request('POST', '/v1/pack/routing/accept', {
      body: { prompt: PROMPT, suggested: SUGGESTED },
    });

    expect(accepted.status).toBe(200);
    const result = PackRoutingWriteResultSchema.parse(accepted.json());
    expect(result.outcome).toBe('applied');
    expect(result.message).toBe('The routing prompt is the one a model cleaned up. Undo puts the previous one back.');
    const view = PackViewSchema.parse((await h.request('GET', '/v1/pack')).json());
    expect(view.routing.text).toBe(PROMPT);
    expect(view.routing.source).toBe('file');
    expect(view.routing.suggested?.by).toBe('a model');
    expect(view.undo?.source).toBe('file');
    // The rest of the file is kept as it was.
    expect(view.config.enabled).toBe(false);
    await h.stop();
  });

  test('V-0277 undo puts the prompt the accept replaced back, and one undo is all there is', async () => {
    const h = await host({ 'packs.yaml': { routing: { prompt: 'Opus for everything I do.' } } });
    await h.request('POST', '/v1/pack/routing/accept', { body: { prompt: PROMPT, suggested: SUGGESTED } });

    const undone = await h.request('POST', '/v1/pack/routing/undo', { body: {} });

    expect(undone.status).toBe(200);
    expect(PackRoutingWriteResultSchema.parse(undone.json())).toEqual({
      outcome: 'applied',
      message: 'Undone: the routing prompt you had before is back.',
    });
    const view = PackViewSchema.parse((await h.request('GET', '/v1/pack')).json());
    expect(view.routing.text).toBe('Opus for everything I do.');
    expect(view.routing.suggested).toBeUndefined();
    expect(view.undo).toBeUndefined();
    const again = await h.request('POST', '/v1/pack/routing/undo', { body: {} });
    expect(PackRoutingWriteResultSchema.parse(again.json())).toEqual({
      outcome: 'nothing',
      message: 'There is no accepted clean-up to undo.',
    });
    await h.stop();
  });

  test('V-0277 undoing an accept that replaced no prompt of the owner’s brings the default back', async () => {
    const h = await host();
    await h.request('POST', '/v1/pack/routing/accept', { body: { prompt: PROMPT, suggested: SUGGESTED } });

    const undone = await h.request('POST', '/v1/pack/routing/undo', { body: {} });

    expect(PackRoutingWriteResultSchema.parse(undone.json()).message).toBe(
      'Undone: the default routing prompt, built from the model catalogs, is in effect again.',
    );
    const view = PackViewSchema.parse((await h.request('GET', '/v1/pack')).json());
    expect(view.routing.source).toBe('default');
    await h.stop();
  });

  test('a write the owner has to confirm is reported as held, changes nothing in effect and keeps no undo', async () => {
    const h = await host({ 'packs.yaml': { routing: { prompt: 'Opus for everything I do.' } } });

    // A prompt that names a secret is not the routing prompt's to widen: the writer holds it for the owner.
    const accepted = await h.request('POST', '/v1/pack/routing/accept', {
      body: { prompt: 'Use ${secret:ROUTING_NOTE} for planning.', suggested: SUGGESTED },
    });

    expect(accepted.status).toBe(200);
    const result = PackRoutingWriteResultSchema.parse(accepted.json());
    expect(result.outcome).toBe('held');
    expect(result.message).toContain('waits for you to confirm it');
    const view = PackViewSchema.parse((await h.request('GET', '/v1/pack')).json());
    expect(view.routing.text).toBe('Opus for everything I do.');
    expect(view.undo).toBeUndefined();
    await h.stop();
  });
});
