import { describe, expect, test } from 'bun:test';
import { MachineNameSchema } from '../../../contract/kernel.ts';
import { daemonNameFrom, daemonNameOf } from '../../../host/identity.ts';

describe('what a machine is called', () => {
  test('the owner’s name wins over the host name', () => {
    expect(daemonNameOf('pebox', 'kirin-laptop.local')).toBe('pebox');
  });

  test('no owner name falls back to the host name by the host-name rule', () => {
    expect(daemonNameOf(undefined, '  kirin-laptop.local  ')).toBe('kirin-laptop.local');
    expect(daemonNameOf(undefined, '')).toBe('Ferretry daemon');
    expect(daemonNameOf(undefined, 'box\u0007name')).toBe(daemonNameFrom('box\u0007name'));
  });
});

describe('the name an owner may give a machine', () => {
  test('it is trimmed, and any printable Unicode is allowed', () => {
    expect(MachineNameSchema.parse('  pebox  ')).toBe('pebox');
    expect(MachineNameSchema.parse('Büro 🦫 №2')).toBe('Büro 🦫 №2');
  });

  test('a control character is refused, not stripped', () => {
    expect(MachineNameSchema.safeParse('bell\u0007').success).toBe(false);
    expect(MachineNameSchema.safeParse('tab\there').success).toBe(false);
  });

  test('an invisible format character is refused', () => {
    expect(MachineNameSchema.safeParse('zero​width').success).toBe(false);
  });

  test('empty, blank and 101 characters are refused; 100 passes', () => {
    expect(MachineNameSchema.safeParse('').success).toBe(false);
    expect(MachineNameSchema.safeParse('   ').success).toBe(false);
    expect(MachineNameSchema.safeParse('a'.repeat(101)).success).toBe(false);
    expect(MachineNameSchema.parse('a'.repeat(100))).toHaveLength(100);
  });
});
