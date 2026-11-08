import { expect, test } from 'bun:test';
import { PUSH_FERRET_PATTERN, PUSH_TAP_SCREENS } from '@ferretry/app';
import { FerretIdSchema } from '@ferretry/core-ferrets/contract';
import manifest from '../../manifest.ts';

test('S2 the chat a push may open is the path this plugin declares for its chat screen', () => {
  const declared = manifest.ui?.screens?.find(screen => screen.id === 'chat')?.path;
  const named = PUSH_TAP_SCREENS.find(screen => screen.plugin === 'conversation' && screen.id === 'chat')?.path;
  expect(declared).toBeDefined();
  expect(named).toBe(declared as string);
});

test('NIT-1 the ferret a push may name is exactly a ferret id, the way Ferrets spells it', () => {
  for (const candidate of [
    'f1',
    'a_b-9',
    'A',
    '9',
    '-x',
    '_x',
    'a b',
    '',
    '?#x',
    'a/b',
    '%2e%2e',
    'é',
    'x'.repeat(128),
    'x'.repeat(129),
  ]) {
    expect(PUSH_FERRET_PATTERN.test(candidate)).toBe(FerretIdSchema.safeParse(candidate).success);
  }
});
