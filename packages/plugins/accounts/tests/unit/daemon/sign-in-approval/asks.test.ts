import { describe, it } from 'bun:test';
import type { AskDraft, AskRef, CloseReason } from '@ferretry/core-asks/contract';
import { askSourceConformance, FakeAsks } from '@ferretry/core-asks/contract/testing';
import should from 'should';
import {
  RecipeAsksAdapter,
  SIGN_IN_APPROVAL_SOURCE,
  SignInApprovalAsks,
  SignInRuleSuggestionAsksAdapter,
  signInApprovalSource,
  TaskPlanAsksAdapter,
} from '../../../../daemon/lib/sign-in-approval/asks.ts';

/**
 * THE SIGN-IN-APPROVAL ASK SOURCE (F640 re-cut): every question Accounts puts to the owner is raised by the daemon under
 * this one source, names an id only, and approves nothing.
 */

const PLAN = 'a'.repeat(32);
const SUGGESTION = `srg_${'b'.repeat(16)}`;
const SIGN_IN = `si_${'c'.repeat(16)}`;
const PROPOSAL = `rp_${'d'.repeat(16)}`;

class Recording extends FakeAsks {
  readonly raised: AskDraft[] = [];
  readonly closed: [AskRef, CloseReason][] = [];
  override async raise(draft: AskDraft): Promise<AskRef> {
    this.raised.push(draft);
    return await super.raise(draft);
  }
  override async close(id: AskRef, reason: CloseReason): Promise<void> {
    this.closed.push([id, reason]);
    await super.close(id, reason);
  }
}

const card = {
  ask: 'Approve the sign-ins for this task?',
  context: 'The ferret says: deploy',
  howToResolve: 'Open it',
};

askSourceConformance('sign-in-approval', signInApprovalSource, {
  valid: [
    { kind: 'task-plan', planId: PLAN },
    { kind: 'copy-plan', planId: PLAN },
    { kind: 'rule-suggestion', suggestion: SUGGESTION },
    { kind: 'rule-suspended', rule: `sr_${'e'.repeat(24)}` },
    { kind: 'phone-approval', id: `pa_${'f'.repeat(24)}` },
    { kind: 'recipe-proposal', signIn: SIGN_IN, proposal: PROPOSAL },
  ],
  invalid: [
    { kind: 'task-plan', planId: 'nope' },
    { kind: 'phone-approval', id: 'pa_1', number: '42' },
    { kind: 'recipe-proposal', signIn: SIGN_IN, proposal: PROPOSAL, account: 'GITHUB_WORK' },
    { kind: 'account', account: 'GITHUB_WORK' },
  ],
});

describe('the sign-in-approval asks', () => {
  it('I206 should be raised by the daemon alone, under its own source, and declare no answer form', async () => {
    const asks = new Recording();
    await new TaskPlanAsksAdapter(new SignInApprovalAsks(asks)).raise('s1', {
      planId: PLAN,
      pastes: false,
      expiresAt: '2026-11-01T14:00:00.000Z',
      ...card,
    });
    should(asks.raised).have.length(1);
    should(asks.raised[0]).match({
      source: SIGN_IN_APPROVAL_SOURCE,
      ref: { kind: 'task-plan', planId: PLAN },
      entry: PLAN,
      raisedBy: { kind: 'daemon' },
      ferret: 's1',
    });
    should(signInApprovalSource.form).be.false();
  });

  it('I206 should name an id only: no ref field holds an account, a username or a number', async () => {
    for (const ref of [
      { kind: 'phone-approval', id: `pa_${'f'.repeat(24)}`, account: 'GITHUB_WORK' },
      { kind: 'phone-approval', id: `pa_${'f'.repeat(24)}`, number: '42' },
      { kind: 'rule-suggestion', suggestion: SUGGESTION, username: 'kirinnee' },
    ])
      should(signInApprovalSource.schema.safeParse(ref).success).be.false();
  });

  it('I140 should raise a recipe proposal naming the sign-in and the proposal only, and close it as answered', async () => {
    const asks = new Recording();
    const adapter = new RecipeAsksAdapter(new SignInApprovalAsks(asks));
    const raised = await adapter.raise('s1', { sourceRef: PROPOSAL, signIn: SIGN_IN, ...card, subject: card.ask });
    should(raised).match({ ok: true });
    should(asks.raised[0]?.ref).eql({ kind: 'recipe-proposal', signIn: SIGN_IN, proposal: PROPOSAL });
    if (!raised.ok) throw new Error('not raised');
    await adapter.close('s1', raised.id, 'Approved: the recipe was updated.');
    await adapter.close('s1', raised.id, 'Replaced by a newer recipe proposal.');
    should(asks.closed.map(([, reason]) => reason)).eql(['answered', 'superseded']);
  });

  it('I140 should refuse to raise a recipe proposal whose ids are not ids, without asking Asks', async () => {
    const asks = new Recording();
    const raised = await new RecipeAsksAdapter(new SignInApprovalAsks(asks)).raise('s1', {
      sourceRef: 'GITHUB_WORK',
      signIn: SIGN_IN,
      ...card,
      subject: card.ask,
    });
    should(raised).match({ ok: false });
    should(asks.raised).eql([]);
  });

  it('S131 should raise a rule suggestion as one ask and close it when it lapses', async () => {
    const asks = new Recording();
    const adapter = new SignInRuleSuggestionAsksAdapter(new SignInApprovalAsks(asks));
    const raised = await adapter.raise('s1', {
      suggestionId: SUGGESTION as never,
      expiresAt: '2026-11-01T14:00:00.000Z',
      ...card,
    });
    should(asks.raised[0]?.ref).eql({ kind: 'rule-suggestion', suggestion: SUGGESTION });
    if (!raised.ok) throw new Error('not raised');
    await adapter.close('s1', raised.id, 'The suggestion lapsed.');
    should(asks.closed.map(([, reason]) => reason)).eql(['expired']);
  });

  it('should close a task plan’s ask as expired when its time ran out, and as withdrawn for any other reason', async () => {
    const asks = new Recording();
    const adapter = new TaskPlanAsksAdapter(new SignInApprovalAsks(asks));
    const raised = await adapter.raise('s1', {
      planId: PLAN,
      pastes: false,
      expiresAt: '2026-11-01T14:00:00.000Z',
      ...card,
    });
    if (!raised.ok) throw new Error('not raised');

    await adapter.close('s1', raised.id, 'The task plan expired.');
    await adapter.close('s1', raised.id, 'The ferret took the plan back.');

    should(asks.closed.map(([, reason]) => reason)).eql(['expired', 'withdrawn']);
  });

  it('should turn a refused raise into words, never a throw into the service', async () => {
    const refusing = { raise: async () => Promise.reject(new Error('Asks is paused')), close: async () => undefined };
    const raised = await new TaskPlanAsksAdapter(new SignInApprovalAsks(refusing)).raise('s1', {
      planId: PLAN,
      pastes: false,
      expiresAt: '2026-11-01T14:00:00.000Z',
      ...card,
    });
    should(raised).eql({ ok: false, message: 'Asks is paused' });
  });
});
