import { describe, expect, it } from 'bun:test';
import { PAIRING_DEVICE_NAME_MAX_LENGTH } from '../../../contract/index.ts';
import { normalizedDeviceName } from '../../../app/lib/device-name.ts';

describe('normalizedDeviceName', () => {
  it('trims, drops what the pairing schema refuses, and refuses an empty name', () => {
    expect(normalizedDeviceName('  Kitchen iPad \n')).toBe('Kitchen iPad');
    expect(normalizedDeviceName('Kit\u0007chen​')).toBe('Kitchen');
    expect(normalizedDeviceName(' \t ')).toBeUndefined();
  });

  it('cuts to the schema length without splitting a character', () => {
    const long = `${'a'.repeat(PAIRING_DEVICE_NAME_MAX_LENGTH - 1)}😀😀`;
    const cut = normalizedDeviceName(long);
    expect(cut).toBe('a'.repeat(PAIRING_DEVICE_NAME_MAX_LENGTH - 1));
    expect((cut ?? '').length).toBeLessThanOrEqual(PAIRING_DEVICE_NAME_MAX_LENGTH);
  });
});
