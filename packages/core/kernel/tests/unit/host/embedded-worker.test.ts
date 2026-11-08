/** A plugin's worker URL resolves to its embedded program in a compiled binary and to itself from source. */
import { describe, expect, test } from 'bun:test';
import { embeddedWorkerFile, embeddedWorkerUrl } from '../../../host/adapters/embedded-worker.ts';

const COMPILED = 'file:///$bunfs/root/fyd.js';
const SOURCE = 'file:///repo/packages/core/kernel/host/adapters/embedded-worker.ts';

describe('embedded plugin worker programs', () => {
  test('the embedded file is the file stem and .js, whatever the directory or source extension', () => {
    expect(embeddedWorkerFile(new URL('file:///repo/p/conversation/daemon/worker/pdf-decrypt.worker.ts'))).toBe(
      'pdf-decrypt.worker.js',
    );
    expect(embeddedWorkerFile(new URL('file:///repo/p/logins/housekeeping.mts'))).toBe('housekeeping.js');
    expect(embeddedWorkerFile(new URL('file:///repo/p/a%20b/odd%20name.worker.ts'))).toBe('odd name.worker.js');
  });

  test('compiled: the URL the plugin spelled (resolved against the bundled entry) names the program beside the entry', () => {
    // `new URL('../worker/pdf-decrypt.worker.ts', import.meta.url)` inside a bundle is relative to the entry.
    const spelled = new URL('../worker/pdf-decrypt.worker.ts', COMPILED);
    expect(spelled.href).toBe('file:///$bunfs/worker/pdf-decrypt.worker.ts');
    expect(embeddedWorkerUrl(spelled, COMPILED).href).toBe('file:///$bunfs/root/pdf-decrypt.worker.js');
  });

  test('compiled: a deeper spelling, which climbs out of the executable filesystem, resolves to the same flat file', () => {
    const spelled = new URL('../../../a/b/pdf-decrypt.worker.ts', COMPILED);
    expect(spelled.href).toBe('file:///a/b/pdf-decrypt.worker.ts');
    expect(embeddedWorkerUrl(spelled, COMPILED).href).toBe('file:///$bunfs/root/pdf-decrypt.worker.js');
  });

  test('compiled: a URL that is not a file URL is left alone', () => {
    const other = new URL('https://example.test/x.worker.js');
    expect(embeddedWorkerUrl(other, COMPILED)).toBe(other);
  });

  test('from source: every URL is left alone', () => {
    const source = new URL('file:///repo/packages/plugins/conversation/daemon/worker/pdf-decrypt.worker.ts');
    expect(embeddedWorkerUrl(source, SOURCE)).toBe(source);
    const embeddedLooking = new URL('file:///$bunfs/worker/x.worker.ts');
    expect(embeddedWorkerUrl(embeddedLooking, SOURCE)).toBe(embeddedLooking);
  });

  test('the default module URL is this process, which runs from source', () => {
    const url = new URL('file:///repo/x.worker.ts');
    expect(embeddedWorkerUrl(url)).toBe(url);
  });
});
