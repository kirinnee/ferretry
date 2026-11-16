import { describe, expect, test } from 'bun:test';
import { FERRET_NOTICE_SENTENCES } from '../../../../contract/ferret-notice.ts';
import type { AgendaSnapshot } from '../../../../daemon/lib/protocol/agenda.ts';
import {
  coverOf,
  type FerretReach,
  ferretSnapshot,
  isWardenShaped,
  projectResolved,
  SOURCE_SHAPES,
} from '../../../../daemon/lib/routes/ferret-reads.ts';

/**
 * Audit A fix 7: the one projection every Asks read route uses for a Warden-sourced item a FERRET reads. Pure: the
 * lineage and the Warden's sessions are values here.
 */

const reach: FerretReach = {
  mayTouch: async (caller, target) => caller === target || (caller === 'lead' && target === 'helper'),
  startedByWarden: async ferret => ferret === 'investigator',
};
const NO_KIN = async () => undefined;
const EMPTY_AT = () => '2030-01-01T00:00:00.000Z';
const item = (sourceRef: string | null) => ({ sourceRef, raisedBy: 'daemon', raisedBySession: null }) as never;

/**
 * Audit A fix 8: EVERY `sourceRef` shape a daemon-raised item can have, live (the Asks port, a gate, a card) or migrated
 * from v4 (the migration keeps each item's bytes, so a v4 home brings its raw grammar), and whose words it carries. One row
 * per shape, so a shape nobody classified cannot slip through as plain.
 */
describe('which items are the Warden’s', () => {
  test.each([
    // The Warden's, live: the Asks port under source `daemon`.
    ['ask:daemon:f.helper.warden:ask:sus_thinking', true],
    ['standing:daemon:f.helper.warden-revive', true],
    ['ask:daemon:warden:ask:fleet:dead_monitor:k', true],
    ['ask:daemon:warden.orphans', true],
    [`ask:daemon:w-${'a'.repeat(40)}`, true],
    // The Warden's, migrated from v4: the raw grammar, kept byte for byte by the migration.
    ['warden:orphans', true],
    ['warden:ask:fleet:dead_monitor:k', true],
    ['warden-auto-move', true],
    ['warden.orphans', true],
    [`w-${'b'.repeat(40)}`, true],
    // Not the Warden's: another plugin's Asks source, a gate and its follow-up, a card's agenda, v4's other producers.
    ['ask:vault:f.helper.warden:x', false],
    ['standing:learning:hint', false],
    ['gate:task-1:entry', false],
    ['gate-followup:task-1:entry', false],
    ['card-agenda:task-1', false],
    ['lanes:proposal-1', false],
    ['handover:s1', false],
    ['budget:daily', false],
    ['prompt:trust-folder', false],
    ['question:toolu_01', false],
  ] as const)('a daemon-raised %s is the Warden’s: %p', (sourceRef, wardens) => {
    expect(isWardenShaped(item(sourceRef))).toBe(wardens);
    // Each shape is NAMED in the table, with its owner: fail closed is the net under the table, not a way to skip a row.
    expect(SOURCE_SHAPES.find(row => row.match.test(sourceRef))?.whose).toBe(wardens ? 'warden' : 'other');
  });

  test.each([
    ['ask:daemon:plain-note'],
    ['ask:daemon:f.helper.notwarden:x'],
    [null],
    ['unlisted:future-producer'],
    ['ask:'],
    ['ask:nosource'],
  ] as const)('a daemon-raised item of the shape %p that no row names is the Warden’s (fail closed)', sourceRef => {
    expect(SOURCE_SHAPES.some(row => sourceRef !== null && row.match.test(sourceRef))).toBe(
      sourceRef === 'ask:daemon:plain-note' || sourceRef === 'ask:daemon:f.helper.notwarden:x',
    );
    expect(isWardenShaped(item(sourceRef))).toBe(true);
  });

  test('an unlisted shape on a ferret’s or the owner’s own item is not the Warden’s', () => {
    expect(isWardenShaped({ sourceRef: null, raisedBy: 'agent' } as never)).toBe(false);
    expect(isWardenShaped({ sourceRef: 'unlisted:x', raisedBy: 'human' } as never)).toBe(false);
    expect(isWardenShaped({ sourceRef: 'ask:ferret:A1', raisedBy: 'agent' } as never)).toBe(false);
  });

  test('an item an investigator raised is the Warden’s; a lead’s own is not', async () => {
    const byInvestigator = { sourceRef: null, raisedBy: 'agent', raisedBySession: 'investigator' } as never;
    const byLead = { sourceRef: null, raisedBy: 'agent', raisedBySession: 'lead' } as never;
    expect(await coverOf(reach, 'lead', 'lead', byInvestigator, NO_KIN)).toBe('project');
    expect(await coverOf(reach, 'lead', 'stranger', byInvestigator, NO_KIN)).toBe('omit');
    expect(await coverOf(reach, 'lead', 'stranger', byLead, NO_KIN)).toBe('plain');
  });
});

