import { describe, it } from 'bun:test';
import should from 'should';
import { type FileStamp, sameDirectory, sameFileStamp } from '../../../src/lib/file-events/ports.ts';

const BASE: FileStamp = { ino: 7n, birthNs: 100n, size: 10n, mtimeNs: 500n };

describe('file stamps', () => {
  it('should call two stamps of the same bytes the same, and "not there" equal only to itself', () => {
    // Act + Assert
    should(sameFileStamp({ ...BASE }, { ...BASE })).be.true();
    should(sameFileStamp(undefined, undefined)).be.true();
    should(sameFileStamp(BASE, undefined)).be.false();
    should(sameFileStamp(undefined, BASE)).be.false();
  });

  it.each([
    ['inode', { ino: 8n }],
    ['birth time', { birthNs: 101n }],
    ['size', { size: 11n }],
    ['modification time', { mtimeNs: 501n }],
  ] as const)('should see a change in the %s as a different file', (_field, change) => {
    // Act + Assert
    should(sameFileStamp(BASE, { ...BASE, ...change })).be.false();
  });

  it('should call a directory the same one however its entries changed, but not one recreated or gone', () => {
    // Act + Assert
    should(sameDirectory(BASE, { ...BASE, size: 99n, mtimeNs: 999n })).be.true();
    should(sameDirectory(BASE, { ...BASE, ino: 8n })).be.false();
    should(sameDirectory(BASE, { ...BASE, birthNs: 101n })).be.false();
    should(sameDirectory(BASE, undefined)).be.false();
  });
});
