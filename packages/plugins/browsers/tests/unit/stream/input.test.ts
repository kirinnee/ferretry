import { describe, it } from 'bun:test';
import should from 'should';
import {
  type BrowserKeyInput,
  keyIdentity,
  keyReleaseSequence,
  normalizeBrowserInput,
} from '../../../../src/lib/index.ts';

function accepted(value: unknown): Record<string, unknown> {
  const result = normalizeBrowserInput(value);
  if (!result.ok) throw new Error(`expected an accepted input, got: ${result.message}`);
  return result.value as unknown as Record<string, unknown>;
}

const keyDown = (overrides: Partial<BrowserKeyInput> = {}): BrowserKeyInput =>
  ({
    kind: 'key',
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 0,
    autoRepeat: false,
    isKeypad: false,
    ...overrides,
  }) as BrowserKeyInput;

describe('browser input normalization', () => {
  it('should normalize a mouse event and default its absent numeric fields to zero', () => {
    // Arrange
    const wire = { kind: 'mouse', type: 'mouseMoved', x: 12.5, y: 30 };

    // Act
    const input = accepted(wire);

    // Assert
    should(input).deepEqual({
      kind: 'mouse',
      type: 'mouseMoved',
      x: 12.5,
      y: 30,
      buttons: 0,
      clickCount: 0,
      deltaX: 0,
      deltaY: 0,
      modifiers: 0,
    });
  });

  it('should keep a named button and clamp continuous ranges instead of dropping the event', () => {
    // Arrange
    const wire = {
      kind: 'mouse',
      type: 'mouseWheel',
      x: 0,
      y: 0,
      button: 'middle',
      buttons: 99.6,
      clickCount: 9,
      deltaX: -99_999,
      deltaY: 99_999,
      modifiers: 400,
    };

    // Act
    const input = accepted(wire);

    // Assert
    should(input['button']).equal('middle');
    should(input['buttons']).equal(31);
    should(input['clickCount']).equal(3);
    should(input['deltaX']).equal(-10_000);
    should(input['deltaY']).equal(10_000);
    should(input['modifiers']).equal(15);
  });

  it('should clamp pointer coordinates to the viewport-relative ceiling', () => {
    // Arrange
    const wire = { kind: 'mouse', type: 'mousePressed', x: 5e9, y: -5e9 };

    // Act
    const input = accepted(wire);

    // Assert
    should(input['x']).equal(1_000_000);
    should(input['y']).equal(-1_000_000);
  });

  it('should reject mouse events whose type, button, or numeric fields are unusable', () => {
    // Act & Assert
    should(normalizeBrowserInput({ kind: 'mouse', type: 'mouseTeleported', x: 0, y: 0 })).deepEqual({
      ok: false,
      message: 'unsupported mouse input type',
    });
    should(normalizeBrowserInput({ kind: 'mouse', type: 'mouseMoved', button: 'thumb' })).deepEqual({
      ok: false,
      message: 'unsupported mouse button',
    });
    should(normalizeBrowserInput({ kind: 'mouse', type: 'mouseMoved', x: 'over-there' })).deepEqual({
      ok: false,
      message: 'mouse input carries a non-numeric field',
    });
    should(normalizeBrowserInput({ kind: 'mouse', type: 'mouseMoved', y: null })).deepEqual({
      ok: false,
      message: 'mouse input carries a non-numeric field',
    });
    should(normalizeBrowserInput({ kind: 'mouse', type: 'mouseMoved', deltaY: Number.NaN })).deepEqual({
      ok: false,
      message: 'mouse input carries a non-numeric field',
    });
  });

  it('should normalize a key event, keeping short text and clamping key codes', () => {
    // Arrange
    const wire = {
      kind: 'key',
      type: 'keyDown',
      key: 'A',
      code: 'KeyA',
      text: 'A',
      unmodifiedText: 'a',
      windowsVirtualKeyCode: 65.4,
      nativeVirtualKeyCode: 999_999,
      modifiers: 2,
      autoRepeat: 'yes',
      isKeypad: true,
    };

    // Act
    const input = accepted(wire);

    // Assert
    should(input).deepEqual({
      kind: 'key',
      type: 'keyDown',
      key: 'A',
      code: 'KeyA',
      text: 'A',
      unmodifiedText: 'a',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 0xffff,
      modifiers: 2,
      // A non-boolean autoRepeat is a malformed flag, never an implicit true.
      autoRepeat: false,
      isKeypad: true,
    });
  });

  it('should refuse a keystroke whose text it would otherwise have to silently drop', () => {
    // Arrange: kteam dropped over-long text and dispatched the key anyway, typing the wrong thing.
    const overlong = { kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', text: 'x'.repeat(17) };
    const wrongType = { kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA', unmodifiedText: 7 };

    // Act & Assert
    should(normalizeBrowserInput(overlong)).deepEqual({
      ok: false,
      message: 'key text must be a string no longer than 16 characters',
    });
    should(normalizeBrowserInput(wrongType)).deepEqual({
      ok: false,
      message: 'key text must be a string no longer than 16 characters',
    });
  });

  it('should reject key events with an unsupported type, unusable names, or bad codes', () => {
    // Act & Assert
    should(normalizeBrowserInput({ kind: 'key', type: 'keyPressed' })).deepEqual({
      ok: false,
      message: 'unsupported key input type',
    });
    should(normalizeBrowserInput({ kind: 'key', type: 'keyDown', key: 'a', code: 'x'.repeat(129) })).deepEqual({
      ok: false,
      message: 'key and code must be strings no longer than 128 characters',
    });
    should(
      normalizeBrowserInput({ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 'shift' }),
    ).deepEqual({ ok: false, message: 'key input carries a non-numeric field' });
  });

  it('should accept bounded inserted text and reject anything larger or non-textual', () => {
    // Arrange
    const text = 'hello world';

    // Act
    const input = accepted({ kind: 'insertText', text });
    const oversize = normalizeBrowserInput({ kind: 'insertText', text: 'x'.repeat(200_001) });
    const nonText = normalizeBrowserInput({ kind: 'insertText', text: 42 });

    // Assert
    should(input).deepEqual({ kind: 'insertText', text });
    should(oversize).deepEqual({ ok: false, message: 'text must be a string no longer than 200000 characters' });
    should(nonText).deepEqual({ ok: false, message: 'text must be a string no longer than 200000 characters' });
  });

  it('should reject values that are not input events at all', () => {
    // Act & Assert
    for (const value of [undefined, null, 42, 'mouse', [], { kind: 'scroll' }, {}]) {
      should(normalizeBrowserInput(value)).deepEqual({ ok: false, message: 'unsupported browser input kind' });
    }
  });
});

describe('held key release policy', () => {
  it('should identify a held key by its physical code, falling back to the logical key', () => {
    // Act & Assert
    should(keyIdentity(keyDown())).equal('KeyA');
    should(keyIdentity(keyDown({ code: '', key: 'Unidentified' }))).equal('Unidentified');
  });

  it('should release held keys newest first, without text and without modifiers', () => {
    // Arrange
    const held = [keyDown({ key: 'Shift', code: 'ShiftLeft', modifiers: 8 }), keyDown({ text: 'A', modifiers: 8 })];

    // Act
    const releases = keyReleaseSequence(held);

    // Assert
    should(releases).deepEqual([
      keyDown({ type: 'keyUp', modifiers: 0 }),
      keyDown({ type: 'keyUp', key: 'Shift', code: 'ShiftLeft', modifiers: 0 }),
    ]);
  });

  it('should release nothing when no key is held', () => {
    // Act & Assert
    should(keyReleaseSequence([])).deepEqual([]);
  });
});
