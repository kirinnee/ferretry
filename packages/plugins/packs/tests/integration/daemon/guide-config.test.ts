import { describe, expect, test } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { ApiError } from '@ferretry/kernel/contract';
import type { ConfigPort } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { PACKS_CONFIG } from '../../../contract/index.ts';
import { ConfigGuideWriter } from '../../../daemon/adapters/guide-config.ts';
import manifest from '../../../manifest.ts';

/**
 * `ConfigGuideWriter` over the kernel's real config writer (a booted test host, files in memory): what a write that
 * the writer refuses, or that raced a save, says to the person — and leaves in the file.
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

const failureOf = async (work: Promise<unknown>): Promise<ApiError> => {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
};

describe('ConfigGuideWriter over the kernel config writer', () => {
  test('reads the file as in effect with its etag, and an empty file as an empty document', async () => {
    const { host, writer } = await world();
    expect((await writer.read()).file).toEqual({});
    await host.stop();
  });

  test('a write against an etag from before the file moved says nothing was saved, and the file is untouched', async () => {
    const { host, config, writer } = await world({ 'packs.yaml': { enabled: false } });

    const refused = await failureOf(writer.write({ prompt: 'Opus for planning.' }, 'an-etag-from-before'));

    expect([refused.status, refused.code]).toEqual([409, 'conflict']);
    expect(refused.message).toBe('packs.yaml changed since it was last read; nothing was saved. Try again.');
    expect(config.file(PACKS_CONFIG)).toEqual({ enabled: false });
    await host.stop();
  });

  test('a section the writer refuses is answered with its reason, and never half written', async () => {
    const { host, config, writer } = await world();

    const refused = await failureOf(writer.write({ prompt: '' }, (await writer.read()).etag));

    expect([refused.status, refused.code]).toEqual([400, 'invalid_request']);
    expect(refused.message).toStartWith('packs.yaml was not changed: ');
    expect(refused.message.length).toBeGreaterThan('packs.yaml was not changed: '.length);
    expect(config.file(PACKS_CONFIG)).toBeUndefined();
    await host.stop();
  });

  test('a write that loosens is held for the owner with what waits, and the tighter file stays in effect', async () => {
    const { host, config, writer } = await world({ 'packs.yaml': { routing: { prompt: 'Opus.' } } });

    const held = await writer.write({ prompt: 'Use ${secret:ROUTING_NOTE}.' }, (await writer.read()).etag);

    expect(held.kind).toBe('held');
    expect(config.file(PACKS_CONFIG)).toEqual({ routing: { prompt: 'Opus.' } });
    await host.stop();
  });

  test('writes the routing section whole and leaves every other key as it is', async () => {
    const { host, config, writer } = await world({ 'packs.yaml': { enabled: false } });

    expect(await writer.write({ prompt: 'Opus for planning.' }, (await writer.read()).etag)).toEqual({
      kind: 'written',
    });
    expect(config.file(PACKS_CONFIG)).toEqual({ enabled: false, routing: { prompt: 'Opus for planning.' } });
    await host.stop();
  });
});
