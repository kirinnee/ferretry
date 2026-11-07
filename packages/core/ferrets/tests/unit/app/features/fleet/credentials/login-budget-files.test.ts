import { describe, expect, it } from 'bun:test';
import {
  readMachineTimeZone,
  withLoginBudget,
  withMachineTimeZone,
} from '../../../../../src/features/fleet/credentials/login-budget-files.ts';

// A login file as a person keeps it: comments, keys the budget edit must not touch.
const LOGIN = [
  '# the work account, billed monthly',
  'label: work',
  'budget:',
  '  daily:',
  '    trigger: 40   # dollars',
  '    hard: 60',
  '  weekly:',
  '    trigger: 200',
  'sharedWithTerminal: true',
].join('\n');

const MACHINE = ['# machine', 'name: studio-mac', ''].join('\n');

describe('withLoginBudget', () => {
  it('rewrites only the budget key, keeping every comment and other key', () => {
    const edited = withLoginBudget(LOGIN, { daily: { trigger: 30, hard: 50 }, weekly: { hard: 250 } });
    expect(edited).not.toBeNull();
    expect(edited?.split('\n')).toEqual(
      expect.arrayContaining([
        '# the work account, billed monthly',
        'label: work',
        'sharedWithTerminal: true',
        'budget:',
        '  daily:',
        '    trigger: 30',
        '    hard: 50',
        '  weekly:',
        '    hard: 250',
      ]),
    );
    expect(edited?.includes('trigger: 40')).toBe(false);
  });

  it('removes the key entirely when the limits are gone', () => {
    const edited = withLoginBudget(LOGIN, undefined);
    expect(edited).not.toBeNull();
    expect(edited?.includes('budget')).toBe(false);
    expect(edited?.includes('trigger: 40')).toBe(false);
    expect(edited?.includes('label: work')).toBe(true);
    expect(edited?.includes('# the work account, billed monthly')).toBe(true);
  });

  it('adds a budget to a file that has none, or to an empty one', () => {
    expect(withLoginBudget('label: work\n', { daily: { trigger: 10 } })).toBe(
      'label: work\nbudget:\n  daily:\n    trigger: 10\n',
    );
    expect(withLoginBudget('', { daily: { hard: 10 } })).toBe('budget:\n  daily:\n    hard: 10\n');
  });

  it('refuses a file that does not parse, rather than overwriting it', () => {
    expect(withLoginBudget('label: [unclosed\n', { daily: { trigger: 10 } })).toBeNull();
    expect(withLoginBudget('- just\n- a list\n', { daily: { trigger: 10 } })).toBeNull();
  });
});

describe('machine.yaml time zone', () => {
  it('reads the zone the file names, absent as undefined, unparseable as null', () => {
    expect(readMachineTimeZone(MACHINE)).toBeUndefined();
    expect(readMachineTimeZone('# machine\ntimeZone: Asia/Singapore\n')).toBe('Asia/Singapore');
    expect(readMachineTimeZone('timeZone: ""\n')).toBeUndefined();
    expect(readMachineTimeZone('timeZone: [x\n')).toBeNull();
  });

  it('sets the zone without touching the rest of the file', () => {
    expect(withMachineTimeZone(MACHINE, 'Asia/Singapore')).toBe(
      '# machine\nname: studio-mac\ntimeZone: Asia/Singapore\n',
    );
    expect(withMachineTimeZone('timeZone: UTC\n', 'Asia/Singapore')).toBe('timeZone: Asia/Singapore\n');
    expect(withMachineTimeZone('name: [broken\n', 'UTC')).toBeNull();
  });
});
