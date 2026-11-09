/**
 * A change's Runtimes documents land ALL OR NONE through the kernel's `ConfigPort.writeAll`, over the testing host
 * (the kernel's real rules: per-document `ifMatch`, the same judge, the whole set held when one document would be).
 * A document another part of Ferretry owns is refused in a sentence, never written and never dropped.
 */
import { afterEach, describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { ConfigCollectionDef, KernelPorts } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import { fakeLoginChanges, fakeLogins } from '@ferretry/plugin-logins/contract/testing';
import should from 'should';
import { PROFILE_ITEMS, RUNTIME_ITEMS } from '../../../contract/index.ts';
import { writeAllConfigWriter } from '../../../daemon/adapters/config-write-all.ts';
import { runtimesDaemon, unavailableAssembly } from '../../../daemon/index.ts';
import { ConfigWriteConflict, ConfigWriteInvalid } from '../../../daemon/lib/service/ports.ts';

const CONFIG = '/fy/config';
const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const RUNTIME = 'login: claude-you\nprofile: p\n';
const PROFILE = 'contents: []\n';

const stoppers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stoppers.splice(0)) await stop();
});

async function world(files: Record<string, unknown> = {}) {
  const seen: { kernel?: KernelPorts } = {};
  const host = await testHost({
    plugins: [
      runtimesDaemon(ctx => {
        seen.kernel = ctx.kernel;
        return unavailableAssembly(ctx);
      }),
    ] as never,
    fakes: { ferrets: new FakeFerrets(), logins: fakeLogins([]), loginChanges: fakeLoginChanges() },
    gate: new StandInAdmission(() => ownerStanding()),
    config: files,
  });
  stoppers.push(async () => await host.stop());
  const kernel = seen.kernel as KernelPorts;
  return { kernel, writer: writeAllConfigWriter(kernel.config, CONFIG) };
}

// A new file is written with no `expect`: the testing host's etag of an absent collection item is not the real
// kernel's `'absent'`, so a create is not pinned here (the pin is proved on an existing file below).
const doc = (relative: string, content: string, expect?: string) => ({
  path: `${CONFIG}/${relative}`,
  content,
  mode: 0o600,
  ...(expect === undefined ? {} : { expect }),
});

describe('the Runtimes config writer over ConfigPort.writeAll', () => {
  it('should write a runtime and its profile together', async () => {
    // Arrange
    const { kernel, writer } = await world();

    // Act
    await writer.write([doc('profiles/p.yaml', PROFILE), doc('runtimes/r.yaml', RUNTIME)]);

    // Assert
    should([...kernel.config.collection(PROFILE_ITEMS as unknown as ConfigCollectionDef<unknown>).keys()]).deepEqual([
      'p',
    ]);
    should([...kernel.config.collection(RUNTIME_ITEMS as unknown as ConfigCollectionDef<unknown>).keys()]).deepEqual([
      'r',
    ]);
  });

  it('should write none of the set when one document moved since it was read', async () => {
    // Arrange — runtimes/r.yaml exists, and the change was composed against another text.
    const { kernel, writer } = await world({ runtimes: { r: { login: 'claude-you', profile: 'p' } } });

    // Act + Assert
    await should(
      writer.write([doc('profiles/p.yaml', PROFILE), doc('runtimes/r.yaml', RUNTIME, digest('stale'))]),
    ).be.rejectedWith(ConfigWriteConflict);
    should([...kernel.config.collection(PROFILE_ITEMS as unknown as ConfigCollectionDef<unknown>).keys()]).deepEqual(
      [],
    );
  });

  it('should refuse a document another part of Ferretry owns, writing nothing', async () => {
    // Arrange
    const { kernel, writer } = await world();

    // Act + Assert
    const refusal = await writer
      .write([doc('profiles/p.yaml', PROFILE), doc('logins/claude-you.yaml', 'store: host\n')])
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    should(refusal).be.instanceOf(ConfigWriteInvalid);
    should((refusal as Error).message).containEql('logins/claude-you.yaml');
    should([...kernel.config.collection(PROFILE_ITEMS as unknown as ConfigCollectionDef<unknown>).keys()]).deepEqual(
      [],
    );
  });

  it('should refuse a path outside the configuration directory', async () => {
    // Arrange
    const { writer } = await world();

    // Act + Assert
    await should(writer.write([{ path: '/etc/runtimes/r.yaml', content: RUNTIME, mode: 0o600 }])).be.rejectedWith(
      ConfigWriteInvalid,
    );
  });

  it('should refuse a document that does not check against its schema, writing nothing', async () => {
    // Arrange
    const { kernel, writer } = await world();

    // Act + Assert
    await should(
      writer.write([doc('profiles/p.yaml', PROFILE), doc('runtimes/r.yaml', 'login: [not, a, login]\n')]),
    ).be.rejectedWith(ConfigWriteInvalid);
    should([...kernel.config.collection(PROFILE_ITEMS as unknown as ConfigCollectionDef<unknown>).keys()]).deepEqual(
      [],
    );
  });

  it('should hold the WHOLE set, writing nothing, when one document is a removal the judge would hold', async () => {
    // Arrange — removing a runtime file is judged like a loosening; the new profile beside it must not land alone.
    const { kernel, writer } = await world({ runtimes: { r: { login: 'claude-you', profile: 'p' } } });

    // Act
    const refusal = await writer
      .write([
        doc('profiles/p.yaml', PROFILE),
        { path: `${CONFIG}/runtimes/r.yaml`, content: '', mode: 0o600, remove: true },
      ])
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // Assert
    should(refusal).be.instanceOf(ConfigWriteInvalid);
    should((refusal as Error).message).containEql('the whole set is held');
    should([...kernel.config.collection(PROFILE_ITEMS as unknown as ConfigCollectionDef<unknown>).keys()]).deepEqual(
      [],
    );
    should([...kernel.config.collection(RUNTIME_ITEMS as unknown as ConfigCollectionDef<unknown>).keys()]).deepEqual([
      'r',
    ]);
  });

  it('should do nothing for an empty change', async () => {
    const { writer } = await world();
    await writer.write([]);
  });
});
