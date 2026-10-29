import { describe, test } from 'bun:test';
import should from 'should';
import {
  isNarrowColumn,
  MERMAID_NARROW_COLUMN_PX,
  mermaidDisplayWidth,
  mermaidNaturalSize,
  verticalizeMermaid,
} from '../../src/lib/fy-render-mermaid-layout.ts';

describe('verticalizeMermaid', () => {
  test('should turn a left-to-right flowchart top-to-bottom', () => {
    // Arrange
    const source = 'flowchart LR\n  A --> B';

    // Act
    const actual = verticalizeMermaid(source);

    // Assert
    should(actual).equal('flowchart TB\n  A --> B');
  });

  test('should turn a right-to-left graph bottom-to-top', () => {
    should(verticalizeMermaid('graph RL\n  A --> B')).equal('graph BT\n  A --> B');
  });

  test('should keep a trailing semicolon and statements on the header line', () => {
    should(verticalizeMermaid('graph LR;')).equal('graph TB;');
    should(verticalizeMermaid('graph LR; A-->B')).equal('graph TB; A-->B');
  });

  test('should accept the header in any case', () => {
    should(verticalizeMermaid('FLOWCHART lr\n A-->B')).equal('FLOWCHART TB\n A-->B');
  });

  test('should return a diagram that is already vertical unchanged', () => {
    for (const source of ['flowchart TB\n A-->B', 'graph TD\n A-->B', 'graph BT\n A-->B', 'flowchart\n A-->B'])
      should(verticalizeMermaid(source)).equal(source);
  });

  test('should find the header after blank lines and comments', () => {
    // Arrange
    const source = '\n%% a comment that says flowchart LR\n\n%% another\nflowchart LR\n  A --> B';

    // Act
    const actual = verticalizeMermaid(source);

    // Assert
    should(actual).equal('\n%% a comment that says flowchart LR\n\n%% another\nflowchart TB\n  A --> B');
  });

  test('should find the header after a single-line and a multi-line init directive', () => {
    should(verticalizeMermaid('%%{init: {"flowchart": {"curve": "basis"}}}%%\ngraph LR\n A-->B')).equal(
      '%%{init: {"flowchart": {"curve": "basis"}}}%%\ngraph TB\n A-->B',
    );
    should(verticalizeMermaid('%%{\n  init: {"theme": "forest"}\n}%%\ngraph LR\n A-->B')).equal(
      '%%{\n  init: {"theme": "forest"}\n}%%\ngraph TB\n A-->B',
    );
  });

  test('should find the header after front matter, and leave the front matter alone', () => {
    // Arrange
    const source = '---\ntitle: flowchart LR\nconfig:\n  theme: forest\n---\nflowchart LR\n  A --> B';

    // Act
    const actual = verticalizeMermaid(source);

    // Assert
    should(actual).equal('---\ntitle: flowchart LR\nconfig:\n  theme: forest\n---\nflowchart TB\n  A --> B');
  });

  test('should not touch the words flowchart LR inside a label or a later line', () => {
    // Arrange
    const label = 'sequenceDiagram\n  A->>B: flowchart LR\n  graph LR';
    const node = 'flowchart TB\n  A["flowchart LR"] --> B\n  graph LR';

    // Assert
    should(verticalizeMermaid(label)).equal(label);
    should(verticalizeMermaid(node)).equal(node);
  });

  test('should leave a subgraph-local direction alone', () => {
    // Arrange
    const source = 'flowchart LR\n  subgraph one\n    direction LR\n    A --> B\n  end';

    // Act
    const actual = verticalizeMermaid(source);

    // Assert
    should(actual).equal('flowchart TB\n  subgraph one\n    direction LR\n    A --> B\n  end');
  });

  test('should never touch another kind of diagram', () => {
    for (const source of [
      'stateDiagram-v2\n  direction LR\n  [*] --> A',
      'sequenceDiagram\n  A->>B: hi',
      'classDiagram\n  direction LR\n  A <|-- B',
      'erDiagram\n  A ||--o{ B : has',
      'gantt\n  title LR',
    ])
      should(verticalizeMermaid(source)).equal(source);
  });

  test('should not mistake a longer word for a direction', () => {
    should(verticalizeMermaid('graph LRX\n A-->B')).equal('graph LRX\n A-->B');
    should(verticalizeMermaid('graphs LR\n A-->B')).equal('graphs LR\n A-->B');
  });

  test('should return source with no diagram at all, and an unterminated front matter, unchanged', () => {
    should(verticalizeMermaid('')).equal('');
    should(verticalizeMermaid('%% only a comment')).equal('%% only a comment');
    should(verticalizeMermaid('---\nflowchart LR')).equal('---\nflowchart LR');
  });
});

