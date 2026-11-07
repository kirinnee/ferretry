import { describe, it } from 'bun:test';
import should from 'should';
import { FerretSummarySchema } from '../../../../contract/ids.ts';
import { ferretStateOf, ferretSummaryOfSessionView } from '../../../../daemon/lib/moves/ferret-view.ts';
import type { SessionStatus } from '../../../../daemon/lib/protocol/session-base.ts';
import { sessionView } from '../../../support/daemon/session-view.ts';

/**
 * A moved session in the words the command line parses. The conversion is pure, so every case is a view in and a
 * summary out; what the summary cannot carry is named in `ferret-view.ts` and pinned here by what is NOT in the result.
 */

describe('ferretSummaryOfSessionView', () => {
  it('should answer a summary the contract itself accepts, with the account as the runtime', () => {
    // Arrange
    const view = sessionView('s1', { agent: 'codex-auto', model: 'gpt-5.6-terra', cwd: '/work/repo' });

    // Act
    const summary = ferretSummaryOfSessionView(view);

    // Assert
    should(FerretSummarySchema.parse(summary)).deepEqual(summary);
    should(summary).match({
      id: 's1',
      runtime: 'codex-auto',
      model: 'gpt-5.6-terra',
      folder: '/work/repo',
      role: 'lead',
      runner: 'tmux',
    });
  });

  it('should make a session with a parent a helper, and one without a lead', () => {
    // Arrange
    const lead = sessionView('s1');
    const helper = sessionView('s2', { parent: 's1' });

    // Act
    const answers = [ferretSummaryOfSessionView(lead), ferretSummaryOfSessionView(helper)];

    // Assert
    should(answers.map(summary => summary.role)).deepEqual(['lead', 'helper']);
    should(answers[1]?.parent).equal('s1');
    should(answers[0]).not.have.property('parent');
  });

  it('should restate the callsign as the name and the session name as the title', () => {
    // Arrange
    const view = sessionView('s1', { teammate: 'Fable', name: 'Wire Subsystems' });

    // Act
    const summary = ferretSummaryOfSessionView(view);

    // Assert
    should(summary.name).equal('Fable');
    should(summary.title).equal('Wire Subsystems');
  });

  it('should fall back to a name the contract accepts when the session has no callsign', () => {
    // Arrange
    const view = sessionView('s1', { teammate: undefined, name: '!!! odd / name' });

    // Act
    const summary = ferretSummaryOfSessionView(view);

    // Assert
    should(FerretSummarySchema.safeParse(summary).success).be.true();
  });

  it('should carry none of the launch record, the move record or the pane state', () => {
    // Arrange
    const view = sessionView('s1', {}, { status: 'running', turn: 7, pid: 4242 });

    // Act
    const summary = ferretSummaryOfSessionView(view) as Record<string, unknown>;

    // Assert
    for (const dropped of ['config', 'directory', 'incarnation', 'runtimeGeneration', 'turn', 'pid', 'moves'])
      should(summary).not.have.property(dropped);
  });
});

describe('ferretStateOf', () => {
  const table: ReadonlyArray<readonly [SessionStatus, string]> = [
    ['created', 'starting'],
    ['starting', 'starting'],
    ['running', 'working'],
    ['thinking', 'working'],
    ['tool_running', 'working'],
    ['retrying', 'working'],
    ['completed', 'stopped'],
    ['failed', 'stopped'],
    ['stopped', 'stopped'],
    ['kill_failed', 'stopped'],
    ['awaiting_question', 'idle'],
    ['awaiting_user', 'idle'],
    ['waiting', 'idle'],
    ['interrupted', 'idle'],
    ['rate_limited', 'idle'],
    ['stalled', 'idle'],
  ];

  for (const [status, state] of table)
    it(`should read ${status} as ${state}`, () => {
      // Arrange + Act
      const answer = ferretStateOf(status);

      // Assert
      should(answer).equal(state);
    });
});
