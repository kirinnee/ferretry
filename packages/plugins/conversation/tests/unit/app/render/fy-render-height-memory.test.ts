import { afterEach, describe, test } from 'bun:test';
import should from 'should';
import {
  FY_RENDER_HEIGHT_MEMORY_SIZE,
  forgetFyRenderHeights,
  fyRenderHeightKey,
  recallFyRenderHeight,
  rememberFyRenderHeight,
} from '../../../../app/render/fy-render-height-memory.ts';

afterEach(forgetFyRenderHeights);

describe('fy-render height memory', () => {
  test('should recall the height a block last drew at, by type and source', () => {
    // Arrange
    const key = fyRenderHeightKey('mermaid', 'flowchart TB\n a --> b');

    // Act
    rememberFyRenderHeight(key, 240.4);

    // Assert — the same block in a chat and an agenda tab shares it; a different one does not.
    should(recallFyRenderHeight(fyRenderHeightKey('mermaid', 'flowchart TB\n a --> b'))).equal(240);
    should(recallFyRenderHeight(fyRenderHeightKey('mermaid', 'flowchart TB\n a --> c'))).be.null();
    should(recallFyRenderHeight(fyRenderHeightKey('svg', 'flowchart TB\n a --> b'))).be.null();
  });

  test('should ignore a height that is not one', () => {
    const key = fyRenderHeightKey('html', '<p>x</p>');
    for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) rememberFyRenderHeight(key, value);
    should(recallFyRenderHeight(key)).be.null();
  });

  test('should stay bounded, dropping the oldest first', () => {
    // Act
    for (let index = 0; index <= FY_RENDER_HEIGHT_MEMORY_SIZE; index += 1)
      rememberFyRenderHeight(fyRenderHeightKey('html', `page ${index}`), 100 + index);

    // Assert
    should(recallFyRenderHeight(fyRenderHeightKey('html', 'page 0'))).be.null();
    should(recallFyRenderHeight(fyRenderHeightKey('html', `page ${FY_RENDER_HEIGHT_MEMORY_SIZE}`))).equal(
      100 + FY_RENDER_HEIGHT_MEMORY_SIZE,
    );
  });
});
