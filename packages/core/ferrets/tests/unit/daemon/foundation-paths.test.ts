import { expect, test } from 'bun:test';
import { createFoundationPaths } from '../../../daemon/lib/paths.ts';

test('BG-017 the foundation paths name no daemon identity file: Pairing and Access own the key, Ferrets never reads it', () => {
  const paths = createFoundationPaths('/tmp/review-only-no-io' as never);
  expect(Object.keys(paths)).not.toContain('daemonIdentity');
  expect(Object.values(paths).filter(path => typeof path === 'string' && path.includes('daemon-identity'))).toEqual([]);
});
