import type { CliContext } from '../manifest/implement.ts';
import type { Manifest } from '../manifest/types.ts';

/** A CLI `exists` double: the fixture paths (files or folders) exist; a trailing slash names a folder. Never reads. */
export function testExists(paths: readonly string[]): NonNullable<CliContext<Manifest>['exists']> {
  const known = new Set(paths.map(path => path.replace(/\/+$/u, '')));
  return async path => known.has(path.replace(/\/+$/u, ''));
}

/** A CLI readText double: fixture paths and stdin, with the same UTF-8 decode and no reader cap. */
export function testReadText(
  files: Readonly<Record<string, string | Uint8Array>>,
  stdin: string | Uint8Array = '',
): NonNullable<CliContext<Manifest>['readText']> {
  return async path => {
    const value = path === '-' ? stdin : Object.hasOwn(files, path) ? files[path] : undefined;
    if (value === undefined) throw new Error(`no text fixture for ${path}`);
    return new TextDecoder().decode(typeof value === 'string' ? new TextEncoder().encode(value) : value);
  };
}
