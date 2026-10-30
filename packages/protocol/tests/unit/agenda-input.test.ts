import { describe, it } from 'bun:test';
import should from 'should';
import { AgendaActionRequestSchema, AgendaItemSchema, agendaInputProblems } from '../../src/lib/agenda.ts';

const REQUEST_ID = 'a'.repeat(32);

const ITEM = {
  id: 'A7',
  source: 'agent-raised',
  sourceRef: null,
  subject: 'Hadi needs a password',
  why: 'sudo is waiting',
  waitingSince: '2026-10-30T09:00:00.000Z',
  howToResolve: 'Type it on the card',
  raisedBy: 'agent',
  raisedBySession: 's1',
  raisedByName: null,
  kind: 'input',
  input: { requestId: REQUEST_ID },
} as const;

describe('an input card on the agenda', () => {
  it('should be an item of kind input that names its request', () => {
    should(AgendaItemSchema.safeParse(ITEM).success).be.true();
  });

  it('should refuse an input card without its request', () => {
    const { input: _input, ...bare } = ITEM;

    should(AgendaItemSchema.safeParse(bare).success).be.false();
    should(agendaInputProblems(bare)).deepEqual(['an input card names its input request']);
  });

  it('should refuse a request on any other kind of card', () => {
    should(AgendaItemSchema.safeParse({ ...ITEM, kind: 'reply' }).success).be.false();
    should(AgendaItemSchema.safeParse({ ...ITEM, kind: undefined }).success).be.false();
  });

  it('should have no ask, swipe answers, steps or notice of its own', () => {
    for (const extra of [
      { ask: { kind: 'open-question' } },
      { answers: [{ direction: 'right', label: 'Done', does: 'done' }] },
      { steps: ['do it'] },
      { notice: true },
    ] as const) {
      should(AgendaItemSchema.safeParse({ ...ITEM, ...extra }).success).be.false();
    }
  });

  it('should keep the request id a 128-bit hex string', () => {
    should(AgendaItemSchema.safeParse({ ...ITEM, input: { requestId: 'hunter2' } }).success).be.false();
    should(AgendaItemSchema.safeParse({ ...ITEM, input: { requestId: REQUEST_ID, value: 'x' } }).success).be.false();
  });

  it('should never be raised by an agenda add: only an input request raises one', () => {
    const parsed = AgendaActionRequestSchema.safeParse({
      action: 'add',
      kind: 'input',
      subject: 'Type the password here',
      why: 'sudo is waiting',
      howToResolve: 'Type it',
    });

    should(parsed.success).be.false();
    should(parsed.error?.issues[0]?.message).containEql('terminal_request_input');
  });
});
