import { expect, test } from 'bun:test';
import { PUSH_TAP_SCREENS } from '@ferretry/app';
import manifest from '../../manifest.ts';

test('S2 the chat a push may open is the path this plugin declares for its chat screen', () => {
  const declared = manifest.ui?.screens?.find(screen => screen.id === 'chat')?.path;
  const named = PUSH_TAP_SCREENS.find(screen => screen.plugin === 'conversation' && screen.id === 'chat')?.path;
  expect(declared).toBeDefined();
  expect(named).toBe(declared as string);
});
