import { describe, it } from 'bun:test';
import should from 'should';
import type { ConfigEdit, ConfigPort, ConfigWriteOutcome } from '@ferretry/kernel/contract';
import { DEFAULT_WARDEN_CONFIG } from '../../contract/index.ts';
import {
  ConfigWardenConfigStore,
  WardenConfigHeld,
  WardenConfigMoved,
  WardenConfigRefused,
} from '../../daemon/adapters/config-store.ts';
import type { WardenConfig, WardenConfigPatch } from '../../daemon/lib/index.ts';

const written: ConfigWriteOutcome = { kind: 'written', etag: 'e', loosened: [] };
const held = (sentence: string): ConfigWriteOutcome => ({
  kind: 'held',
  etag: 'e',
  id: 'warden.yaml@e',
  sentences: [sentence],
});

/** A config port whose kernel write answers each write when the test says so; `fileHeld` makes the file hold an edit. */
function portWithDoor(options: { readonly fileHeld?: boolean } = {}): {
  readonly port: ConfigPort;
  readonly answer: (index: number, result: ConfigWriteOutcome) => void;
  readonly writes: () => number;
} {
  const pending: ((result: ConfigWriteOutcome) => void)[] = [];
  const door = {
    file: () => undefined,
    collection: () => new Map(),
    watch: () => () => undefined,
    fileState: () =>
      options.fileHeld === true
        ? { state: 'held', inEffect: true, sentences: ['the warden is switched on'] }
        : { state: 'valid', inEffect: true, sentences: [] },
    write: async (_def: unknown, _name: unknown, _edit: ConfigEdit): Promise<ConfigWriteOutcome> =>
      await new Promise<ConfigWriteOutcome>(resolve => {
        pending.push(resolve);
      }),
    remove: async (): Promise<ConfigWriteOutcome> => written,
  };
  return {
    port: door as unknown as ConfigPort,
    answer: (index, result) => pending[index]?.(result),
    writes: () => pending.length,
  };
}

const anyConfig = {} as WardenConfig;

describe('warden.yaml changes in flight', () => {
  it('should answer two overlapping changes each with its own held sentences', async () => {
    // Arrange
    const { port, answer } = portWithDoor();
    const store = new ConfigWardenConfigStore(port);

    // Act: the loosening is written first and answered last; the plain change finishes in between
    const loosening = store.write(anyConfig, { caps: { llmDaily: 50 } } as WardenConfigPatch);
    const plain = store.write(anyConfig, { enabled: false } as WardenConfigPatch);
    await Promise.resolve();
    answer(1, written);
    const plainHeld = await plain;
    answer(0, held('a bigger daily cap waits for you'));
    const looseningHeld = await loosening;

    // Assert
    should(plainHeld).eql([]);
    should(looseningHeld).eql(['a bigger daily cap waits for you']);
  });

  it('should answer a change the door held after a later one was put into effect', async () => {
    // Arrange
    const { port, answer } = portWithDoor();
    const store = new ConfigWardenConfigStore(port);

    // Act: the held change finishes FIRST, then a plain one; the first caller still reads its own answer
    const loosening = store.write(anyConfig, { caps: { llmDaily: 50 } } as WardenConfigPatch);
    await Promise.resolve();
    answer(0, held('a bigger daily cap waits for you'));
    const plain = store.write(anyConfig, { enabled: false } as WardenConfigPatch);
    await Promise.resolve();
    answer(1, written);

    // Assert
    should(await loosening).eql(['a bigger daily cap waits for you']);
    should(await plain).eql([]);
  });

  it('should refuse a save while warden.yaml holds an edit for the owner, and write nothing', async () => {
    // Arrange
    const { port, writes } = portWithDoor({ fileHeld: true });
    const store = new ConfigWardenConfigStore(port);

    // Act
    const saving = store.write(anyConfig, { caps: { investigationUsdPerDay: 1 } } as WardenConfigPatch);

    // Assert
    await saving.then(
      () => should.fail('', '', 'should have been refused'),
      (error: unknown) => {
        should(error).be.instanceOf(WardenConfigHeld);
        should((error as Error).message).equal(
          'warden.yaml has a change waiting for your approval; confirm or discard it first, then save again.',
        );
      },
    );
    should(writes()).equal(0);
  });
});

describe('warden.yaml refused or moved by the kernel', () => {
  const storeAnswering = (result: unknown) => {
    const port = {
      file: () => undefined,
      fileState: () => ({ state: 'valid', inEffect: true, sentences: [] }),
      write: async () => result,
    } as unknown as ConfigPort;
    return new ConfigWardenConfigStore(port);
  };

  it('should say the kernel’s issues when it refuses the save, or its reason when it names none', async () => {
    const issues = storeAnswering({ kind: 'refused', reason: 'invalid', issues: [{ message: 'a' }, { message: 'b' }] });
    const bare = storeAnswering({ kind: 'refused', reason: 'a raw secret', issues: [] });

    await issues.write(anyConfig, {} as WardenConfigPatch).then(
      () => should.fail('', '', 'should have been refused'),
      (error: unknown) => {
        should(error).be.instanceOf(WardenConfigRefused);
        should((error as Error).message).equal('a; b');
      },
    );
    await bare.write(anyConfig, {} as WardenConfigPatch).then(
      () => should.fail('', '', 'should have been refused'),
      (error: unknown) => should((error as Error).message).equal('a raw secret'),
    );
  });

  it('should tell the owner to save again when the file moved since the kernel last read it', async () => {
    await storeAnswering({ kind: 'conflict' })
      .write(anyConfig, {} as WardenConfigPatch)
      .then(
        () => should.fail('', '', 'should have been refused'),
        (error: unknown) => should(error).be.instanceOf(WardenConfigMoved),
      );
  });

  it('should write the whole settings, naming only a key the owner changed from its default', async () => {
    const sent: unknown[] = [];
    const port = {
      file: () => undefined,
      fileState: () => ({ state: 'valid', inEffect: true, sentences: [] }),
      write: async (_def: unknown, _name: unknown, edit: { patch: unknown }) => {
        sent.push(edit.patch);
        return written;
      },
    } as unknown as ConfigPort;

    await new ConfigWardenConfigStore(port).write(
      { ...DEFAULT_WARDEN_CONFIG, enabled: false, accounts: [{ agent: 'a' }] },
      {} as WardenConfigPatch,
    );

    const patch = sent[0] as Record<string, unknown>;
    should(patch.enabled).equal(false);
    should(patch.accounts).eql([{ agent: 'a' }]);
    should(patch.intervalMinutes).be.undefined();
  });
});

describe('warden.yaml as read', () => {
  const storeHolding = (file: unknown) => new ConfigWardenConfigStore({ file: () => file } as unknown as ConfigPort);

  it('should read the defaults for a missing file, and the file’s keys laid over them', async () => {
    should(await storeHolding(undefined).read()).eql(DEFAULT_WARDEN_CONFIG);
    const read = (await storeHolding({ enabled: false }).read()) as { enabled: boolean; intervalMinutes: number };
    should(read.enabled).equal(false);
    should(read.intervalMinutes).equal(DEFAULT_WARDEN_CONFIG.intervalMinutes);
  });
});
