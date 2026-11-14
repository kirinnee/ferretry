import { describe, expect, test } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { ApiError, defineConfig } from '@ferretry/kernel/contract';
import type { ConfigPort } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { z } from 'zod';
import { PACKS_CONFIG } from '../../../contract/index.ts';
import { ConfigGuideWriter } from '../../../daemon/adapters/guide-config.ts';
import manifest from '../../../manifest.ts';

/**
 * The port Accept and Undo write through is the kernel's config writer — the one behind `PUT /v1/config/file`, so
 * Gate's per-file rules apply unchanged. These prove what the Packs side adds to it: a stale etag is refused, a held
 * write is reported as held, and it can write nothing but Packs' own file, nor widen what the route would hold.
 */
async function world(config?: Record<string, unknown>) {
  let port: ConfigPort | undefined;
  const half = implementDaemon(manifest, {
    build: ({ kernel }) => {
      port = kernel.config;
      // Only the config port is wanted here; the test calls no route.
      return { routes: {} } as never;
    },
  });
  const host = await testHost({
    plugins: [half],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { ferrets: new FakeFerrets() },
    ...(config === undefined ? {} : { config }),
  });
  if (port === undefined) throw new Error('the half was not built');
  return { host, config: port, writer: new ConfigGuideWriter(port) };
}

describe('ConfigGuideWriter', () => {
  test('writes the routing section through the kernel writer against the etag it was read at', async () => {
    const { host, config, writer } = await world({ 'packs.yaml': { enabled: false } });
    const etag = await writer.etag();

    const written = await writer.write({ prompt: 'Opus for planning.' }, etag);

    expect(written).toEqual({ kind: 'written' });
    expect(config.file(PACKS_CONFIG)).toEqual({ enabled: false, routing: { prompt: 'Opus for planning.' } });
    await host.stop();
  });

  test('a stale etag is refused, with a sentence saying nothing was saved, and the file is untouched', async () => {
    const { host, config, writer } = await world({ 'packs.yaml': { enabled: false } });

    const refused = await writer
      .write({ prompt: 'Opus for planning.' }, 'etag-from-before-the-file-moved')
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(409);
    expect((refused as ApiError).code).toBe('conflict');
    expect((refused as ApiError).message).toBe(
      'packs.yaml changed since it was last read; nothing was saved. Try again.',
    );
    expect(config.file(PACKS_CONFIG)).toEqual({ enabled: false });
    await host.stop();
  });

  test('a prompt the writer does not accept is refused with its reason, never half written', async () => {
    const { host, config, writer } = await world();

    const refused = await writer.write({ prompt: '' }, await writer.etag()).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(400);
    expect((refused as ApiError).code).toBe('invalid_request');
    expect(config.file(PACKS_CONFIG)).toBeUndefined();
    await host.stop();
  });

  test('a write the owner must confirm is answered held, with what waits, and stays out of effect', async () => {
    const { host, config, writer } = await world({ 'packs.yaml': { routing: { prompt: 'Opus.' } } });

    const held = await writer.write({ prompt: 'Use ${secret:ROUTING_NOTE}.' }, await writer.etag());

    expect(held.kind).toBe('held');
    expect(config.file(PACKS_CONFIG)).toEqual({ routing: { prompt: 'Opus.' } });
    await host.stop();
  });

  test('beside an edit already held for the owner, a routing write never puts that edit into effect', async () => {
    const { host, config, writer } = await world({ 'packs.yaml': { enabled: false } });
    // The edit that loosens waits for the owner: Pack mode switched on.
    const loosening = await config.write(PACKS_CONFIG, undefined, { patch: { enabled: true } });
    expect(loosening.kind).toBe('held');

    const written = await writer.write({ prompt: 'Opus for planning.' }, await config.etag(PACKS_CONFIG));

    expect(written.kind).toBe('written');
    expect(config.file(PACKS_CONFIG)).toEqual({ enabled: false, routing: { prompt: 'Opus for planning.' } });
    expect(config.fileState(PACKS_CONFIG).state).toBe('held');
    await host.stop();
  });

  test('the port is not a way round Gate: a loosening is held as the route holds it, and no other plugin’s file is writable', async () => {
    const { host, config } = await world({ 'packs.yaml': { enabled: false } });
    const foreign = defineConfig({
      file: 'someone-else.yaml',
      schema: z.strictObject({}),
      axis: 'configure',
      loosens: () => [],
    });

    const loosening = await config.write(PACKS_CONFIG, undefined, { patch: { enabled: true } });
    const elsewhere = await config.write(foreign, undefined, { patch: {} });

    expect(loosening.kind).toBe('held');
    expect(config.file(PACKS_CONFIG)).toEqual({ enabled: false });
    expect(elsewhere).toEqual({ kind: 'refused', reason: 'not_declared', issues: [] });
    await host.stop();
  });
});
