import { describe, expect, it } from 'bun:test';
import { formatQuotaMoney, quotaMoneyText, quotaResetsIn } from '../../../app/lib/quota-text.ts';

const NOW = Date.parse('2026-11-01T10:00:00.000Z');
const minutes = (count: number): number => NOW + count * 60_000;

describe('formatQuotaMoney', () => {
  it('writes money as a person reads it, and writes an unknown currency code out', () => {
    expect(formatQuotaMoney(12.34, 'USD')).toBe('$12.34');
    expect(formatQuotaMoney(3.2, 'not a currency')).toBe('3.20 not a currency');
  });
});

describe('quotaResetsIn', () => {
  it('says nothing for a window nobody measured, or a time that is not a number', () => {
    expect(quotaResetsIn(undefined, NOW)).toBeNull();
    expect(quotaResetsIn(Number.NaN, NOW)).toBeNull();
  });

  it('says now once the window has rolled over', () => {
    expect(quotaResetsIn(NOW - 1, NOW)).toBe('now');
  });

  it('reads minutes, hours with leftover minutes, whole hours and days', () => {
    expect(quotaResetsIn(minutes(47), NOW)).toBe('47m');
    expect(quotaResetsIn(minutes(190), NOW)).toBe('3h 10m');
    expect(quotaResetsIn(minutes(180), NOW)).toBe('3h');
    expect(quotaResetsIn(minutes(11 * 60 + 30), NOW)).toBe('11h');
    expect(quotaResetsIn(minutes(48 * 60), NOW)).toBe('2d');
  });
});

describe('quotaMoneyText', () => {
  it('prefers the balance, falls back to the month’s spend, and is null when neither is known', () => {
    expect(quotaMoneyText({ balance: { amount: 12.34, currency: 'USD' } })).toBe('$12.34 left');
    expect(quotaMoneyText({ spendUsd: 3.2 })).toBe('$3.20 this month');
    expect(quotaMoneyText({})).toBeNull();
    expect(quotaMoneyText(null)).toBeNull();
  });
});
