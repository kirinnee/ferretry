/**
 * A REAL CHROME WITH A TEXT PAGE, AND A PERSON TYPING ON A US KEYBOARD.
 *
 * The daemon half is production: the launcher, the browser worker over CDP and the per-session
 * browser service. The page is a plain HTML form whose fields report every change to a local
 * server, so a test asserts what the PAGE received rather than what the viewer thought it sent.
 *
 * `keystrokes` is the browser half: the DOM key events a US keyboard produces for a character,
 * turned into wire events by the PWA's own `remoteKeyInput`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserInputEvent } from '@ferretry/protocol';
import should from 'should';
import { BrowserProfileStore } from '../../../../daemon/src/adapters/browser/control/index.ts';
import { NodeSessionBrowserLauncher } from '../../../../daemon/src/adapters/browser/runtime/index.ts';
import { BrowserSessionService } from '../../../../daemon/src/lib/index.ts';
import { type RemoteKeyEvent, remoteKeyInput } from '../../../src/lib/remote-browser.ts';
import { waitFor } from './wait-for.ts';

const WORKER = join(import.meta.dir, '../../../../daemon/bin/browser-worker.ts');

export const TYPING_SESSION = 'typing';

const PAGE = `<html><body>
<textarea id="a" rows="6" cols="60"></textarea>
<input id="b">
<script>
for (const field of document.querySelectorAll('textarea, input')) {
  field.addEventListener('input', () => fetch('/report?id=' + field.id, { method: 'POST', body: field.value }));
}
</script></body></html>`;

export interface TypingPage {
  readonly browser: BrowserSessionService;
  /** The last value the page's field reported, or '' before it reported any. */
  value(id: 'a' | 'b'): string;
  /** Resolves with the field's value once it equals `expected` (or the last value after a timeout). */
  settled(id: 'a' | 'b', expected: string): Promise<string>;
  /** Puts focus in a field the way a click from the viewer does. */
  focus(id: 'a' | 'b'): Promise<void>;
  /** Reloads the page so every case starts from empty fields. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function startTypingPage(sessionId: string = TYPING_SESSION): Promise<TypingPage> {
  const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
  const node = Bun.which('node');
  if (chrome === null || node === null) throw new Error('this test needs a real Chrome and Node on PATH');
  const root = await mkdtemp(join(tmpdir(), 'ferretry-typing-'));
  const values = new Map<string, string>();
  const site = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async request => {
      const url = new URL(request.url);
      if (url.pathname === '/report') {
        values.set(url.searchParams.get('id') ?? '', await request.text());
        return new Response('ok');
      }
      return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
    },
  });
  const base = `http://127.0.0.1:${String(site.port)}`;
  const browser = new BrowserSessionService(
    { get: async id => (id === sessionId ? {} : undefined) },
    new NodeSessionBrowserLauncher(new BrowserProfileStore(root), { kind: 'source', entry: WORKER }, node, {
      FY_CHROME_BIN: chrome,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    }),
    () => Date.now(),
  );
  await browser.act(sessionId, { action: 'new-page', url: `${base}/` });
  const value = (id: 'a' | 'b'): string => values.get(id) ?? '';
  return {
    browser,
    value,
    settled: async (id, expected) => {
      await waitFor(() => value(id) === expected || undefined, `field ${id} to read ${JSON.stringify(expected)}`, {
        pollMs: 50,
        evidence: () => `it reads ${JSON.stringify(value(id))}`,
      });
      return value(id);
    },
    focus: async id => {
      await browser.act(sessionId, { action: 'click', selector: `#${id}` });
    },
    reset: async () => {
      values.clear();
      await browser.act(sessionId, { action: 'navigate', url: `${base}/` });
    },
    close: async () => {
      await browser.closeAll();
      site.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

/* ---------- a US keyboard ---------------------------------------------------- */

const SHIFTED_DIGITS = ')!@#$%^&*(';
const US_SYMBOLS: Readonly<Record<string, { code: string; keyCode: number; shifted: string }>> = {
  '`': { code: 'Backquote', keyCode: 192, shifted: '~' },
  '-': { code: 'Minus', keyCode: 189, shifted: '_' },
  '=': { code: 'Equal', keyCode: 187, shifted: '+' },
  '[': { code: 'BracketLeft', keyCode: 219, shifted: '{' },
  ']': { code: 'BracketRight', keyCode: 221, shifted: '}' },
  '\\': { code: 'Backslash', keyCode: 220, shifted: '|' },
  ';': { code: 'Semicolon', keyCode: 186, shifted: ':' },
  "'": { code: 'Quote', keyCode: 222, shifted: '"' },
  ',': { code: 'Comma', keyCode: 188, shifted: '<' },
  '.': { code: 'Period', keyCode: 190, shifted: '>' },
  '/': { code: 'Slash', keyCode: 191, shifted: '?' },
};

