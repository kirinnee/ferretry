import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { opencodeScreen } from '../../daemon/lib/screen.ts';

const captured = async () => {
  const text = await readFile(new URL('../fixtures/spike/startup.txt', import.meta.url), 'utf8');
  return text.slice(text.indexOf('┃'), text.indexOf('\n\n2.4.2'));
};

test('the real V2 startup composer is ready only when its measured ink proves a placeholder', async () => {
  const visible = await captured();
  const attributed = visible.replace('Ask anything', '\x1b[38;2;128;128;128mAsk anything');
  const read = opencodeScreen.read({ visible, attributed, cursorX: 3, cursorY: 0 });
  expect(read.atPrompt).toBe(true);
  expect(read.working).toBe(false);
  expect(read.composer?.placeholder).toBe(true);
  expect(opencodeScreen.read({ visible, cursorX: 3, cursorY: 0 }).composer?.placeholder).toBeUndefined();
});

test('typed placeholder words at Home are a draft, not an empty composer', async () => {
  const visible = await captured();
  const attributed = visible.replace('Ask anything', '\x1b[38;2;255;255;255mAsk anything');
  const read = opencodeScreen.read({ visible, attributed, cursorX: 3, cursorY: 0 });
  expect(read.composer?.placeholder).toBe(false);
  expect(read.composer?.text).toContain('Ask anything');
});

test('ink from a different frame cannot classify a native composer', async () => {
  const visible = await captured();
  const attributed = visible.replace('Ask anything', '\x1b[38;2;128;128;128mAsk something else');
  expect(opencodeScreen.read({ visible, attributed, cursorX: 3, cursorY: 0 }).composer).toBeNull();
});

test('unknown dialogs and an unplaced cursor never authorize typing', async () => {
  expect(opencodeScreen.read({ visible: '› Try a Codex prompt', cursorX: 2, cursorY: 0 }).composer).toBeNull();
  const visible = await captured();
  expect(opencodeScreen.read({ visible }).composer).toBeNull();
  expect(
    opencodeScreen.read({ visible: visible.replace('shift+tab agents', 'esc interrupt'), cursorX: 3, cursorY: 0 })
      .atPrompt,
  ).toBe(false);
});

test('an empty native composer is empty; a wrong status or cursor is unreadable', async () => {
  const visible = await captured();
  const empty = visible.replace(/Ask anything… "[^"\n]*"/u, '');
  expect(opencodeScreen.read({ visible: empty, cursorX: 3, cursorY: 0 }).composer?.text).toBe('');
  expect(opencodeScreen.read({ visible: empty, cursorX: 3, cursorY: 0 }).composer?.placeholder).toBe(false);
  expect(
    opencodeScreen.read({ visible: visible.replace('Build auto', 'Review auto'), cursorX: 3, cursorY: 0 }).composer,
  ).toBeNull();
  expect(opencodeScreen.read({ visible, cursorX: 1, cursorY: 0 }).composer).toBeNull();
});
