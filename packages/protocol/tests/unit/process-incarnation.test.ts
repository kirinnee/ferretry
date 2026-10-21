import { describe, it } from 'bun:test';
import should from 'should';
import { procStatStartTicks, psStartSeconds } from '../../src/lib/process-incarnation.ts';

function stat(command: string, startTicks: string): string {
  const after = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 1)), startTicks, '0'];
  return `4242 (${command}) ${after.join(' ')}\n`;
}

describe('procStatStartTicks', () => {
  it('reads field 22 even when the command name holds spaces and parentheses', () => {
    should(procStatStartTicks(stat('a (b) c', '987654'))).equal(987654);
  });

  it('refuses text with no command name, too few fields, or a non-positive start', () => {
    should(procStatStartTicks('no parenthesis here')).be.undefined();
    should(procStatStartTicks('4242 (sh) S 1 2')).be.undefined();
    should(procStatStartTicks(stat('sh', '0'))).be.undefined();
    should(procStatStartTicks(stat('sh', 'x'))).be.undefined();
  });
});

describe('psStartSeconds', () => {
  it('reads the C-locale lstart text as UTC epoch seconds, including a space-padded day', () => {
    should(psStartSeconds('Sat Sep 26 18:48:09 2026\n')).equal(Date.UTC(2026, 8, 26, 18, 48, 9) / 1000);
    should(psStartSeconds('  Sun Sep  6 01:02:03 2026')).equal(Date.UTC(2026, 8, 6, 1, 2, 3) / 1000);
  });

  it('refuses localised, unknown-month, empty or epoch text', () => {
    should(psStartSeconds('sam. 26 sept. 18:48:09 2026')).be.undefined();
    should(psStartSeconds('Sat Xyz 26 18:48:09 2026')).be.undefined();
    should(psStartSeconds('')).be.undefined();
    should(psStartSeconds('Thu Jan  1 00:00:00 1970')).be.undefined();
  });
});
