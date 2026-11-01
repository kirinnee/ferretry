import { describe, expect, it } from 'bun:test';
import {
  customSnooze,
  localInputValue,
  SNOOZE_PICK_IDS,
  snoozeChoices,
  snoozePicks,
  tomorrowMorning,
} from '../../src/lib/agenda-snooze.ts';

const local = (month: number, day: number, hour: number, minute = 0): number =>
  new Date(2026, month, day, hour, minute).getTime();

describe('tomorrowMorning', () => {
  it('is 9:00 local on the next day, whatever the time zone', () => {
    const afternoon = local(9, 30, 15, 20);
    const at = new Date(tomorrowMorning(afternoon));
    expect([at.getFullYear(), at.getMonth(), at.getDate()]).toEqual([2026, 9, 31]);
    expect([at.getHours(), at.getMinutes(), at.getSeconds()]).toEqual([9, 0, 0]);
  });

  it('is still tomorrow when it is before 9:00 today', () => {
    const early = new Date(tomorrowMorning(local(9, 30, 7, 5)));
    expect([early.getDate(), early.getHours()]).toEqual([31, 9]);
  });

  it('rolls over the end of a month and a year', () => {
    const month = new Date(tomorrowMorning(local(9, 31, 22)));
    expect([month.getMonth(), month.getDate(), month.getHours()]).toEqual([10, 1, 9]);
    const year = new Date(tomorrowMorning(new Date(2026, 11, 31, 22).getTime()));
    expect([year.getFullYear(), year.getMonth(), year.getDate()]).toEqual([2027, 0, 1]);
  });
});

describe('snoozeChoices', () => {
  const now = local(9, 30, 15, 20);
  const choices = snoozeChoices(now);

  it('offers 1 hour, 4 hours and Tomorrow 9:00, in that order', () => {
    expect(choices.map(choice => [choice.id, choice.label])).toEqual([
      ['hour', '1 hour'],
      ['hours', '4 hours'],
      ['tomorrow', 'Tomorrow 9:00'],
    ]);
  });

  it('gives each as the instant it snoozes until', () => {
    expect(choices[0]?.until).toBe(new Date(now + 3_600_000).toISOString());
    expect(choices[1]?.until).toBe(new Date(now + 4 * 3_600_000).toISOString());
    expect(choices[2]?.until).toBe(new Date(tomorrowMorning(now)).toISOString());
  });
});

describe('snoozePicks', () => {
  const now = local(9, 30, 15, 20);

  it('is the one list every snooze surface offers: the three times, then Custom…', () => {
    expect(snoozePicks(now).map(pick => [pick.id, pick.label])).toEqual([
      ['hour', '1 hour'],
      ['hours', '4 hours'],
      ['tomorrow', 'Tomorrow 9:00'],
      ['custom', 'Custom…'],
    ]);
    expect(SNOOZE_PICK_IDS).toEqual(['hour', 'hours', 'tomorrow', 'custom']);
  });

  it('gives each time its instant and Custom… none, because the owner types that one', () => {
    const picks = snoozePicks(now);
    expect(picks.slice(0, 3).map(pick => pick.until)).toEqual(snoozeChoices(now).map(choice => choice.until));
    expect(picks[3]?.until).toBeNull();
  });
});

describe('localInputValue', () => {
  it('writes a local instant the way a datetime-local input reads it, zero-padded', () => {
    expect(localInputValue(local(0, 5, 7, 4))).toBe('2026-01-05T07:04');
    expect(localInputValue(local(9, 30, 15, 20))).toBe('2026-10-30T15:20');
  });
});

describe('customSnooze', () => {
  const now = local(9, 30, 12);

  it('turns a later typed time into an instant', () => {
    expect(customSnooze('2026-10-30T15:00', now)).toEqual({ ok: true, until: new Date(2026, 9, 30, 15).toISOString() });
  });

  it('asks for a date and a time when there is none', () => {
    expect(customSnooze('', now)).toEqual({ ok: false, message: 'Pick a date and a time.' });
  });

  it('asks again for a value that is not a time', () => {
    expect(customSnooze('soon', now)).toEqual({ ok: false, message: 'Pick a date and a time.' });
  });

  it('refuses a time that has passed, now included', () => {
    const message = 'That time has passed — pick a later one.';
    expect(customSnooze('2026-10-30T09:00', now)).toEqual({ ok: false, message });
    expect(customSnooze('2026-10-30T12:00', now)).toEqual({ ok: false, message });
  });
});