describe('what a ferret may read of one item', () => {
  test('its lineage’s notice is projected, another lineage’s is omitted, a plain item is plain', async () => {
    expect(await coverOf(reach, 'lead', 'lead', item('ask:daemon:f.helper.warden:ask:x'), NO_KIN)).toBe('project');
    expect(await coverOf(reach, 'lead', 'lead', item('ask:daemon:f.stranger.warden:ask:x'), NO_KIN)).toBe('omit');
    expect(await coverOf(reach, 'lead', 'stranger', item('gate:task-1:entry'), NO_KIN)).toBe('plain');
  });

  test('a v4 raw Warden notice is read like a live one: own lineage projected, another’s omitted', async () => {
    expect(await coverOf(reach, 'lead', 'lead', item('warden:orphans'), NO_KIN)).toBe('project');
    expect(await coverOf(reach, 'lead', 'stranger', item('warden:orphans'), NO_KIN)).toBe('omit');
    expect(await coverOf(reach, 'lead', 'stranger', item('warden-auto-move'), NO_KIN)).toBe('omit');
  });

  test('a notice that names no ferret is read by the board it stands on', async () => {
    expect(await coverOf(reach, 'lead', 'lead', item('ask:daemon:warden:ask:fleet:x:y'), NO_KIN)).toBe('project');
    expect(await coverOf(reach, 'lead', 'stranger', item('ask:daemon:warden:ask:fleet:x:y'), NO_KIN)).toBe('omit');
  });

  test('with no lineage to ask, a Warden item is omitted and a plain one is not', async () => {
    expect(await coverOf(undefined, 'lead', 'lead', item('ask:daemon:f.lead.warden:ask:x'), NO_KIN)).toBe('omit');
    expect(await coverOf(undefined, 'lead', 'lead', item('gate:task-1:entry'), NO_KIN)).toBe('plain');
  });

  test('a lineage that cannot be read is no lineage', async () => {
    const broken: FerretReach = {
      mayTouch: async () => await Promise.reject(new Error('registry down')),
      startedByWarden: async () => await Promise.reject(new Error('registry down')),
    };
    const byAgent = { sourceRef: null, raisedBy: 'agent', raisedBySession: 'x' } as never;
    expect(await coverOf(broken, 'lead', 'lead', item('ask:daemon:f.lead.warden:ask:x'), NO_KIN)).toBe('omit');
    expect(await coverOf(broken, 'lead', 'lead', byAgent, NO_KIN)).toBe('omit');
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
      row('A1', 'gate:task-1:entry', { waitingSince: '2026-11-06T09:30:00.000Z' }),
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
    const shown = await ferretSnapshot(reach, 'lead', snapshot, EMPTY_AT, NO_KIN);

    expect(shown.items.map(entry => entry.id)).toEqual(['A1', 'A3']);
    expect(shown.count).toBe(2);
    expect(shown.resolved).toEqual([]);
    expect(shown.replies?.pending).toEqual(['A3']);
    expect(shown.delivery?.sending).toEqual([]);
    expect(JSON.stringify(shown)).not.toMatch(/A2|A4|stranger|context A3|why A3|remedy A3|private/u);
  });

  test('updatedAt comes from the items it can read: an omitted item never moves it', async () => {
    const withLaterHidden = {
      ...snapshot,
      updatedAt: '2026-11-06T23:00:00.000Z',
      items: [
        ...snapshot.items,
        row('A5', 'ask:daemon:f.stranger.warden:ask:z', { waitingSince: '2026-11-06T22:00:00.000Z' }),
      ] as never,
    } as AgendaSnapshot;
    const foreign = { ...withLaterHidden, sessionId: 'stranger' } as AgendaSnapshot;
    const shown = await ferretSnapshot(reach, 'lead', snapshot, EMPTY_AT, NO_KIN);
    expect(shown.updatedAt).toBe('2026-11-06T09:30:00.000Z');
    expect((await ferretSnapshot(reach, 'lead', withLaterHidden, EMPTY_AT, NO_KIN)).updatedAt).toBe(shown.updatedAt);
    // A board whose every item is hidden answers what an empty board answers.
    const none = {
      ...foreign,
      items: [row('A9', 'ask:daemon:f.stranger.warden:ask:z')],
      resolved: [],
    } as never as AgendaSnapshot;
    expect((await ferretSnapshot(reach, 'lead', none, EMPTY_AT, NO_KIN)).updatedAt).toBe(EMPTY_AT());
  });

  test('builds the projected item from an allowlist: the fixed sentences and no model word', async () => {
    const shown = await ferretSnapshot(reach, 'lead', snapshot, EMPTY_AT, NO_KIN);
    const projected = shown.items[1] as unknown as Record<string, unknown>;

    expect(projected).toMatchObject({ id: 'A3', sourceRef: null, ...FERRET_NOTICE_SENTENCES });
    expect(Object.keys(projected)).not.toContain('context');
    // A plain item is the same object, untouched.
    expect(shown.items[0]).toBe(snapshot.items[0]);
  });
});

