import { describe, it } from 'bun:test';
import should from 'should';
import {
  handoffMessage,
  renderMigrationOutcome,
  type MigrationOutcome,
} from '../../../src/lib/migrate/outcome-render.ts';

const attempt: MigrationOutcome = {
  ok: false,
  from: 'claude-loge',
  targetAgent: 'codex-terra',
  at: '2026-07-31T09:05:00.000Z',
};

describe('renderMigrationOutcome', () => {
  it('should confirm a successful move and what the daemon sees afterwards', () => {
    // Act
    const actual = renderMigrationOutcome({
      ...attempt,
      ok: true,
      targetModel: 'gpt-5.6',
      observed: { binary: 'codex-terra', model: 'gpt-5.6', status: 'running' },
    });

    // Assert
    should(actual.split('\n')).deepEqual([
      '## Outcome — MIGRATION SUCCEEDED',
      '',
      '- Settled at: 2026-07-31T09:05:00.000Z',
      '- Migrated from `claude-loge` onto `codex-terra` (model `gpt-5.6`).',
      '- Session now on: `codex-terra` (model `gpt-5.6`)',
      '- Status now: `running`',
      '- The relaunch under the new account completed; everything above describes what it interrupted.',
      '',
      '',
    ]);
  });

  it('should flag a success that landed on an account nobody asked for', () => {
    // Act
    const actual = renderMigrationOutcome({ ...attempt, ok: true, observed: { binary: 'claude-sol' } });

    // Assert
    should(actual).containEql('- Session now on: `claude-sol` — note: this is not the requested `codex-terra`.');
    should(actual).not.containEql('- Status now:');
  });

  it('should omit the observation entirely when the daemon reported none', () => {
    // Act
    const actual = renderMigrationOutcome({ ...attempt, ok: true });

    // Assert
    should(actual).not.containEql('- Session now on:');
    should(actual).containEql('- The relaunch under the new account completed;');
  });

  it('should never claim a rollback it did not verify', () => {
    // Act
    const actual = renderMigrationOutcome({ ...attempt, detail: '  daemon refused  ' });

    // Assert
    should(actual).containEql('## Outcome — MIGRATION FAILED');
    should(actual).containEql('- **The migration did NOT complete.**');
    should(actual).containEql('- Error: daemon refused');
    should(actual).containEql('- Session state after the failure: **UNKNOWN**');
    should(actual).containEql('restored to `claude-loge` is NOT confirmed');
  });

  it('should report a failure with no detail without inventing one', () => {
    // Act
    const actual = renderMigrationOutcome({ ...attempt, detail: '   ' });

    // Assert
    should(actual).containEql('- Error: no detail reported');
  });

  it('should distinguish the three places a failed attempt can leave the session', () => {
    // Act
    const original = renderMigrationOutcome({ ...attempt, observed: { binary: 'claude-loge', status: 'waiting' } });
    const staged = renderMigrationOutcome({ ...attempt, observed: { binary: 'codex-terra', model: 'gpt-5.6' } });
    const elsewhere = renderMigrationOutcome({ ...attempt, observed: { binary: 'claude-sol' } });
    const nowhere = renderMigrationOutcome({ ...attempt, observed: { status: 'stopped' } });

    // Assert
    should(original).containEql('the ORIGINAL account; the session did not move.');
    should(original).containEql('- Status now: `waiting`');
    should(staged).containEql('the REQUESTED target, **not** the original `claude-loge`.');
    should(staged).containEql('the rollback did not complete.');
    should(staged).containEql('- Status now: **UNKNOWN**');
    should(elsewhere).containEql('neither the original `claude-loge` nor the requested `codex-terra`.');
    should(nowhere).containEql('- Session now on: **UNKNOWN** — the daemon reported no wrapper for this session.');
  });
});

describe('handoffMessage', () => {
  it('should point the migrated agent at the report before it retries anything', () => {
    // Act + Assert
    should(handoffMessage('/state/sessions/session-1/migration-inflight.md')).equal(
      'You were migrated mid-turn. Read /state/sessions/session-1/migration-inflight.md — it lists what was running and what to check before re-running anything.',
    );
  });
});
