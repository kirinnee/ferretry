import { expect, test } from 'bun:test';
import manifest from '../../manifest.ts';
test('R501 the renamed GET list retains compression opt-in', () => {
  expect(manifest.actions?.routes?.find(route => route.key === 'GET /v1/ferrets')).toMatchObject({
    compress: true,
    noStore: true,
  });
});
