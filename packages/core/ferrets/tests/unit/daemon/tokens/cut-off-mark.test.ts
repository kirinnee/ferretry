import { describe, expect, test } from 'bun:test';
import {
  CoupledCapabilityHashStore,
  DirectoryCutOff,
  type TokenCutOff,
} from '../../../../daemon/lib/tokens/cut-off-mark.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';
import { T0 } from '../../../../contract/testing/index.ts';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';

const ID = parseSessionId('mw7bp88g-50e00159');

/** The document's half of the hash store, recording every call in order, shared with the directory's half. */
function halves(log: string[]) {
  const document = new Set<string>();
  const directory = new Set<string>();
  const inner = {
    record: async (_id: string, hash: string) => void log.push(`record ${hash}`),
    erase: async () => void log.push('erase'),
    cutOff: async (id: string) => {
      log.push('document cutOff');
      document.add(id);
    },
    isCutOff: async (id: string) => document.has(id),
    restore: async (id: string) => {
      log.push('document restore');
      document.delete(id);
    },
  };
  const tokens: TokenCutOff = {
    isCutOff: async id => directory.has(id),
    cutOff: async id => {
      log.push('directory cutOff');
      directory.add(id);
    },
    restore: async id => {
      log.push('directory restore');
      directory.delete(id);
    },
  };
  return { document, directory, inner, tokens, subject: new CoupledCapabilityHashStore(inner, tokens) };
}

describe('the lifecycle hash store kept in step with the token directory', () => {
  test('should pass a recorded hash and an erase straight to the document store', async () => {
    // Arrange
    const log: string[] = [];
    const { subject } = halves(log);

    // Act
    await subject.record(ID, 'a'.repeat(64));
    await subject.erase(ID);

    // Assert
    expect(log).toEqual([`record ${'a'.repeat(64)}`, 'erase']);
  });

  test('should write the document first and then the directory when a ferret is cut off', async () => {
    // Arrange
    const log: string[] = [];
    const { subject, document, directory } = halves(log);

    // Act
    await subject.cutOff(ID);

    // Assert
    expect(log).toEqual(['document cutOff', 'directory cutOff']);
    expect(document.has(ID)).toBe(true);
    expect(directory.has(ID)).toBe(true);
  });

  test.each([
    ['the directory alone', true, false],
    ['the document alone', false, true],
    ['both', true, true],
  ] as const)('should say cut off when %s says so', async (_name, inDirectory, inDocument) => {
    // Arrange
    const { subject, directory, document } = halves([]);
    if (inDirectory) directory.add(ID);
    if (inDocument) document.add(ID);

    // Act / Assert
    expect(await subject.isCutOff(ID)).toBe(true);
  });

  test('should say not cut off when neither does', async () => {
    // Arrange
    const { subject } = halves([]);

    // Act / Assert
    expect(await subject.isCutOff(ID)).toBe(false);
  });

  test('should clear the document first and then the directory when a person restores a ferret', async () => {
    // Arrange
    const log: string[] = [];
    const { subject, document, directory } = halves(log);
    await subject.cutOff(ID);
    log.length = 0;

    // Act
    await subject.restore(ID);

    // Assert
    expect(log).toEqual(['document restore', 'directory restore']);
    expect(document.has(ID)).toBe(false);
    expect(directory.has(ID)).toBe(false);
  });

  test('should leave the directory cut off when the document cannot be cleared', async () => {
    // Arrange
    const { subject, inner, directory } = halves([]);
    await subject.cutOff(ID);
    inner.restore = async () => {
      throw new Error('document locked');
    };

    // Act
    const restoring = subject.restore(ID);

    // Assert
    await expect(restoring).rejects.toThrow('document locked');
    expect(directory.has(ID)).toBe(true);
    expect(await subject.isCutOff(ID)).toBe(true);
  });
});

describe('the token directory’s half of a cut-off', () => {
  const FERRET = 'mw7bp88g-50e00159';

  function directory(options: { readonly failSave?: () => boolean } = {}) {
    const tokens = new FerretTokenDirectory();
    const order: string[] = [];
    const saves: number[] = [];
    let ready: () => void = () => {};
    const loaded = new Promise<void>(resolve => (ready = resolve));
    const subject = new DirectoryCutOff({
      ready: async () => {
        await loaded;
        order.push('ready');
      },
      tokens,
      save: async entries => {
        if (options.failSave?.() === true) throw new Error('disk full');
        order.push('save');
        saves.push(entries.length);
      },
      now: () => T0,
    });
    return { subject, tokens, order, saves, load: () => ready() };
  }

  test('should wait for the held tokens to load before it answers, so an unloaded directory never reads not cut off', async () => {
    // Arrange
    const f = directory();
    f.tokens.cutOff(FERRET as never, T0);

    // Act
    let answer: boolean | undefined;
    const asking = f.subject.isCutOff(FERRET).then(value => (answer = value));
    await Bun.sleep(10);
    const early = answer;
    f.load();
    await asking;

    // Assert
    expect(early).toBeUndefined();
    expect(answer).toBe(true);
  });

  test('should say not cut off for a ferret the directory has no mark for', async () => {
    // Arrange
    const f = directory();
    f.load();

    // Act / Assert
    expect(await f.subject.isCutOff(FERRET)).toBe(false);
  });

  test('should mark the directory and persist it when a ferret is cut off, after the load', async () => {
    // Arrange
    const f = directory();
    f.load();

    // Act
    await f.subject.cutOff(FERRET);

    // Assert
    expect(f.tokens.isCutOff(FERRET as never)).toBe(true);
    expect(f.order).toEqual(['ready', 'save']);
    expect(f.saves).toEqual([1]);
  });

  test('should clear the mark and persist it when a person restores the ferret', async () => {
    // Arrange
    const f = directory();
    f.load();
    await f.subject.cutOff(FERRET);

    // Act
    await f.subject.restore(FERRET);

    // Assert
    expect(f.tokens.isCutOff(FERRET as never)).toBe(false);
    expect(f.saves).toHaveLength(2);
  });

  test('should put the cut-off back in memory, and rethrow, when a restore cannot be saved', async () => {
    // Arrange — the cut-off saved, then the restore's save fails
    let failing = false;
    const f = directory({ failSave: () => failing });
    f.load();
    await f.subject.cutOff(FERRET);
    failing = true;

    // Act
    const restoring = f.subject.restore(FERRET);

    // Assert — the process never runs less cut off than the file says
    await expect(restoring).rejects.toThrow('disk full');
    expect(f.tokens.isCutOff(FERRET as never)).toBe(true);
    expect(await f.subject.isCutOff(FERRET)).toBe(true);
  });
});
