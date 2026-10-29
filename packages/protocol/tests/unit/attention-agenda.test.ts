import { describe, it } from 'bun:test';
import should from 'should';
import {
  AttentionActionRequestSchema,
  AttentionClearableFieldSchema,
  AttentionItemSchema,
  attentionNoticeProblems,
} from '../../src/lib/attention.ts';
import { attentionTurn } from '../../src/lib/attention-card.ts';

const AT = '2026-10-26T09:00:00.000Z';

const base = {
  subject: 'Pick a plan',
  why: 'Two plans fit.',
  howToResolve: 'Choose one.',
  ask: { kind: 'open-question' },
} as const;

const notice = {
  action: 'add',
  notice: true,
  subject: 'CI is green on main',
  why: 'The release branch builds again.',
  howToResolve: 'Nothing to do.',
} as const;

describe('AttentionClearableFieldSchema', () => {
  it('should name exactly the agenda fields an edit can take off an item', () => {
    // Assert
    should(AttentionClearableFieldSchema.options).deepEqual(['blockingNow', 'willBlock', 'neededBy']);
    for (const field of ['blockingNow', 'willBlock', 'neededBy']) {
      should(AttentionClearableFieldSchema.safeParse(field).success).be.true();
    }
    for (const field of ['title', 'subject', 'urgency', '']) {
      should(AttentionClearableFieldSchema.safeParse(field).success).be.false();
    }
  });
});

describe('the add request: agenda fields, notice, ping and the old surface flag', () => {
  it('should keep blockingNow, willBlock and neededBy', () => {
    // Act
    const add = AttentionActionRequestSchema.parse({
      action: 'add',
      ...base,
      blockingNow: true,
      willBlock: 'the deploy',
      neededBy: '2026-12-01T09:00:00.000Z',
    });

    // Assert
    should(add).containDeep({ blockingNow: true, willBlock: 'the deploy', neededBy: '2026-12-01T09:00:00.000Z' });
  });

  it('should refuse blockingNow that is not true, and a neededBy that is not an instant', () => {
    // Assert
    should(AttentionActionRequestSchema.safeParse({ action: 'add', ...base, blockingNow: false }).success).be.false();
    should(AttentionActionRequestSchema.safeParse({ action: 'add', ...base, neededBy: 'tomorrow' }).success).be.false();
  });

  it('should still accept the surface flag older CLIs send', () => {
    // Act
    const add = AttentionActionRequestSchema.safeParse({ action: 'add', ...base, surface: true });

    // Assert
    should(add.success).be.true();
  });

  it('should accept a notice, with or without a ping, and refuse a notice that is not true', () => {
    // Assert
    should(AttentionActionRequestSchema.parse(notice)).containDeep({ action: 'add', notice: true });
    should(AttentionActionRequestSchema.parse({ ...notice, ping: true })).containDeep({ notice: true, ping: true });
    should(AttentionActionRequestSchema.safeParse({ ...notice, notice: false }).success).be.false();
    should(AttentionActionRequestSchema.safeParse({ ...notice, ping: false }).success).be.false();
  });

  it('should refuse a notice that carries an ask, answers, steps or a kind other than info', () => {
    // Act
    const refused = (extra: Record<string, unknown>) => AttentionActionRequestSchema.safeParse({ ...notice, ...extra });

    // Assert
    should(refused({ ask: { kind: 'open-question' } }).success).be.false();
    should(refused({ answers: [{ label: 'ok' }] }).success).be.false();
    should(refused({ steps: ['Run it'] }).success).be.false();
    should(refused({ kind: 'task' }).success).be.false();
    should(refused({ kind: 'info' }).success).be.true();
  });

  it('should refuse a ping that is not on a notice, and say why', () => {
    // Act
    const result = AttentionActionRequestSchema.safeParse({ action: 'add', ...base, ping: true });

    // Assert
    should(result.success).be.false();
    should(result.error?.issues.map(issue => issue.message)).containEql('ping is only for a notice');
  });

  it('should refuse a key the request does not know', () => {
    // Assert
    should(AttentionActionRequestSchema.safeParse({ action: 'add', ...base, urgentNow: true }).success).be.false();
  });
});

