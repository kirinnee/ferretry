import { describe, it } from 'bun:test';
import should from 'should';
import { mergeProgress, parseProgressFile } from '../../../cli/lib/board-progress.ts';

const refusal = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
};

describe('parseProgressFile', () => {
  it('should read all three parts from YAML, block scalars and all', () => {
    // Arrange
    const text = 'now: writing the route\ndoneSoFar: |\n  - protocol field\n  - design\nnext: |\n  1. CLI\n  2. PWA\n';

    // Act
    const progress = parseProgressFile(text, 's.yaml');

    // Assert
    should(progress).eql({
      now: 'writing the route',
      doneSoFar: '- protocol field\n- design\n',
      next: '1. CLI\n2. PWA\n',
    });
  });

  it('should read JSON, and take a part left out or written with no value as empty', () => {
    // Act + Assert
    should(parseProgressFile('{"now": "x", "next": "y"}', 's.json')).eql({ now: 'x', doneSoFar: '', next: 'y' });
    should(parseProgressFile('now: x\ndoneSoFar:\nnext: ""\n', 's.yaml')).eql({ now: 'x', doneSoFar: '', next: '' });
  });

  it('should refuse a file that is not YAML, not an object, has a stray key or a part that is not text', () => {
    // Act + Assert
    should(refusal(() => parseProgressFile('now: [unclosed', 's.yaml'))).match(
      /s\.yaml cannot be read as YAML or JSON/u,
    );
    should(refusal(() => parseProgressFile('- a\n- b\n', 's.yaml'))).match(/must hold \{ now, doneSoFar, next \}/u);
    should(refusal(() => parseProgressFile('', 's.yaml'))).match(/s\.yaml is empty/u);
    should(refusal(() => parseProgressFile('now: x\ndone: y\n', 's.yaml'))).match(/unknown keys \(done\)/u);
    should(refusal(() => parseProgressFile('now: 3\n', 's.yaml'))).match(/now must be a Markdown string/u);
  });

  it('should refuse a part over 8 KiB', () => {
    // Act + Assert
    should(refusal(() => parseProgressFile(`now: ${'x'.repeat(8 * 1024 + 1)}\n`, 's.yaml'))).match(
      /cannot set the progress/u,
    );
  });
});

describe('mergeProgress', () => {
  const current = { now: 'a', doneSoFar: 'b', next: 'c' };

  it('should replace only the named parts of the current progress', () => {
    // Act + Assert
    should(mergeProgress(current, { now: 'A' })).eql({ now: 'A', doneSoFar: 'b', next: 'c' });
    should(mergeProgress(current, { doneSoFar: 'B', next: '' })).eql({ now: 'a', doneSoFar: 'B', next: '' });
  });

  it('should give only the named parts when there is no file: the daemon merges them', () => {
    // Act + Assert
    should(mergeProgress(undefined, { next: '1. CLI' })).eql({ next: '1. CLI' });
  });
});

describe('parseProgressFile: a file that parses but is not a value', () => {
  /** Five lines whose aliases would expand to a hundred thousand nodes: YAML the reader refuses to build. */
  const ALIAS_BOMB = [
    'now: &a [x, x, x, x, x, x, x, x, x, x]',
    'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]',
    'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]',
    'd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]',
    'next: [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]',
  ].join('\n');

  it('should keep the reader’s own sentence instead of the generic one', () => {
    // Act
    const said = refusal(() => parseProgressFile(ALIAS_BOMB, 's.yaml'));

    // Assert
    should(said).equal(
      's.yaml could not be read as a patch: Excessive alias count indicates a resource exhaustion attack',
    );
  });
});
