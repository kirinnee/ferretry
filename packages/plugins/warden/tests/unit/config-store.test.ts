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

  it('should refuse, in a sentence, a save naming nothing while warden.yaml holds an edit, and write nothing', async () => {
    // Arrange
    const { port, writes } = portWithDoor({ fileHeld: true });
    const store = new ConfigWardenConfigStore(port);

    // Act
    const saving = store.write(anyConfig, {} as WardenConfigPatch);

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

describe('an owner’s save while warden.yaml holds another edit (docs/config-files.md rule 3)', () => {
  /** A port whose file holds an edit for the owner; `writeAsOwner` answers `result` and records what it was sent. */
  const heldPort = (result: ConfigWriteOutcome) => {
    const owner: unknown[] = [];
    const plain: unknown[] = [];
    const port = {
      file: () => ({ enabled: true }),
      fileState: () => ({ state: 'held', inEffect: true, sentences: ['a bigger daily cap'] }),
      write: async (_def: unknown, _name: unknown, edit: ConfigEdit) => {
        plain.push(edit);
        return written;
      },
      writeAsOwner: async (
        _def: unknown,
        name: unknown,
        edit: { readonly patch: unknown; readonly within?: readonly string[] },
      ) => {
        owner.push({ name, patch: edit.patch, ...(edit.within === undefined ? {} : { within: edit.within }) });
        return result;
      },
    } as unknown as ConfigPort;
    return { store: new ConfigWardenConfigStore(port), owner, plain };
  };

  it('should make a top-level save to BOTH versions through writeAsOwner, sending only the keys the owner changed', async () => {
    const { store, owner, plain } = heldPort({
      kind: 'written',
      etag: 'e2',
      loosened: [],
      stillHeld: { id: 'warden.yaml@e2', sentences: ['a bigger daily cap'] },
    });

    const waiting = await store.write({ ...DEFAULT_WARDEN_CONFIG, enabled: false, intervalMinutes: 5 }, {
      enabled: false,
      intervalMinutes: 5,
    } as WardenConfigPatch);

    // In effect at once: the held edit rode along and still waits, so nothing of THIS save is said to wait.
    should(waiting).eql([]);
    should(owner).eql([{ name: undefined, patch: { enabled: false, intervalMinutes: 5 } }]);
    should(plain).have.length(0);
  });

  it('should answer what waits when the owner’s own patch loosens and the judge holds it with the held edit', async () => {
    const { store } = heldPort({
      kind: 'held',
      etag: 'e3',
      id: 'warden.yaml@e3',
      sentences: ['the warden is switched on'],
    });

    should(await store.write({ ...DEFAULT_WARDEN_CONFIG, enabled: true }, { enabled: true } as WardenConfigPatch)).eql([
      'the warden is switched on',
    ]);
  });

  it('should tell the owner to save again when the file moved since the kernel last read it', async () => {
    const { store } = heldPort({ kind: 'conflict' });

    await store.write(DEFAULT_WARDEN_CONFIG, { enabled: false } as WardenConfigPatch).then(
      () => should.fail('', '', 'should have been refused'),
      (error: unknown) => should(error).be.instanceOf(WardenConfigMoved),
    );
  });

  it('should make a section save to BOTH versions, sending only the sub-keys it changed and naming the section in within', async () => {
    const { store, owner, plain } = heldPort({
      kind: 'written',
      etag: 'e4',
      loosened: [],
      stillHeld: { id: 'warden.yaml@e4', sentences: ['a bigger daily cap'] },
    });
    const next = {
      ...DEFAULT_WARDEN_CONFIG,
      enabled: false,
      caps: { ...DEFAULT_WARDEN_CONFIG.caps, investigationUsdPerDay: 1 },
    };

    const waiting = await store.write(next, {
      enabled: false,
      caps: { investigationUsdPerDay: 1 },
    } as WardenConfigPatch);

    // The section merges one level deep, so the held version keeps every caps sub-key this save did not name.
    should(waiting).eql([]);
    should(owner).eql([
      { name: undefined, patch: { enabled: false, caps: { investigationUsdPerDay: 1 } }, within: ['caps'] },
    ]);
    should(plain).have.length(0);
  });

  it('should refuse a save naming no key, writing nothing to either version', async () => {
    const { store, owner, plain } = heldPort({ kind: 'written', etag: 'e', loosened: [] });

    await store.write(DEFAULT_WARDEN_CONFIG, {} as WardenConfigPatch).then(
      () => should.fail('', '', 'should have been refused'),
      (error: unknown) => should(error).be.instanceOf(WardenConfigHeld),
    );
    should(owner).have.length(0);
    should(plain).have.length(0);
  });
});
