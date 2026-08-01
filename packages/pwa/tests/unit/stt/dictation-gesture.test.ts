import { describe, it } from 'bun:test';
import should from 'should';
import {
  beginDictationShortcutCapture,
  DEFAULT_DICTATION_SHORTCUT,
  DICTATION_SHORTCUT_HOLD_MS,
  DictationShortcutGesture,
  dictationShortcutCaptureActive,
  matchesDictationShortcut,
  type ShortcutKeyboardEvent,
} from '../../../src/features/settings/dictation-shortcut.ts';

const press = (overrides: Partial<ShortcutKeyboardEvent> = {}): ShortcutKeyboardEvent => ({
  key: 'Alt',
  code: 'AltLeft',
  metaKey: false,
  ctrlKey: false,
  altKey: true,
  shiftKey: false,
  ...overrides,
});

describe('matchesDictationShortcut', () => {
  it('matches bare Alt from either side', () => {
    should(matchesDictationShortcut(DEFAULT_DICTATION_SHORTCUT, press())).be.true();
    should(matchesDictationShortcut(DEFAULT_DICTATION_SHORTCUT, press({ code: 'AltRight' }))).be.true();
  });

  it('refuses a chord with an extra modifier held', () => {
    should(matchesDictationShortcut(DEFAULT_DICTATION_SHORTCUT, press({ shiftKey: true }))).be.false();
  });

  it('requires every declared modifier', () => {
    const binding = { code: 'KeyD', key: 'd', modifiers: ['Meta', 'Shift'] as const };
    should(
      matchesDictationShortcut(
        binding,
        press({ key: 'd', code: 'KeyD', altKey: false, metaKey: true, shiftKey: true }),
      ),
    ).be.true();
    should(
      matchesDictationShortcut(binding, press({ key: 'd', code: 'KeyD', altKey: false, metaKey: true })),
    ).be.false();
  });

  it('refuses a different primary key entirely', () => {
    should(
      matchesDictationShortcut(DEFAULT_DICTATION_SHORTCUT, press({ key: 'k', code: 'KeyK', altKey: false })),
    ).be.false();
  });
});

describe('DictationShortcutGesture', () => {
  it('starts on the press and finishes on the release of a hold', () => {
    const gesture = new DictationShortcutGesture();
    should(gesture.keyDown(0, false)).equal('start');
    should(gesture.keyUp(DICTATION_SHORTCUT_HOLD_MS)).equal('stop');
  });

  it('latches on a quick tap, and the next press finishes', () => {
    const gesture = new DictationShortcutGesture();
    should(gesture.keyDown(0, false)).equal('start');
    should(gesture.keyUp(50)).be.null();
    should(gesture.keyDown(200, true)).equal('stop');
    should(gesture.keyUp(210)).be.null();
  });

  it('ignores auto-repeat while the key is already down', () => {
    const gesture = new DictationShortcutGesture();
    gesture.keyDown(0, false);
    should(gesture.keyDown(10, false)).be.null();
  });

  it('ignores a second press while a stop is still settling', () => {
    const gesture = new DictationShortcutGesture();
    should(gesture.keyDown(0, true)).equal('stop');
    should(gesture.keyDown(10, true)).be.null();
  });

  it('stops a capture some other control started', () => {
    const gesture = new DictationShortcutGesture();
    should(gesture.keyDown(0, true)).equal('stop');
  });

  it('ignores a keyup it never saw the keydown for', () => {
    should(new DictationShortcutGesture().keyUp(100)).be.null();
  });

  it('trusts its own state over a phase that has not committed yet', () => {
    const gesture = new DictationShortcutGesture();
    gesture.keyDown(0, false);
    should(gesture.blur()).equal('stop');
    should(gesture.blur()).be.null();
  });

  it('forgets a latch once the panel has stopped on its own', () => {
    const gesture = new DictationShortcutGesture();
    gesture.keyDown(0, false);
    gesture.keyUp(10);
    gesture.reset();
    should(gesture.keyDown(20, false)).equal('start');
  });

  it('treats a backwards clock as no hold at all', () => {
    const gesture = new DictationShortcutGesture();
    gesture.keyDown(1_000, false);
    should(gesture.keyUp(0)).be.null();
  });

  it('honours a custom hold threshold', () => {
    const gesture = new DictationShortcutGesture(10);
    gesture.keyDown(0, false);
    should(gesture.keyUp(20)).equal('stop');
  });
});

describe('dictationShortcutCaptureActive', () => {
  it('is false until the picker starts capturing, and balances on release', () => {
    should(dictationShortcutCaptureActive()).be.false();
    const release = beginDictationShortcutCapture();
    should(dictationShortcutCaptureActive()).be.true();
    release();
    should(dictationShortcutCaptureActive()).be.false();
  });

  it('survives nested and repeated releases', () => {
    const outer = beginDictationShortcutCapture();
    const inner = beginDictationShortcutCapture();
    inner();
    should(dictationShortcutCaptureActive()).be.true();
    inner();
    should(dictationShortcutCaptureActive()).be.true();
    outer();
    should(dictationShortcutCaptureActive()).be.false();
  });
});
