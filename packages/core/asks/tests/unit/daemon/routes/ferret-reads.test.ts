import { describe, expect, test } from 'bun:test';
import { FERRET_NOTICE_SENTENCES } from '../../../../contract/ferret-notice.ts';
import type { AgendaSnapshot } from '../../../../daemon/lib/protocol/agenda.ts';
import {
  coverOf,
  type FerretReach,
  ferretSnapshot,
  wardenNoticeTarget,
} from '../../../../daemon/lib/routes/ferret-reads.ts';

/**
 * Audit A fix 7: the one projection every Asks read route uses for a Warden-sourced item a FERRET reads. Pure: the
 * lineage and the Warden's sessions are values here.
 */

const reach: FerretReach = {
  mayTouch: async (caller, target) => caller === target || (caller === 'lead' && target === 'helper'),
  startedByWarden: async ferret => ferret === 'investigator',
};
const item = (sourceRef: string | null) => ({ sourceRef, raisedBy: 'daemon', raisedBySession: null }) as never;

describe('which items are the Warden’s', () => {
  test.each([
    ['ask:daemon:f.helper.warden:ask:sus_thinking', 'helper'],
    ['standing:daemon:f.helper.warden-revive', 'helper'],
    ['ask:daemon:warden:ask:fleet:dead_monitor:k', null],
    ['ask:daemon:warden.orphans', null],
    [`ask:daemon:w-${'a'.repeat(40)}`, null],
    ['ask:daemon:plain-note', undefined],
    ['ask:vault:f.helper.warden:x', undefined],
    ['ask:daemon:f.helper.notwarden:x', undefined],
    [null, undefined],
  ] as const)('%s names %p', (sourceRef, target) => {
    expect(wardenNoticeTarget(sourceRef)).toBe(target);
  });

  test('an item an investigator raised is the Warden’s; a lead’s own is not', async () => {
    const byInvestigator = { sourceRef: null, raisedBy: 'agent', raisedBySession: 'investigator' } as never;
    const byLead = { sourceRef: null, raisedBy: 'agent', raisedBySession: 'lead' } as never;
    expect(await coverOf(reach, 'lead', 'lead', byInvestigator)).toBe('project');
    expect(await coverOf(reach, 'lead', 'stranger', byInvestigator)).toBe('omit');
    expect(await coverOf(reach, 'lead', 'stranger', byLead)).toBe('plain');
  });
});

describe('what a ferret may read of one item', () => {
  test('its lineage’s notice is projected, another lineage’s is omitted, a plain item is plain', async () => {
    expect(await coverOf(reach, 'lead', 'lead', item('ask:daemon:f.helper.warden:ask:x'))).toBe('project');
    expect(await coverOf(reach, 'lead', 'lead', item('ask:daemon:f.stranger.warden:ask:x'))).toBe('omit');
    expect(await coverOf(reach, 'lead', 'stranger', item('ask:daemon:plain'))).toBe('plain');
  });

  test('a notice that names no ferret is read by the board it stands on', async () => {
    expect(await coverOf(reach, 'lead', 'lead', item('ask:daemon:warden:ask:fleet:x:y'))).toBe('project');
    expect(await coverOf(reach, 'lead', 'stranger', item('ask:daemon:warden:ask:fleet:x:y'))).toBe('omit');
  });

  test('with no lineage to ask, a Warden item is omitted and a plain one is not', async () => {
    expect(await coverOf(undefined, 'lead', 'lead', item('ask:daemon:f.lead.warden:ask:x'))).toBe('omit');
    expect(await coverOf(undefined, 'lead', 'lead', item('ask:daemon:plain'))).toBe('plain');
  });

  test('a lineage that cannot be read is no lineage', async () => {
    const broken: FerretReach = {
      mayTouch: async () => await Promise.reject(new Error('registry down')),
      startedByWarden: async () => await Promise.reject(new Error('registry down')),
    };
    const byAgent = { sourceRef: null, raisedBy: 'agent', raisedBySession: 'x' } as never;
    expect(await coverOf(broken, 'lead', 'lead', item('ask:daemon:f.lead.warden:ask:x'))).toBe('omit');
    expect(await coverOf(broken, 'lead', 'lead', byAgent)).toBe('omit');
  });
});

describe('a board as a ferret reads it', () => {
  const row = (id: string, sourceRef: string | null, extra: Record<string, unknown> = {}) => ({
    id,
    source: 'question',
    sourceRef,
    subject: `subject ${id}`,
    why: `why ${id}`,
    context: `context ${id}`,
    howToResolve: `remedy ${id}`,
    waitingSince: '2026-11-06T09:00:00.000Z',
    raisedBy: 'daemon',
    raisedBySession: null,
    zzNewField: 'new',
    ...extra,
  });
  const snapshot = {
    v: 1,
    sessionId: 'lead',
    items: [
      row('A1', 'ask:daemon:plain'),
      row('A2', 'ask:daemon:f.stranger.warden:ask:x'),
      row('A3', 'ask:daemon:f.lead.warden:ask:x'),
    ],
    resolved: [
      row('A4', 'ask:daemon:f.stranger.warden:ask:y', {
        resolvedAt: '2026-11-06T09:00:00.000Z',
        resolutionNote: 'note',
        disposition: 'dismissed',
        response: { text: 'private' },
      }),
    ],
    count: 3,
    parseErrors: 0,
    updatedAt: '2026-11-06T09:00:00.000Z',
    replies: { pending: ['A2', 'A3'], dueAt: '2026-11-06T09:00:00.000Z' },
    delivery: { sending: ['A2'] },
  } as unknown as AgendaSnapshot;

  test('keeps the order of what it may read, recounts, and shows no gap or hidden id', async () => {
    const shown = await ferretSnapshot(reach, 'lead', snapshot);

    expect(shown.items.map(entry => entry.id)).toEqual(['A1', 'A3']);
    expect(shown.count).toBe(2);
    expect(shown.resolved).toEqual([]);
    expect(shown.replies?.pending).toEqual(['A3']);
    expect(shown.delivery?.sending).toEqual([]);
    expect(JSON.stringify(shown)).not.toMatch(/A2|A4|stranger|context A3|why A3|remedy A3|private/u);
  });

  test('builds the projected item from an allowlist: the fixed sentences and no model word', async () => {
    const shown = await ferretSnapshot(reach, 'lead', snapshot);
    const projected = shown.items[1] as unknown as Record<string, unknown>;

    expect(projected).toMatchObject({ id: 'A3', sourceRef: null, ...FERRET_NOTICE_SENTENCES });
    expect(Object.keys(projected)).not.toContain('context');
    // A plain item is the same object, untouched.
    expect(shown.items[0]).toBe(snapshot.items[0]);
  });
});
