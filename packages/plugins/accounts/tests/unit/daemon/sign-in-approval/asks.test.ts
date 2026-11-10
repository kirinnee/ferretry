import { describe, it } from 'bun:test';
import type { AskDraft, AskRef, CloseReason } from '@ferretry/core-asks/contract';
import { askSourceConformance, FakeAsks } from '@ferretry/core-asks/contract/testing';
import should from 'should';
import {
  PhoneApprovalAsksAdapter,
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

const APPROVAL = `pa_${'f'.repeat(24)}`;

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

  it('should raise an approve-on-phone card as a daemon notice naming the approval id only', async () => {
    const asks = new Recording();
    const adapter = new PhoneApprovalAsksAdapter(asks);

    const raised = await adapter.raise('s1', {
      approvalId: APPROVAL,
      title: 'Approve on your phone',
      subject: 'Approve the sign-in on your phone',
      why: 'a sign-in waits',
      context: 'Place: login.example',
      howToResolve: 'Approve on the phone, or say Not me',
    });

    should(raised).match({ ok: true });
    should(asks.raised).have.length(1);
    should(asks.raised[0]).match({
      source: SIGN_IN_APPROVAL_SOURCE,
      ref: { kind: 'phone-approval', id: APPROVAL },
      entry: APPROVAL,
      kind: 'notice',
      subject: 'Approve the sign-in on your phone',
      raisedBy: { kind: 'daemon' },
      ferret: 's1',
    });
  });

  it('should refuse to raise an approval card whose id is not an approval id, without asking Asks', async () => {
    const asks = new Recording();

    const raised = await new PhoneApprovalAsksAdapter(asks).raise('s1', {
      approvalId: 'pa_1',
      title: 't',
      subject: 's',
      why: 'w',
      context: 'c',
      howToResolve: 'h',
    });

    should(raised).eql({ ok: false, message: 'this approval has no id an ask can name' });
    should(asks.raised).eql([]);
  });

  it('should close an approval card with the reason it was given', async () => {
    const asks = new Recording();
    const adapter = new PhoneApprovalAsksAdapter(asks);
    const raised = await adapter.raise('s1', {
      approvalId: APPROVAL,
      title: 't',
      subject: 's',
      why: 'w',
      context: 'c',
      howToResolve: 'h',
    });
    if (!raised.ok) throw new Error('not raised');

    await adapter.close('s1', raised.id, 'source-gone');

    should(asks.closed.map(([, reason]) => reason)).eql(['source-gone']);
  });

  it('should list only the open approval cards, so a restart can close each one', async () => {
    const asks = new Recording();
    const adapter = new PhoneApprovalAsksAdapter(asks);
    const approvalCard = (approvalId: string) => ({
      approvalId,
      title: 't',
      subject: 's',
      why: 'w',
      context: 'c',
      howToResolve: 'h',
    });
    const first = await adapter.raise('s1', approvalCard(APPROVAL));
    const second = await adapter.raise('s2', approvalCard(`pa_${'1'.repeat(24)}`));
    if (!first.ok || !second.ok) throw new Error('not raised');
    // An ask of the same source that is not an approval (a rule suggestion) is never listed.
    await new SignInRuleSuggestionAsksAdapter(new SignInApprovalAsks(asks)).raise('s1', {
      suggestionId: SUGGESTION as never,
      expiresAt: '2026-11-01T14:00:00.000Z',
      ...card,
    });
    await adapter.close('s2', second.id, 'withdrawn');

    const open = await adapter.open();

    should(open).eql([{ ferret: 's1', id: first.id }]);
  });

  it('should skip an open ask that names no ferret or whose entry is not an approval id', async () => {
    const odd = [
      { ferret: undefined, id: 'A1', entry: APPROVAL },
      { ferret: 's1', id: 'A2', entry: 'not-an-approval' },
      { ferret: 's1', id: 'A3', entry: APPROVAL },
    ];
    const adapter = new PhoneApprovalAsksAdapter({
      raise: async () => ({ ferret: 's1', id: 'A1' }) as never,
      close: async () => undefined,
      open: async () => odd as never,
    });

    should(await adapter.open()).eql([{ ferret: 's1', id: 'A3' }]);
  });

  it('should refuse to raise an ask whose entry is not an id Asks can name, without asking Asks', async () => {
    const asks = new Recording();

    const raised = await new SignInApprovalAsks(asks).raise('s1', {
      ref: { kind: 'task-plan', planId: PLAN },
      entry: 'has spaces and !',
      kind: 'permission',
      subject: 's',
      context: 'c',
      howToResolve: 'h',
    });

    should(raised).eql({ ok: false, message: 'this approval has no id an ask can name' });
    should(asks.raised).eql([]);
  });

  it('should not close an ask whose id is not an ask id, and should swallow a close Asks refuses', async () => {
    const closed: string[] = [];
    const asks = new SignInApprovalAsks({
      raise: async () => ({ ferret: 's1', id: 'A1' }) as never,
      close: async ref => {
        closed.push(ref.id);
        throw new Error('already gone');
      },
    });

    await asks.close('s1', 'not an ask id!', 'expired');
    await asks.close('s1', 'A1', 'expired');

    should(closed).eql(['A1']);
  });

  it('should word a non-Error rejection as the ask could not be raised', async () => {
    const asks = new SignInApprovalAsks({
      raise: async () => Promise.reject('boom'),
      close: async () => undefined,
    });

    const raised = await asks.raise('s1', {
      ref: { kind: 'task-plan', planId: PLAN },
      entry: PLAN,
      kind: 'permission',
      subject: 's',
      context: 'c',
      howToResolve: 'h',
    });

    should(raised).eql({ ok: false, message: 'the ask could not be raised' });
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
