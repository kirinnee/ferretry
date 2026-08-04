import { describe, it } from 'bun:test';
import should from 'should';
import { harnessMigrationRefusal } from '../../../src/lib/migrate/harness-compatibility.ts';

/**
 * The same-kind constraint the CLI promised and the daemon did not check.
 *
 * `fy session migrate` has always described itself as continuing a session on another same-kind fleet
 * account, while the migrator resolved the requested account and rebuilt the target from
 * `account.kind` without ever comparing it to the source harness. Both directions of the crossing are
 * tested because they fail differently and neither was refused.
 */

describe('the migration harness check', () => {
  it('should allow a move onto an account of the session own family', () => {
    // The ordinary case, and the whole point of the operation: a rate-limited claude session moves
    // onto another claude account and keeps its conversation.
    // Act + Assert
    should(
      harnessMigrationRefusal({ sourceHarness: 'claude', targetHarness: 'claude', targetAgent: 'claude-auto-two' }),
    ).be.undefined();
    should(
      harnessMigrationRefusal({ sourceHarness: 'codex', targetHarness: 'codex', targetAgent: 'codex-auto-two' }),
    ).be.undefined();
  });

  it('should refuse both directions of a cross-family move, naming the account it refused', () => {
    // Both, because the two are not symmetric in how they would fail: a codex harness handed a claude
    // transcript reads nothing, and a claude harness handed a codex rollout reads nothing — but each
    // was permitted, and each destroyed the pane before anyone found out.
    // Act
    const toCodex = harnessMigrationRefusal({
      sourceHarness: 'claude',
      targetHarness: 'codex',
      targetAgent: 'codex-auto-target',
    });
    const toClaude = harnessMigrationRefusal({
      sourceHarness: 'codex',
      targetHarness: 'claude',
      targetAgent: 'claude-auto-target',
    });

    // Assert
    should(toCodex).be.a.String();
    should(toCodex).containEql('runs the claude harness');
    should(toCodex).containEql('codex-auto-target is a codex account');
    // The refusal has to be actionable: what the caller does instead is name a same-family account.
    should(toCodex).containEql('migrate onto a claude account');
    should(toClaude).containEql('runs the codex harness');
    should(toClaude).containEql('claude-auto-target is a claude account');
    should(toClaude).containEql('migrate onto a codex account');
  });

  it('should refuse a family it does not recognise on either side, rather than defaulting', () => {
    // AN UNKNOWN KIND IS A REFUSAL. This is why the check is not `source !== target`: that comparison
    // calls two values equal when it understands neither, and the operation it would then permit
    // destroys a pane. A document from a future daemon, or a manifest declaring a family this build
    // has never heard of, is precisely where "they look the same" is worth nothing.
    // Act
    const unknownSource = harnessMigrationRefusal({
      sourceHarness: 'gemini',
      targetHarness: 'claude',
      targetAgent: 'claude-auto-target',
    });
    const unknownTarget = harnessMigrationRefusal({
      sourceHarness: 'claude',
      targetHarness: 'gemini',
      targetAgent: 'gemini-auto-target',
    });
    const bothUnknownAndIdentical = harnessMigrationRefusal({
      sourceHarness: 'gemini',
      targetHarness: 'gemini',
      targetAgent: 'gemini-auto-target',
    });
    const blank = harnessMigrationRefusal({ sourceHarness: '', targetHarness: '', targetAgent: 'nameless' });

    // Assert
    should(unknownSource).containEql('records harness "gemini"');
    should(unknownSource).containEql('claude, codex');
    should(unknownTarget).containEql('declares harness "gemini"');
    should(unknownTarget).containEql('gemini-auto-target');
    // Identical and unrecognised is still refused: sameness proves nothing about a family whose
    // transcripts, tool ids and resume arguments this daemon cannot reason about at all.
    should(bothUnknownAndIdentical).containEql('records harness "gemini"');
    should(blank).containEql('records harness ""');
  });
});
