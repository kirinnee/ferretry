import { describe, it } from 'bun:test';
import should from 'should';
import { procStatStartTicks, psStartSeconds } from '../../../../../daemon/lib/protocol/process-incarnation.ts';

const stat = (command: string, fields: number, start: string): string =>
  `4242 (${command}) ${[...Array.from({ length: fields - 1 }, () => '0'), start].join(' ')}`;

describe('procStatStartTicks', () => {
  it('should read field 22 after a command name that holds spaces and parentheses', () => {
    should(procStatStartTicks(stat('a (b) c', 20, '987654'))).equal(987654);
  });

  it('should answer nothing for a line with no command name, too few fields or a start that is not positive', () => {
    should(procStatStartTicks('no command here')).be.undefined();
    should(procStatStartTicks(stat('a', 19, '987654'))).be.undefined();
    should(procStatStartTicks(stat('a', 20, '0'))).be.undefined();
    should(procStatStartTicks(stat('a', 20, 'x'))).be.undefined();
  });
});

describe('psStartSeconds', () => {
  it('should read ps lstart text in UTC as epoch seconds, padded day or not', () => {
    should(psStartSeconds('Sat Sep  6 18:48:09 2026\n')).equal(Date.UTC(2026, 8, 6, 18, 48, 9) / 1000);
    should(psStartSeconds('Tue Nov 10 01:02:03 2026')).equal(Date.UTC(2026, 10, 10, 1, 2, 3) / 1000);
  });

  it('should answer nothing for text that is not lstart or names no month', () => {
    should(psStartSeconds('')).be.undefined();
    should(psStartSeconds('6 Sep 2026 18:48:09')).be.undefined();
    should(psStartSeconds('Sat Foo  6 18:48:09 2026')).be.undefined();
  });
});
