import { describe, it } from 'bun:test';
import should from 'should';
import { mergeStatus, parseStatusFile } from '../../../src/lib/board/board-status';

const refusal = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
};

describe('parseStatusFile', () => {
  it('should read all three parts from YAML, block scalars and all', () => {
    // Arrange
    const text = 'now: writing the route\ndoneSoFar: |\n  - protocol field\n  - design\nnext: |\n  1. CLI\n  2. PWA\n';

    // Act
    const status = parseStatusFile(text, 's.yaml');

    // Assert
    should(status).eql({
      now: 'writing the route',
      doneSoFar: '- protocol field\n- design\n',
      next: '1. CLI\n2. PWA\n',
    });
  });

  it('should read JSON, and take a part left out or written with no value as empty', () => {
    // Act + Assert
    should(parseStatusFile('{"now": "x", "next": "y"}', 's.json')).eql({ now: 'x', doneSoFar: '', next: 'y' });
    should(parseStatusFile('now: x\ndoneSoFar:\nnext: ""\n', 's.yaml')).eql({ now: 'x', doneSoFar: '', next: '' });
  });

  it('should refuse a file that is not YAML, not an object, has a stray key or a part that is not text', () => {
    // Act + Assert
    should(refusal(() => parseStatusFile('now: [unclosed', 's.yaml'))).match(/cannot read s\.yaml as YAML or JSON/u);
    should(refusal(() => parseStatusFile('- a\n- b\n', 's.yaml'))).match(/must hold \{ now, doneSoFar, next \}/u);
    should(refusal(() => parseStatusFile('', 's.yaml'))).match(/s\.yaml is empty/u);
    should(refusal(() => parseStatusFile('now: x\ndone: y\n', 's.yaml'))).match(/unknown keys \(done\)/u);
    should(refusal(() => parseStatusFile('now: 3\n', 's.yaml'))).match(/now must be a Markdown string/u);
  });

  it('should refuse a part over 8 KiB', () => {
    // Act + Assert
    should(refusal(() => parseStatusFile(`now: ${'x'.repeat(8 * 1024 + 1)}\n`, 's.yaml'))).match(
      /cannot set the status/u,
    );
  });
});

describe('mergeStatus', () => {
  const current = { now: 'a', doneSoFar: 'b', next: 'c' };

  it('should replace only the named parts of the current status', () => {
    // Act + Assert
    should(mergeStatus(current, { now: 'A' })).eql({ now: 'A', doneSoFar: 'b', next: 'c' });
    should(mergeStatus(current, { doneSoFar: 'B', next: '' })).eql({ now: 'a', doneSoFar: 'B', next: '' });
  });

  it('should give only the named parts when there is no file: the daemon merges them', () => {
    // Act + Assert
    should(mergeStatus(undefined, { next: '1. CLI' })).eql({ next: '1. CLI' });
  });
});