describe('a resolved Warden item as a ferret reads it', () => {
  const resolvedRow = {
    id: 'R1',
    source: 'question',
    sourceRef: 'ask:daemon:f.lead.warden:ask:x',
    subject: 'planted subject sentence',
    why: 'planted report sentence',
    context: 'planted context sentence',
    howToResolve: 'planted remedy sentence',
    waitingSince: '2026-11-06T09:00:00.000Z',
    kind: 'notice',
    stage: 2,
    raisedBy: 'daemon',
    raisedBySession: null,
    resolvedAt: '2026-11-06T10:00:00.000Z',
    resolutionNote: 'planted resolution note',
    disposition: 'dismissed',
    response: { text: 'planted answer text' },
    zzNewField: 'planted new field',
  };

  test('projectResolved keeps only the listed fields, nulls the ref and note, and carries the fixed sentences', () => {
    const shown = projectResolved(resolvedRow as never) as unknown as Record<string, unknown>;

    expect(shown).toMatchObject({
      id: 'R1',
      source: 'question',
      waitingSince: '2026-11-06T09:00:00.000Z',
      kind: 'notice',
      stage: 2,
      raisedBy: 'daemon',
      raisedBySession: null,
      resolvedAt: '2026-11-06T10:00:00.000Z',
      disposition: 'dismissed',
      sourceRef: null,
      resolutionNote: null,
      ...FERRET_NOTICE_SENTENCES,
    });
    expect(Object.keys(shown)).not.toContain('response');
    expect(Object.keys(shown)).not.toContain('zzNewField');
    expect(JSON.stringify(shown)).not.toMatch(/planted|ask:daemon/u);
  });

  test('a ferret reading its own lineage’s resolved notice gets the projection, never the Warden’s prose', async () => {
    const board = {
      v: 1,
      sessionId: 'lead',
      items: [],
      resolved: [resolvedRow],
      count: 0,
      parseErrors: 0,
      updatedAt: '2026-11-06T10:00:00.000Z',
    } as unknown as AgendaSnapshot;

    const shown = await ferretSnapshot(reach, 'lead', board, EMPTY_AT, NO_KIN);

    expect(shown.resolved).toHaveLength(1);
    expect(shown.resolved[0]).toEqual(projectResolved(resolvedRow as never));
    expect(JSON.stringify(shown)).not.toMatch(/planted/u);
  });
});
