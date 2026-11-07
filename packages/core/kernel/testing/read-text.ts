import type { CliContext } from '../manifest/implement.ts';
import type { Manifest } from '../manifest/types.ts';

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
