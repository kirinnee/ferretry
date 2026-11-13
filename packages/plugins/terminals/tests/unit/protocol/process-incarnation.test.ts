import { describe, expect, it } from 'bun:test';
import * as cli from '../../../cli/lib/protocol/process-incarnation.ts';
import * as daemon from '../../../daemon/lib/protocol/process-incarnation.ts';

/** The CLI keeps a copy of the daemon's definition: the same text must read as the same number in both. */
const halves = [
  ['the daemon’s', daemon],
  ['the CLI’s copy', cli],
] as const;

/** A `/proc/<pid>/stat` line: pid, (command), then the 50 fields after it; field 22 overall is index 19 after `)`. */
const statLine = (command: string, start: string) =>
  `4242 (${command}) S ${Array.from({ length: 18 }, () => '0').join(' ')} ${start} ${Array.from({ length: 30 }, () => '0').join(' ')}`;

for (const [name, half] of halves)
  describe(`${name} process incarnation`, () => {
    it('reads the start ticks after the command name, even when the name holds spaces and brackets', () => {
      expect(half.procStatStartTicks(statLine('node', '987654'))).toBe(987654);
      expect(half.procStatStartTicks(statLine('tmux: server (x)', '55'))).toBe(55);
    });

    it('reads nothing from text that has no command name, too few fields, or a start that is not a positive integer', () => {
      expect(half.procStatStartTicks('')).toBeUndefined();
      expect(half.procStatStartTicks('4242 node S 1 2 3')).toBeUndefined();
      expect(half.procStatStartTicks('(node) S 1 2 3')).toBeUndefined();
      expect(half.procStatStartTicks('4242 (node) S 1 2 3')).toBeUndefined();
      expect(half.procStatStartTicks(statLine('node', '0'))).toBeUndefined();
      expect(half.procStatStartTicks(statLine('node', 'x'))).toBeUndefined();
      expect(half.procStatStartTicks(statLine('node', '-5'))).toBeUndefined();
    });

    it('reads `ps -o lstart=` as epoch seconds, whatever the padding of the day', () => {
      expect(half.psStartSeconds('Sun Sep  6 18:48:09 2026')).toBe(Date.UTC(2026, 8, 6, 18, 48, 9) / 1000);
      expect(half.psStartSeconds('  Mon Nov 16 00:00:01 2026\n')).toBe(Date.UTC(2026, 10, 16, 0, 0, 1) / 1000);
    });

    it('reads nothing from a start it cannot place: another shape, an unknown month, or the epoch itself', () => {
      expect(half.psStartSeconds('')).toBeUndefined();
      expect(half.psStartSeconds('yesterday')).toBeUndefined();
      expect(half.psStartSeconds('Sun Foo  6 18:48:09 2026')).toBeUndefined();
      expect(half.psStartSeconds('Thu Jan  1 00:00:00 1970')).toBeUndefined();
    });
  });