describe('the edit request: clear', () => {
  it('should accept one to three distinct-field clears, with or without other changes', () => {
    // Assert
    should(AttentionActionRequestSchema.parse({ action: 'edit', id: 'A1', clear: ['neededBy'] })).containDeep({
      clear: ['neededBy'],
    });
    should(
      AttentionActionRequestSchema.parse({
        action: 'edit',
        id: 'A1',
        willBlock: 'the release',
        clear: ['blockingNow', 'neededBy'],
      }),
    ).containDeep({ willBlock: 'the release', clear: ['blockingNow', 'neededBy'] });
  });

  it('should refuse an empty clear list, an unknown field and more than three', () => {
    // Assert
    should(AttentionActionRequestSchema.safeParse({ action: 'edit', id: 'A1', clear: [] }).success).be.false();
    should(AttentionActionRequestSchema.safeParse({ action: 'edit', id: 'A1', clear: ['title'] }).success).be.false();
    should(
      AttentionActionRequestSchema.safeParse({
        action: 'edit',
        id: 'A1',
        clear: ['blockingNow', 'willBlock', 'neededBy', 'neededBy'],
      }).success,
    ).be.false();
  });

  it('should refuse a field set and cleared in the same edit, naming it', () => {
    // Act
    const both = AttentionActionRequestSchema.safeParse({
      action: 'edit',
      id: 'A1',
      neededBy: '2026-12-01T09:00:00.000Z',
      clear: ['neededBy'],
    });
    const blocking = AttentionActionRequestSchema.safeParse({
      action: 'edit',
      id: 'A1',
      blockingNow: true,
      clear: ['blockingNow'],
    });

    // Assert
    should(both.success).be.false();
    should(both.error?.issues.map(issue => issue.message)).containEql('neededBy cannot be set and cleared at once');
    should(blocking.success).be.false();
  });

  it('should refuse a key the edit does not know, and a notice flag on an edit', () => {
    // Assert
    should(AttentionActionRequestSchema.safeParse({ action: 'edit', id: 'A1', clearAll: true }).success).be.false();
    should(AttentionActionRequestSchema.safeParse({ action: 'edit', id: 'A1', notice: true }).success).be.false();
  });
});

describe('attentionNoticeProblems', () => {
  it('should find nothing wrong with a plain raise, a bare notice or a notice of kind info', () => {
    // Assert
    should(attentionNoticeProblems({ ask: { kind: 'open-question' }, kind: 'task' })).deepEqual([]);
    should(attentionNoticeProblems({ notice: true })).deepEqual([]);
    should(attentionNoticeProblems({ notice: true, ping: true, kind: 'info' })).deepEqual([]);
  });

  it('should say each thing a notice cannot carry, in a fixed order', () => {
    // Act
    const problems = attentionNoticeProblems({
      notice: true,
      ask: {},
      answers: [],
      steps: [],
      kind: 'task',
    });

    // Assert
    should(problems).deepEqual([
      'a notice has no ask',
      'a notice has no answers',
      'a notice has no steps: it is read, not done',
      'a notice is kind info',
    ]);
  });

  it('should refuse a ping only when the raise is not a notice', () => {
    // Assert
    should(attentionNoticeProblems({ ping: true })).deepEqual(['ping is only for a notice']);
    should(attentionNoticeProblems({ notice: true, ping: true })).deepEqual([]);
  });
});

describe('attentionTurn', () => {
  it('should be the owner’s turn for an open item, the ferret’s once it waits on the ferret, done once resolved', () => {
    // Assert
    should(attentionTurn({})).equal('owner');
    should(attentionTurn({ waitingOn: 'ferret' })).equal('ferret');
    should(attentionTurn({ resolvedAt: AT })).equal('done');
    should(attentionTurn({ waitingOn: 'ferret', resolvedAt: AT })).equal('done');
  });

  it('should never give a notice a turn, however it is marked', () => {
    // Assert
    should(attentionTurn({ notice: true })).equal('done');
    should(attentionTurn({ notice: true, waitingOn: 'ferret' })).equal('done');
  });
});

describe('an item that is a notice', () => {
  it('should read back with its notice and ping marks', () => {
    // Act
    const item = AttentionItemSchema.parse({
      id: 'A1',
      source: 'agent-raised',
      sourceRef: null,
      subject: 'CI is green on main',
      why: 'The release branch builds again.',
      waitingSince: AT,
      howToResolve: 'Nothing to do.',
      notice: true,
      ping: true,
      raisedBy: 'agent',
      raisedBySession: 'session-1',
      raisedByName: null,
    });

    // Assert
    should(item).containDeep({ notice: true, ping: true });
  });
});
