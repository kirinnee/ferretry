import { describe, it } from 'bun:test';
import should from 'should';
import { ok } from '@ferretry/std';
import type { FerretId, FerretSummary, FerretsApi } from '@ferretry/core-ferrets/contract';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { ScratchWardenWorkFolders } from '../../daemon/adapters/index.ts';
import { wardenFleetSession } from '../../daemon/fleet.ts';
import { dialogNotice, parseWardenSpawnProvenance, proposeRule } from '../../daemon/lib/index.ts';
import { buildWardenSpawnProvenance } from '../../daemon/lib/provenance.ts';
import { ferretsWardenSpawner } from '../../daemon/spawner.ts';
import { DIALOG_RULE_HARNESSES } from '../../contract/dialog-rules.ts';
import { fakeScratch } from '../support/kernel.ts';

/**
 * U4b part 4b, Warden: a ferret on a harness the family table has no row for is never read as Claude. `fake-third` is a
 * third harness key; `claude` is a third harness registered UNDER the family word, which must not borrow Claude's policy
 * either (a plugin KEY is not a harness FAMILY).
 */

const ferretOn = (harness: string): FerretSummary =>
  new FakeFerrets().add({ id: 'f1' as FerretId, harness: harness as never });

describe('the session the sweep reads', () => {
  it('should carry the family for the two shipped harnesses, so the auto-move can stay on one', () => {
    // Act
    const claude = wardenFleetSession(ferretOn('claude-code'), 1, undefined, '/work');
    const codex = wardenFleetSession(ferretOn('codex'), 1, undefined, '/work');

    // Assert
    should(claude.config.harness).equal('claude');
    should(codex.config.harness).equal('codex');
  });

  it('should carry no harness for a third one, and none for one registered under the word `claude`', () => {
    // Act
    const third = wardenFleetSession(ferretOn('fake-third'), 1, undefined, '/work');
    const collided = wardenFleetSession(ferretOn('claude'), 1, undefined, '/work');

    // Assert
    should(third.config.harness).be.undefined();
    should(collided.config.harness).be.undefined();
  });
});

describe('the investigator spawner', () => {
  const startedOn = async (harness: string) => {
    const scratch = fakeScratch();
    const ferrets = {
      start: async () => ok('inv1' as FerretId),
      get: async () => ({ id: 'inv1', harness, createdAt: '2026-11-26T00:00:00.000Z', runtime: 'acct' }),
    } as unknown as FerretsApi;
    const spawner = ferretsWardenSpawner({ ferrets, folders: new ScratchWardenWorkFolders(scratch) });
    const facts = await spawner.spawn({
      agent: 'acct',
      name: 'Investigate f1',
      prompt: 'look',
      cwd: '',
      teammate: 'warden-000001',
    });
    await scratch.closeAll();
    return facts;
  };

  it('should record the family word for the two shipped harnesses, as before', async () => {
    should((await startedOn('claude-code')).harness).equal('claude');
    should((await startedOn('codex')).harness).equal('codex');
  });

  it('should record a third harness by its own key, never as Claude', async () => {
    should((await startedOn('fake-third')).harness).equal('fake-third');
  });
});

describe('the spawn provenance', () => {
  const selection = {
    policy: 'fallback',
    selection: 'preferred',
    configuredFirst: 'acct',
    skipped: {},
  } as const;
  const facts = (harness: string) => ({
    sessionId: 'inv1',
    createdAt: '2026-11-26T00:00:00.000Z',
    agent: 'acct',
    harness,
    model: 'm1',
    modelSource: 'agent' as const,
  });

  it('should read back a third harness under its own key', () => {
    // Arrange
    const written = JSON.parse(JSON.stringify(buildWardenSpawnProvenance(facts('fake-third'), selection)));

    // Act
    const read = parseWardenSpawnProvenance(written);

    // Assert
    should(read?.harness).equal('fake-third');
  });

  it('should read back the two shipped words as before', () => {
    for (const harness of ['claude', 'codex'])
      should(
        parseWardenSpawnProvenance(JSON.parse(JSON.stringify(buildWardenSpawnProvenance(facts(harness), selection))))
          ?.harness,
      ).equal(harness);
  });
});

describe('the dialog notice and the rules a ferret can be taught', () => {
  const dialog = (harness: string | undefined) => ({
    sessionId: 's1',
    name: 'Ada',
    dialog: { id: 'aaaaaaaaaaaaaaaa', harness, kind: 'mcp-servers' },
  });

  it('should name the two shipped harnesses as before', () => {
    should(dialogNotice(dialog('claude') as never).subject).containEql('in Claude Code');
    should(dialogNotice(dialog('codex') as never).subject).containEql('in Codex');
    should(dialogNotice(dialog(undefined) as never).subject).containEql('in its harness');
  });

  it('should name a third harness by its own key, never Claude Code', () => {
    should(dialogNotice(dialog('fake-third') as never).subject).containEql('in fake-third');
    should(dialogNotice(dialog('fake-third') as never).subject).not.containEql('Claude');
  });

  it('should teach no rule for a screen a third harness drew', () => {
    // Act
    const proposal = proposeRule({
      ferret: 'f1',
      dialog: {
        id: 'bbbbbbbbbbbbbbbb',
        harness: 'fake-third',
        kind: 'other',
        title: 'Try it?',
        options: [{ number: 1, label: 'No' }],
        escape: 'cancel',
      },
    });

    // Assert
    should(proposal.rule).be.undefined();
    should(proposal.note).containEql('not known');
  });

  it('should keep one rule table per family the family table names', () => {
    should([...DIALOG_RULE_HARNESSES]).deepEqual(['claude', 'codex']);
  });
});
