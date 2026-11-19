import { expect, test } from 'bun:test';
import { parseProse } from '../../../app/features/pr-page/prose-model.ts';

test('a huge or hostile description is bounded and finishes quickly', () => {
  const started = Date.now();
  parseProse(`${'*'.repeat(60_000)}\n${'[a](b'.repeat(10_000)}\n${'<!--'.repeat(10_000)}`);
  parseProse('`'.repeat(70_000));
  parseProse('> '.repeat(30_000));
  expect(Date.now() - started).toBeLessThan(2000);
});