const keyEvent = (key: string, code: string, keyCode: number, shiftKey: boolean): RemoteKeyEvent => ({
  key,
  code,
  keyCode,
  location: 0,
  repeat: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey,
});

/** The physical key a printable ASCII character is typed on, and whether Shift is held for it. */
const usKey = (character: string): RemoteKeyEvent | undefined => {
  if (character === ' ') return keyEvent(' ', 'Space', 32, false);
  if (/^[a-z]$/u.test(character)) {
    return keyEvent(character, `Key${character.toUpperCase()}`, character.toUpperCase().charCodeAt(0), false);
  }
  if (/^[A-Z]$/u.test(character)) return keyEvent(character, `Key${character}`, character.charCodeAt(0), true);
  if (/^[0-9]$/u.test(character)) return keyEvent(character, `Digit${character}`, character.charCodeAt(0), false);
  const shiftedDigit = SHIFTED_DIGITS.indexOf(character);
  if (shiftedDigit >= 0) return keyEvent(character, `Digit${String(shiftedDigit)}`, 48 + shiftedDigit, true);
  for (const [unshifted, symbol] of Object.entries(US_SYMBOLS)) {
    if (character === unshifted) return keyEvent(character, symbol.code, symbol.keyCode, false);
    if (character === symbol.shifted) return keyEvent(character, symbol.code, symbol.keyCode, true);
  }
  return undefined;
};

/** A named key (Enter, Backspace, Tab, an arrow). */
const namedKeystrokes = (key: string, code: string, keyCode: number): BrowserInputEvent[] => {
  const event = keyEvent(key, code, keyCode, false);
  return [remoteKeyInput(event, 'keyDown'), remoteKeyInput(event, 'keyUp')];
};

/** The wire events a person typing `text` on a US keyboard produces, Shift taps included. */
const keystrokes = (text: string): BrowserInputEvent[] => {
  const shift = keyEvent('Shift', 'ShiftLeft', 16, true);
  return [...text].flatMap(character => {
    const event = usKey(character);
    if (event === undefined) throw new Error(`no US key for ${JSON.stringify(character)}`);
    return event.shiftKey
      ? [
          remoteKeyInput(shift, 'keyDown'),
          remoteKeyInput(event, 'keyDown'),
          remoteKeyInput(event, 'keyUp'),
          remoteKeyInput({ ...shift, shiftKey: false }, 'keyUp'),
        ]
      : [remoteKeyInput(event, 'keyDown'), remoteKeyInput(event, 'keyUp')];
  });
};

/** Every printable ASCII character, space through tilde, in code order. */
const PRINTABLE_ASCII = Array.from({ length: 0x7e - 0x20 + 1 }, (_, index) => String.fromCharCode(0x20 + index)).join(
  '',
);

/* ---------- the claim, once, for every carrier ------------------------------- */

/** Carries a person's input events to the page by whichever carrier a test wires up. */
export type InputCarrier = (events: readonly BrowserInputEvent[]) => Promise<void>;

/**
 * What a person typing in the viewer must get, whichever way the keys travelled. The page's own
 * `input` reports are the evidence, so a key the daemon drops or mangles shows as a wrong string.
 */
export async function typingReachesThePage(page: TypingPage, carry: InputCarrier): Promise<void> {
  // Every printable ASCII key, shifted and unshifted, space included — "R" among them.
  await page.reset();
  await page.focus('a');
  await carry(keystrokes(PRINTABLE_ASCII));
  should(await page.settled('a', PRINTABLE_ASCII)).equal(PRINTABLE_ASCII);

  // Enter, Backspace and the arrows edit the text; Tab moves on to the next field.
  await page.reset();
  await page.focus('a');
  await carry([
    ...keystrokes('abcd'),
    ...namedKeystrokes('Enter', 'Enter', 13),
    ...keystrokes('e'),
    ...namedKeystrokes('Backspace', 'Backspace', 8),
    ...namedKeystrokes('Backspace', 'Backspace', 8),
    ...namedKeystrokes('ArrowLeft', 'ArrowLeft', 37),
    ...namedKeystrokes('ArrowLeft', 'ArrowLeft', 37),
    ...keystrokes('X'),
    ...namedKeystrokes('ArrowRight', 'ArrowRight', 39),
    ...keystrokes('Y'),
  ]);
  should(await page.settled('a', 'abXcYd')).equal('abXcYd');
  await carry([...namedKeystrokes('Tab', 'Tab', 9), ...keystrokes('Rz')]);
  should(await page.settled('b', 'Rz')).equal('Rz');
  should(page.value('a')).equal('abXcYd');

  // Composed text — an IME commit, a dead key, an emoji — arrives whole as insertText.
  await page.reset();
  await page.focus('a');
  await carry([
    { kind: 'insertText', text: 'é' },
    { kind: 'insertText', text: '日本語' },
    { kind: 'insertText', text: '😀' },
  ]);
  should(await page.settled('a', 'é日本語😀')).equal('é日本語😀');
}
