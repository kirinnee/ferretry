import { describe, test } from 'bun:test';
import should from 'should';
import {
  isNarrowColumn,
  MERMAID_NARROW_COLUMN_PX,
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
