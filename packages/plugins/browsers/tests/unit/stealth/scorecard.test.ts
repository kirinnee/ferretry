import { describe, it } from 'bun:test';
import should from 'should';
import { CAPTURE_META, withChallenge } from '../../support/stealth/capture.ts';
import { type Entry, median, renderTable, scorecard } from '../../support/stealth/scorecard.ts';

const pass = (check: string, numbers: Record<string, number | string | boolean> = {}): Entry['observation'] => ({
  check,
  reading: { kind: 'scored', pass: true, numbers, failed: [] },
});
const fail = (
  check: string,
  failed: string[] = ['x'],
  numbers: Record<string, number | string | boolean> = {},
): Entry['observation'] => ({
  check,
  reading: { kind: 'scored', pass: false, numbers, failed },
});
const lost = (check: string, reason = 'could not read score: gone'): Entry['observation'] => ({
  check,
  reading: { kind: 'unreadable', reason },
});
const runs = (mode: string, observations: readonly Entry['observation'][]): Entry[] =>
  observations.map((observation, index) => ({ mode, run: index + 1, observation }));

describe('median', () => {
  it('should be the middle value, and the lower middle of an even count', () => {
    // Assert
    should(median([3, 1, 2])).equal(2);
    should(median([4, 1, 3, 2])).equal(2);
    should(median([0.9])).equal(0.9);
  });

  it('should refuse nothing rather than invent a number', () => {
    // Assert
    should(() => median([])).throw(/median of nothing/u);
  });
});

describe('scorecard', () => {
  it('should call a check a pass only when most runs passed, and keep the median number', () => {
    // Arrange
    const entries = runs('headless', [
      pass('a', { score: 0.9 }),
      pass('a', { score: 0.7 }),
      fail('a', ['score'], { score: 0.1 }),
    ]);

    // Act
    const card = scorecard('stock', entries).layers[0]?.checks[0];

    // Assert
    should(card).containEql({ check: 'a', verdict: 'pass', runs: 3, passes: 2, unreadable: 0 });
    should(card?.numbers).deepEqual({ score: 0.7 });
    should(card?.failed).deepEqual(['score']);
  });

  it('should call a check a fail when it passed in half the runs or fewer', () => {
    // Act
    const card = scorecard('stock', runs('headless', [pass('a'), fail('a')])).layers[0]?.checks[0];

    // Assert
    should(card?.verdict).equal('fail');
  });

  it('should count an unreadable run against a pass, and say why', () => {
    // Act
    const card = scorecard(
      'stock',
      runs('headless', [pass('a'), lost('a', 'could not read score: A'), lost('a', 'could not read score: A')]),
    ).layers[0]?.checks[0];

    // Assert
    should(card).containEql({ verdict: 'fail', passes: 1, unreadable: 2 });
    should(card?.reasons).deepEqual(['could not read score: A']);
  });

  it('should call a check nobody could read unreadable, never a pass and never a fail', () => {
    // Act
    const layer = scorecard('stock', runs('headless', [lost('a'), lost('a')])).layers[0];

    // Assert
    should(layer?.checks[0]?.verdict).equal('unreadable');
    should(layer?.passed).equal(0);
  });

  it('should score each layer on its own: passes over all of its checks', () => {
    // Act
    const card = scorecard('stock', [
      ...runs('headless', [pass('a'), fail('b'), lost('c')]).map(entry => ({ ...entry, run: 1 })),
      ...runs('window', [pass('a'), pass('b')]).map(entry => ({ ...entry, run: 1 })),
    ]);

    // Assert
    should(card.layers.map(layer => [layer.mode, layer.passed, layer.total])).deepEqual([
      ['headless', 1, 3],
      ['window', 2, 2],
    ]);
    should(card.layers[1]?.score).equal(1);
  });

  it('should keep the commonest value of a word and report every failed test once, sorted', () => {
    // Act
    const card = scorecard(
      'stock',
      runs('headless', [
        fail('a', ['b', 'a'], { word: 'x' }),
        fail('a', ['a'], { word: 'y' }),
        fail('a', ['a'], { word: 'y' }),
      ]),
    ).layers[0]?.checks[0];

    // Assert
    should(card?.numbers).deepEqual({ word: 'y' });
    should(card?.failed).deepEqual(['a', 'b']);
  });

  it('should print a table with a row per check, a column per layer and the suite score', () => {
    // Arrange
    const card = scorecard('stock-5.0', [
      ...runs('headless', [pass('sannysoft'), fail('rebrowser')]).map(entry => ({ ...entry, run: 1 })),
      ...runs('window', [pass('sannysoft'), lost('rebrowser')]).map(entry => ({ ...entry, run: 1 })),
    ]);

    // Act
    const table = renderTable(card).split('\n');

    // Assert
    should(table[0]).equal('scorecard: stock-5.0');
    should(table.join('\n')).match(/sannysoft\s+PASS \(1\/1\)\s+PASS \(1\/1\)/u);
    should(table.join('\n')).match(/rebrowser\s+FAIL \(0\/1\)\s+COULD NOT READ \(0\/1\)/u);
    should(table.at(-1)).match(/SUITE SCORE\s+1\/2\s+1\/2/u);
  });
});

describe('withChallenge', () => {
  it('should stamp the daemon verdict into the head, and leave a page with none alone', () => {
    // Assert
    should(withChallenge('<html><head></head></html>', 'cloudflare')).equal(
      `<html><head><meta name="${CAPTURE_META.challenge}" content="cloudflare"></head></html>`,
    );
    should(withChallenge('<html></html>', undefined)).equal('<html></html>');
    should(withChallenge('<p>x</p>', 'hcaptcha')).startWith(`<meta name="${CAPTURE_META.challenge}"`);
  });
});