describe('isNarrowColumn', () => {
  test('should call a phone column narrow, a desktop one wide, and an unmeasured one wide', () => {
    should(isNarrowColumn(358)).be.true();
    should(isNarrowColumn(MERMAID_NARROW_COLUMN_PX - 1)).be.true();
    should(isNarrowColumn(MERMAID_NARROW_COLUMN_PX)).be.false();
    should(isNarrowColumn(860)).be.false();
    should(isNarrowColumn(0)).be.false();
  });
});

describe('mermaidNaturalSize', () => {
  test('should read the root viewBox', () => {
    should(mermaidNaturalSize('<svg xmlns="x" width="100%" viewBox="0 0 320.5 480"><g/></svg>')).deepEqual({
      height: 480,
      width: 320.5,
    });
  });

  test('should read a viewBox that does not start at the origin and one separated by commas', () => {
    should(mermaidNaturalSize('<svg viewBox="-8, -8, 200, 100">')).deepEqual({ height: 100, width: 200 });
  });

  test('should be null without a usable viewBox', () => {
    should(mermaidNaturalSize('<svg width="10" height="10"></svg>')).be.null();
    should(mermaidNaturalSize('<svg viewBox="0 0 0 10"></svg>')).be.null();
    should(mermaidNaturalSize('<svg><g viewBox="0 0 10 10"/></svg>')).be.null();
  });
});

describe('mermaidDisplayWidth', () => {
  const phone = { bodyPx: 17, columnPx: 358 };
  const desktop = { bodyPx: 13.75, columnPx: 860 };

  test('should show a diagram that fits at its natural size', () => {
    should(mermaidDisplayWidth({ ...phone, naturalWidth: 240 })).deepEqual({ scrolls: false, width: 240 });
  });

  test('should shrink a diagram to the column while its text stays readable', () => {
    // 358 / 380 = 0.94 of 16px = 15px, above 85% of a 17px body (14.45px)
    const actual = mermaidDisplayWidth({ ...phone, naturalWidth: 380 });

    should(actual.scrolls).be.false();
    should(actual.width).equal(358);
  });

  test('should stop shrinking at a readable size and scroll instead', () => {
    // A 760px diagram would need 0.47 to fit; the floor on a 17px body is 14.45px of 16, or 0.903.
    const actual = mermaidDisplayWidth({ ...phone, naturalWidth: 760 });

    should(actual.scrolls).be.true();
    should(actual.width).equal(Math.round(760 * (14.45 / 16)));
    should(actual.width / 760).be.aboveOrEqual(12 / 16);
  });

  test('should never take the text under 12px, whatever the body size', () => {
    const actual = mermaidDisplayWidth({ bodyPx: 11, columnPx: 300, naturalWidth: 2000 });

    should(actual.width / 2000).be.aboveOrEqual(12 / 16);
    should(actual.scrolls).be.true();
  });

  test('should never take the text over 1.25× the body inline', () => {
    // A 10px body caps the scale at 12.5 / 16.
    const actual = mermaidDisplayWidth({ bodyPx: 10, columnPx: 900, naturalWidth: 400 });

    should(actual.width).equal(Math.round(400 * (12.5 / 16)));
  });

  test('should keep a desktop diagram at natural size, which is within 1.25× its body', () => {
    should(mermaidDisplayWidth({ ...desktop, naturalWidth: 500 })).deepEqual({ scrolls: false, width: 500 });
    should(16 / desktop.bodyPx).be.belowOrEqual(1.25);
  });

  test('should let fullscreen enlarge a small diagram, but no more than twice', () => {
    const big = mermaidDisplayWidth({ ...phone, fullscreen: true, naturalWidth: 240 });
    const huge = mermaidDisplayWidth({ bodyPx: 17, columnPx: 1200, fullscreen: true, naturalWidth: 240 });

    should(big.width).equal(358);
    should(huge.width).equal(480);
    should(huge.scrolls).be.false();
  });

  test('should treat an unmeasured column as one with room', () => {
    should(mermaidDisplayWidth({ bodyPx: 14, columnPx: 0, naturalWidth: 700 })).deepEqual({
      scrolls: false,
      width: 700,
    });
  });
});
