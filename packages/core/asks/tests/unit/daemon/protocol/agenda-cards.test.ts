import { describe, it } from 'bun:test';
import should from 'should';
import { AgendaItemSchema, MAX_AGENDA_CARDS } from '../../../../daemon/lib/protocol/agenda.ts';

const NOTICE = {
  id: 'A7',
  source: 'agent-raised',
  sourceRef: 'warden:orphans',
  subject: '&B1 Fix simcha Loge 502 is waiting in Review/CI, but no ferret is assigned, so nothing will happen to it.',
  why: 'A card only moves when a ferret works on it.',
  waitingSince: '2026-10-30T09:00:00.000Z',
  howToResolve: 'Open it, start a ferret on it, or close it.',
  raisedBy: 'daemon',
  raisedBySession: null,
  raisedByName: null,
  kind: 'info',
  notice: true,
} as const;

const ROW = { task: { id: 'B1' }, line: NOTICE.subject } as const;

describe('the cards a notice is about', () => {
  it('should be a list of rows, each naming a card and the line that says where it waits', () => {
    should(AgendaItemSchema.safeParse({ ...NOTICE, cards: [ROW] }).success).be.true();
  });

  it('should refuse an empty list, more than the limit, and a row with no line', () => {
    const many = Array.from({ length: MAX_AGENDA_CARDS + 1 }, (_, index) => ({
      ...ROW,
      task: { id: `B${index + 1}` },
    }));

    should(AgendaItemSchema.safeParse({ ...NOTICE, cards: [] }).success).be.false();
    should(AgendaItemSchema.safeParse({ ...NOTICE, cards: many }).success).be.false();
    should(AgendaItemSchema.safeParse({ ...NOTICE, cards: [{ task: { id: 'B1' }, line: '  ' }] }).success).be.false();
  });

  it('should refuse a row that carries anything else', () => {
    should(AgendaItemSchema.safeParse({ ...NOTICE, cards: [{ ...ROW, remedy: 'drop' }] }).success).be.false();
  });

  it('should refuse cards on any item that is not information', () => {
    should(AgendaItemSchema.safeParse({ ...NOTICE, kind: 'reply', cards: [ROW] }).success).be.false();
    should(AgendaItemSchema.safeParse({ ...NOTICE, kind: undefined, cards: [ROW] }).success).be.false();
  });
});
