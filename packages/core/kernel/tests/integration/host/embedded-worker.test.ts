/** A plugin's worker URL resolves to its embedded program in a compiled binary and to itself from source. */
import { describe, expect, test } from 'bun:test';
import { embeddedWorkerFile, embeddedWorkerUrl } from '../../../host/adapters/embedded-worker.ts';

describe('embedded plugin worker programs, as the host adapter resolves them', () => {
  test('the embedded file is the file stem and .js, whatever the directory or source extension', () => {
    expect(embeddedWorkerFile(new URL('file:///repo/p/daemon/worker/pdf-decrypt.worker.ts'))).toBe(
      'pdf-decrypt.worker.js',
    );
    expect(embeddedWorkerFile(new URL('file:///repo/p/logins/housekeeping.mts'))).toBe('housekeeping.js');
    expect(embeddedWorkerFile(new URL('file:///repo/p/a%20b/odd%20name.worker.ts'))).toBe('odd name.worker.js');
  });

  test('compiled: every file URL resolves to the flat program beside the entry', () => {
    const entry = 'file:///$bunfs/root/fyd.js';
    expect(embeddedWorkerUrl(new URL('file:///a/b/x.worker.ts'), entry).href).toBe('file:///$bunfs/root/x.worker.js');
  });

  test('compiled: a URL that is not a file URL is left alone; from source every URL is', () => {
    const other = new URL('https://example.test/x.worker.js');
    expect(embeddedWorkerUrl(other, 'file:///$bunfs/root/fyd.js')).toBe(other);
    const source = new URL('file:///repo/x.worker.ts');
    expect(embeddedWorkerUrl(source, 'file:///repo/embedded-worker.ts')).toBe(source);
  });

  test('with no module URL named it judges by its own: run from source, a worker URL stays as spelled', () => {
    const source = new URL('file:///repo/x.worker.ts');
    expect(embeddedWorkerUrl(source)).toBe(source);
  });
});
