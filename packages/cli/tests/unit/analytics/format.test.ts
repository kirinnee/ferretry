import { describe, it } from 'bun:test';
import should from 'should';
import {
  DASH,
  compactNumber,
  duration,
  measure,
  percent,
  renderTable,
  usdMicros,
} from '../../../src/lib/analytics/format';
import { known, partial, unknown } from './fixtures';

describe('compact numbers', () => {
  it('should keep small integers exact', () => {
    // Act + Assert
    should(compactNumber(0)).equal('0');
    should(compactNumber(999)).equal('999');
    should(compactNumber(-42)).equal('-42');
  });

  it('should give a small fraction one decimal', () => {
    // Act + Assert
    should(compactNumber(12.34)).equal('12.3');
  });

  it('should scale to thousands, millions and billions', () => {
    // Act + Assert
    should(compactNumber(1_000)).equal('1.0k');
    should(compactNumber(1_234_567)).equal('1.2m');
    should(compactNumber(2_500_000_000)).equal('2.5b');
  });

  it('should scale a negative magnitude the same way', () => {
    // Act + Assert
    should(compactNumber(-1_500)).equal('-1.5k');
  });
});

describe('durations', () => {
  it('should report sub-second work in milliseconds', () => {
    // Act + Assert
    should(duration(0)).equal('0ms');
    should(duration(620.4)).equal('620ms');
  });

  it('should report seconds below a minute', () => {
    // Act + Assert
    should(duration(1_000)).equal('1s');
    should(duration(59_400)).equal('59s');
  });

  it('should report minutes and seconds below an hour', () => {
    // Act + Assert
    should(duration(95_000)).equal('1m35s');
    should(duration(605_000)).equal('10m05s');
  });

  it('should report hours and minutes beyond an hour', () => {
    // Act + Assert
    should(duration(3_725_000)).equal('1h02m');
  });
});

describe('percentages', () => {
  it('should give a small rate two decimals and a large rate one', () => {
    // Act + Assert
    should(percent(5)).equal('5.00%');
    should(percent(64.25)).equal('64.3%');
  });

  it('should treat magnitude, not sign, as the precision signal', () => {
    // Act + Assert — a bare `value >= 10` test gave -12.5 two decimals and 12.5 one.
    should(percent(-12.5)).equal('-12.5%');
  });
});

describe('equivalent cost', () => {
  it('should widen the decimals as the amount shrinks so a cheap run is not rounded away', () => {
    // Act + Assert
    should(usdMicros(12_500_000)).equal('$12.50');
    should(usdMicros(1_234_000)).equal('$1.234');
    should(usdMicros(9_000)).equal('$0.0090');
  });

  it('should format a refund-shaped negative amount', () => {
    // Act + Assert
    should(usdMicros(-20_000_000)).equal('$-20.00');
  });
});

describe('measure rendering', () => {
  it('should print a fully-known value bare', () => {
    // Act
    const actual = measure(known(1_500, 4), compactNumber);

    // Assert
    should(actual).equal('1.5k');
  });

  it('should annotate a value that covers only part of its group', () => {
    // Act
    const actual = measure(partial(1_500, 3, 10), compactNumber);

    // Assert — kteam printed this as a bare "1.5k", indistinguishable from a complete sum.
    should(actual).equal('1.5k[3/10]');
  });

  it('should print a dash when nothing in the group is known', () => {
    // Act
    const actual = measure(unknown(0), compactNumber);

    // Assert
    should(actual).equal(DASH);
  });

  it('should annotate a dash with the coverage it does have', () => {
    // Act
    const actual = measure(partial(null, 0, 7), compactNumber);

    // Assert
    should(actual).equal(`${DASH}[0/7]`);
  });
});

describe('table rendering', () => {
  it('should pad every column but the last', () => {
    // Act
    const actual = renderTable(['A', 'BB'], [['xxx', 'y']]);

    // Assert
    should(actual.split('\n')).deepEqual(['A    BB', '───  ──', 'xxx  y']);
  });

  it('should size a column from its widest cell', () => {
    // Act
    const actual = renderTable(
      ['ID', 'V'],
      [
        ['short', '1'],
        ['much-longer', '2'],
      ],
    );

    // Assert
    should(actual.split('\n')[0]).equal('ID           V');
  });

  it('should render a header-only table when there are no rows', () => {
    // Act
    const actual = renderTable(['ONLY'], []);

    // Assert
    should(actual.split('\n')).deepEqual(['ONLY', '────']);
  });

  it('should tolerate a row shorter than the header', () => {
    // Act — a ragged row must not throw; the missing cell simply contributes no width.
    const actual = renderTable(['A', 'B'], [['x']]);

    // Assert
    should(actual.split('\n')[2]).equal('x');
  });
});
