import { describe, expect, it } from 'bun:test';
import { executableIdentity } from '../../../host/build-identity.ts';

const files = (known: Record<string, { size: number; mtimeMs: number }>) => async (path: string) => {
  const found = known[path];
  if (found === undefined) throw new Error('ENOENT');
  return found;
};

describe('executableIdentity', () => {
  it('is the size and mtime of the first candidate that is a file, the same on every start', async () => {
    const stat = files({ '/bin/fyd': { size: 1000, mtimeMs: 5000.7 } });
    const first = await executableIdentity(['/$bunfs/root/fyd', '/bin/fyd'], stat);
    expect(first).toBe(`${(1000).toString(36)}.${(5000).toString(36)}`);
    expect(await executableIdentity(['/$bunfs/root/fyd', '/bin/fyd'], stat)).toBe(first);
  });

  it('differs between two builds of the same version', async () => {
    const one = await executableIdentity(['/bin/fyd'], files({ '/bin/fyd': { size: 1000, mtimeMs: 1 } }));
    const two = await executableIdentity(['/bin/fyd'], files({ '/bin/fyd': { size: 1001, mtimeMs: 1 } }));
    expect(one).not.toBe(two);
  });

  it('says it cannot tell when no candidate is a file, and defaults to the real process', async () => {
    expect(await executableIdentity(['/nope'], files({}))).toBe('unidentified');
    expect(await executableIdentity()).not.toBe('unidentified');
  });
});
