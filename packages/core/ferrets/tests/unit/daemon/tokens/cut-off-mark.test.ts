import { describe, expect, test } from 'bun:test';
import { CoupledCapabilityHashStore, type TokenCutOff } from '../../../../daemon/lib/tokens/cut-off-mark.ts';
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
