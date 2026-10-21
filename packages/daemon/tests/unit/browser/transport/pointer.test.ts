import { describe, it } from 'bun:test';
import type { BrowserInputEvent } from '@ferretry/protocol';
import should from 'should';
import { pointerAfter, pointerSequence } from '../../../../src/lib/index.ts';

const press = { kind: 'mouse', type: 'mousePressed', x: 40, y: 50, button: 'left', buttons: 1, clickCount: 1 } as const;

describe('pointerSequence', () => {
  it('should move the pointer to a press it never travelled to, and nothing more', () => {
    // Act
    const fresh = pointerSequence(undefined, { ...press, modifiers: 2 });
    const elsewhere = pointerSequence({ x: 1, y: 2 }, press);

    // Assert
    should(fresh).deepEqual([
      { kind: 'mouse', type: 'mouseMoved', x: 40, y: 50, button: 'none', buttons: 0, modifiers: 2 },
      { ...press, modifiers: 2 },
    ]);
    should(elsewhere).deepEqual([
      { kind: 'mouse', type: 'mouseMoved', x: 40, y: 50, button: 'none', buttons: 0, modifiers: 0 },
      press,
    ]);
  });

  it('should pass every other input through untouched', () => {
    // Arrange
    const inputs: readonly BrowserInputEvent[] = [
      { kind: 'mouse', type: 'mouseMoved', x: 3, y: 4 },
      { kind: 'mouse', type: 'mouseReleased', x: 9, y: 9, button: 'left' },
      { kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA' },
      { kind: 'insertText', text: 'hi' },
    ];

    // Act + Assert
    for (const input of inputs) should(pointerSequence(undefined, input)).deepEqual([input]);
    should(pointerSequence({ x: 40, y: 50 }, press)).deepEqual([press]);
    should(pointerSequence({ x: 5, y: 6 }, { kind: 'mouse', type: 'mouseWheel', x: 5, y: 6, deltaY: 10 })).deepEqual([
      { kind: 'mouse', type: 'mouseWheel', x: 5, y: 6, deltaY: 10 },
    ]);
  });
});

describe('pointerAfter', () => {
  it('should follow mouse input and ignore the keyboard', () => {
    // Act + Assert
    should(pointerAfter(undefined, press)).deepEqual({ x: 40, y: 50 });
    should(pointerAfter({ x: 1, y: 1 }, { kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA' })).deepEqual({
      x: 1,
      y: 1,
    });
    should(pointerAfter(undefined, { kind: 'insertText', text: 'x' })).be.undefined();
  });
});
