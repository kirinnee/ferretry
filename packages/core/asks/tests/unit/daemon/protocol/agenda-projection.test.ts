import { agendaListSnapshot } from '../../../../daemon/lib/protocol/agenda-list.ts';
import { describe, expect, it } from 'bun:test';
import {
  AgendaListSnapshotSchema,
  AgendaReadItemSchema,
  AgendaSnapshotSchema,
  isAgendaHeader,
} from '../../../../daemon/lib/protocol/agenda.ts';
import { projectionSnapshot } from '../fixtures/agenda-projection.ts';

describe('the agenda list projection', () => {
  it.each([
    [9, 100],
    [1, 40],
  ])('keeps active documents and reduces %i active / %i resolved to under 5%%', (active, resolved) => {
    // Arrange
    const input = projectionSnapshot(active, resolved);
    // Act
    const actual = agendaListSnapshot(input);
    const before = JSON.stringify(input).length;
    const after = JSON.stringify(actual).length;
    // Assert
    expect(after / before).toBeLessThanOrEqual(0.05);
    expect(actual.items).toBe(input.items);
    expect(actual.resolved).toHaveLength(resolved);
    expect(AgendaListSnapshotSchema.safeParse(actual).success).toBe(true);
    expect(AgendaSnapshotSchema.safeParse(actual).success).toBe(false);
    for (const item of actual.resolved) {
      expect(isAgendaHeader(item)).toBe(true);
      expect(item).toMatchObject({
        id: expect.any(String),
        title: 'Release the relay fix',
        kind: 'info',
        lifecycle: 'addressed',
        raisedBy: 'agent',
        raisedByName: 'Morgan',
        resolvedAt: input.updatedAt,
        conversationCount: 1,
      });
      for (const field of [
        'body',
        'tabs',
        'revisions',
        'conversation',
        'history',
        'source',
        'waitingSince',
        'raisedBySession',
        'answers',
      ])
        expect(item).not.toHaveProperty(field);
    }
    console.info(
      `agenda projection ${active}/${resolved}: ${before} -> ${after} bytes (${((after / before) * 100).toFixed(2)}%)`,
    );
  });

  it('accepts full lists from older daemons and keeps full documents distinct from headers', () => {
    // Arrange
    const input = projectionSnapshot(0, 1);
    const record = input.resolved[0];
    if (record === undefined) throw new Error('fixture needs one resolved record');
    // Act + Assert
    expect(AgendaListSnapshotSchema.parse(input)).toEqual(input);
    expect(AgendaReadItemSchema.parse(record)).toEqual(record);
    expect(AgendaReadItemSchema.safeParse(agendaListSnapshot(input).resolved[0]).success).toBe(false);
    expect(AgendaReadItemSchema.safeParse({ ...input.resolved[0], resolvedBy: 'stranger' }).success).toBe(false);
  });

  it('keeps list outcomes, card links, conversation counts and the last useful stage', () => {
    // Arrange
    const input = projectionSnapshot(0, 1);
    const record = input.resolved[0];
    if (record === undefined) throw new Error('fixture needs one resolved record');
    record.task = { id: 'F12' };
    record.links = [{ label: 'Build', target: 'https://example.test/build' }];
    record.stages = [
      { stage: 'question', at: input.updatedAt },
      { stage: 'done', at: input.updatedAt },
    ];
    record.stage = 'done';
    // Act
    const actual = agendaListSnapshot(input).resolved[0];
    // Assert
    expect(actual).toMatchObject({
      task: record.task,
      links: record.links,
      resolutionNote: record.resolutionNote,
      stages: [{ stage: 'question', at: input.updatedAt }],
      conversationCount: 1,
    });
  });

  it('preserves list consistency checks and supplies counts for older documents', () => {
    // Arrange
    const input = projectionSnapshot(1, 1);
    delete input.resolved[0]?.conversationCount;
    // Act
    const actual = agendaListSnapshot(input);
    // Assert
    expect(actual.resolved[0]?.conversationCount).toBe(1);
    expect(AgendaListSnapshotSchema.safeParse({ ...actual, count: 0 }).success).toBe(false);
    expect(
      AgendaListSnapshotSchema.safeParse({ ...actual, count: 2, items: [...actual.items, ...actual.items] }).success,
    ).toBe(false);
    expect(
      AgendaListSnapshotSchema.safeParse({
        ...actual,
        resolved: actual.resolved.map(item => ({ ...item, id: actual.items[0]?.id })),
      }).success,
    ).toBe(false);
    expect(
      AgendaListSnapshotSchema.safeParse({ ...actual, resolved: [...actual.resolved, ...actual.resolved] }).success,
    ).toBe(false);
    delete input.resolved[0]?.conversation;
    expect(agendaListSnapshot(input).resolved[0]?.conversationCount).toBe(0);
  });
});
