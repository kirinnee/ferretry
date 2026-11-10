import { describe, expect, test } from 'bun:test';
import { archivedNameClaims } from '../../../../daemon/lib/names/session-names.ts';
import { CALLSIGN_WINDOW_MS } from '../../../../daemon/lib/names/types.ts';

/** What an archived session still holds of its callsign: the window it always had, never more and never less. */

const created = '2026-11-01T09:00:00.000Z';
const updated = '2026-11-02T09:00:00.000Z';
const row = (more: Record<string, unknown> = {}) => ({
  id: 'mw0000aa-00000001',
  name: 'wren',
  configTimes: { createdAt: created, updatedAt: updated },
  status: 'stopped',
  ...more,
});

describe('archived callsigns held for the window (archive keeps archived callsigns held for the window)', () => {
  test('an archived session holds its name from its last configuration change for the callsign window', () => {
    expect(archivedNameClaims([row()])).toEqual([
      {
        callsign: 'wren',
        ownerId: 'mw0000aa-00000001',
        claimedAtMs: Date.parse(created),
        expiresAtMs: Date.parse(updated) + CALLSIGN_WINDOW_MS,
      },
    ]);
  });

  test('a row with no status is an ended session, held for the window and never for ever', () => {
    const [claim] = archivedNameClaims([row({ status: undefined })]);
    expect(claim?.expiresAtMs).toBe(Date.parse(updated) + CALLSIGN_WINDOW_MS);
  });

  test('a row whose window cannot be measured, or whose name is no callsign, holds nothing', () => {
    expect(archivedNameClaims([row({ configTimes: undefined })])).toEqual([]);
    expect(archivedNameClaims([row({ name: undefined })])).toEqual([]);
    expect(archivedNameClaims([row({ name: 'not a callsign!' })])).toEqual([]);
  });
});
