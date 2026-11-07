import { describe, it } from 'bun:test';
import type { AccountKey, SignInRuleStageId } from '../../../../contract/routes/index.ts';
import should from 'should';
import { MemoryDocument } from '../support/memory-document.ts';
import { FileSignInRuleStore } from '../../../../daemon/adapters/sign-in-rules/index.ts';
import { PasteRuleService } from '../../../../daemon/lib/secure-copy/rules.ts';
import { SignInRuleService } from '../../../../daemon/lib/sign-in-rules/index.ts';
import { TaskPlanService } from '../../../../daemon/lib/task-plans/index.ts';
import {
  DEVICE,
  DRAFT,
  deviceOwner,
  evidenceFor,
  FakeProofs,
  GITHUB,
  HOST_OWNER,
  KEY,
  listing,
  NOW,
} from './support.ts';

/**
 * RULES ON DISK, PLANS IN MEMORY (r3c-plan §1.2, invariant 9; secrev-1274a TG2): every file each one writes, spied. A
 * rule's commit writes exactly `sign-in-rules.json`, and a restart reads it back and checks it again; a task plan's
 * sign-in line, raised, staged and committed, writes no file at all.
 */

/** The one state file, with every write counted. */
class SpyDocument extends MemoryDocument {
  writes = 0;
  override async write(body: unknown): Promise<void> {
    this.writes += 1;
    await super.write(body);
  }
}

function rulesOver(files: SpyDocument) {
  let ids = 0;
  return new SignInRuleService({
    store: new FileSignInRuleStore(files),
    accounts: { listing: async () => listing() },
    proofs: new FakeProofs(),
    passkeys: { any: async () => true, of: async () => true },
    audit: { record: async () => undefined },
    clock: { now: () => NOW },
    ids: {
      ruleId: () => `sr_${(++ids).toString(16).padStart(24, '0')}`,
      stageId: () => `srs_${(++ids).toString(16).padStart(24, '0')}` as SignInRuleStageId,
    },
    warn: () => undefined,
  });
}

describe('a standing rule is on disk, in one file', () => {
  it('S103 should write only sign-in-rules.json for a commit, and find the rule again after a restart', async () => {
    // Arrange
    const files = new SpyDocument();
    const rules = rulesOver(files);
    await rules.load();

    // Act
    const staged = await rules.stage(deviceOwner(), DRAFT);
    const challenge = rules.challengeOf(staged.stage, DEVICE) ?? new Uint8Array();
    const view = await rules.commit(deviceOwner(), staged.stage, () => evidenceFor(challenge));
    const restarted = rulesOver(files);
    await restarted.load();

    // Assert
    should(files.writes).equal(1);
    should((await restarted.list(HOST_OWNER)).rules.map(rule => rule.id)).eql([view.id]);
    should(restarted.verified(view.id, 1)).be.true();
  });
});

describe('a task plan’s sign-in line is in memory only', () => {
  it('S103 should write no file when a sign-in line is raised, staged and committed', async () => {
    // Arrange
    const pasteWrites: unknown[] = [];
    const rules = new PasteRuleService({
      store: { read: async () => undefined, write: async next => void pasteWrites.push(next) },
      clock: { now: () => NOW },
      ids: { ruleId: () => 'a'.repeat(32) },
      warn: () => undefined,
    });
    await rules.load();
    const plans = new TaskPlanService({
      agenda: { raise: async () => ({ ok: true, id: 'A1' }), close: async () => undefined },
      rules,
      accounts: { listing: async () => listing(), keyOf: async () => KEY as AccountKey },
      passkeys: { any: async () => true },
      redact: async text => text,
      tell: async () => undefined,
      audit: { record: async () => undefined },
      clock: { now: () => NOW },
      ids: { planId: () => 'b'.repeat(32) },
    });

    // Act
    const plan = await plans.propose('mvv6b4qw-49d0158d', {
      lines: [{ kind: 'sign-in', signIn: GITHUB, fields: ['username', 'password'], why: 'check Actions' }],
    });
    const answer = await plans.stage(deviceOwner(), 'mvv6b4qw-49d0158d', plan.id, {
      lines: [{ line: 0, signIn: GITHUB }],
    });
    if (answer.outcome !== 'staged') throw new Error('expected a staged selection');
    const committed = await plans.commit(deviceOwner(), 'mvv6b4qw-49d0158d', plan.id, answer.staged.stage, () => true);

    // Assert — approved, in memory, and not a byte written
    should(committed.state).equal('approved');
    should(plans.approvedSignIns('mvv6b4qw-49d0158d')).have.length(1);
    should(pasteWrites).eql([]);
  });
});
