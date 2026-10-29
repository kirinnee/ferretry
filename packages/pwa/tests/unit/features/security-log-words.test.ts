import { describe, expect, it } from 'bun:test';
import { auditActorWords, securityLogGapWarning } from '../../../src/lib/security-log.ts';

describe('security log words', () => {
  it('names a device that gave no name by its short id, or just calls it a paired device', () => {
    expect(auditActorWords({ kind: 'device', deviceId: 'fy_device_id_abcdef123456' })).toBe('device …123456');
    expect(auditActorWords({ kind: 'device' })).toBe('a paired device');
  });

  it('says a single unreadable entry in the singular and many in the plural, never softening either', () => {
    expect(securityLogGapWarning(1)).toBe('1 entry in this log could not be read. The history has gaps.');
    expect(securityLogGapWarning(3)).toBe('3 entries in this log could not be read. The history has gaps.');
  });
});
