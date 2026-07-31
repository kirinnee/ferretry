import { describe, it } from 'bun:test';
import should from 'should';
import {
  renderLearningConfig,
  renderLearningPatch,
  renderLearningStatus,
  renderProposalAction,
  renderProposalDetail,
  renderProposalList,
  renderRunManifest,
} from '../../../src/lib/learning/render';
import { evidence, learningConfig, learningStatus, patchResponse, proposal, runManifest } from './fixtures';

describe('proposal list rendering', () => {
  it('should say plainly that nothing is waiting rather than printing an empty header', () => {
    // Act + Assert
    should(renderProposalList([], 'pending')).equal('No pending proposals.');
    should(renderProposalList([], undefined)).equal('No proposals.');
  });

  it('should order the strongest proposal first, not the order the store yielded', () => {
    // Arrange — the store order is deliberately the reverse of the strength order
    const weak = proposal('weak', { occurrences: 1, crossRepoCount: 1 });
    const strong = proposal('strong', { occurrences: 9, crossRepoCount: 3 });

    // Act
    const lines = renderProposalList([weak, strong], 'pending').split('\n');

    // Assert
    should(lines[0]).equal('2 pending proposals — strongest first');
    should(lines[1]).containEql('strong');
  });

  it('should break an occurrence tie on repo spread, then on id', () => {
    // Arrange
    const narrow = proposal('b', { occurrences: 4, crossRepoCount: 1 });
    const wide = proposal('a', { occurrences: 4, crossRepoCount: 5 });
    const alsoNarrow = proposal('a2', { occurrences: 4, crossRepoCount: 1 });

    // Act
    const ids = renderProposalList([narrow, wide, alsoNarrow], undefined)
      .split('\n')
      .filter(line => /^ {2}\S/u.test(line))
      .map(line => line.trim().split(' ')[0]);

    // Assert
    should(ids).eql(['a', 'a2', 'b']);
  });

  it('should name the singular case without pluralising it', () => {
    // Act
    const rendered = renderProposalList([proposal('p1', { occurrences: 1, crossRepoCount: 1 })], 'accepted');

    // Assert
    should(rendered.split('\n')[0]).equal('1 accepted proposal — strongest first');
    should(rendered).containEql('1 occurrence across 1 repo');
  });

  it('should elide a title too long to read on one line', () => {
    // Arrange
    const long = proposal('p1', { title: 'x'.repeat(200) });

    // Act
    const rendered = renderProposalList([long], undefined);

    // Assert
    should(rendered).containEql('…');
    should(rendered.split('\n')[1]?.length).be.belowOrEqual(115);
  });
});

describe('proposal detail rendering', () => {
  it('should show the rule, the target and every quote behind it', () => {
    // Arrange
    const view = proposal('p1', {
      evidence: [evidence(), evidence({ observationId: 'obs-2', source: 'teammate', teammate: 'sol' })],
    });

    // Act
    const rendered = renderProposalDetail(view);

    // Assert
    should(rendered).containEql('rule: Run bun install inside the target package');
    should(rendered).containEql('target: global-agent-guidance guidance.md');
    should(rendered).containEql('evidence (2)');
    should(rendered).containEql('teammate sol in ferretry');
  });

  it('should name the anchor when the target has one, and omit it when it does not', () => {
    // Arrange
    const anchored = proposal('p1', {
      target: { kind: 'automation-guidance', path: 'guidance.md', anchor: '## Installs' },
    });

    // Act + Assert
    should(renderProposalDetail(anchored)).containEql('guidance.md (## Installs)');
    should(renderProposalDetail(proposal('p1'))).not.containEql('(undefined)');
  });

  it('should render a history note when one was recorded', () => {
    // Arrange
    const judged = proposal('p1', {
      state: 'rejected',
      history: [
        { at: '2026-07-10T09:00:00.000Z', event: 'created', by: 'miner' },
        { at: '2026-07-21T09:00:00.000Z', event: 'rejected', by: 'user', note: 'too narrow' },
      ],
    });

    // Act
    const rendered = renderProposalDetail(judged);

    // Assert
    should(rendered).containEql('rejected by user — too narrow');
    should(rendered).containEql('created by miner');
  });

  it('should elide a quote longer than one readable line', () => {
    // Arrange
    const noisy = proposal('p1', { evidence: [evidence({ quote: 'y'.repeat(280) })] });

    // Act + Assert
    should(renderProposalDetail(noisy)).containEql('…"');
  });
});

describe('mutation and status rendering', () => {
  it('should confirm an action by naming the state the proposal now holds', () => {
    // Act
    const rendered = renderProposalAction('accepted', proposal('p1', { state: 'accepted' }));

    // Assert
    should(rendered).equal('accepted p1 — now accepted: install from the package directory');
  });

  it('should report the subsystem as a human reads it', () => {
    // Act
    const rendered = renderLearningStatus(learningStatus());

    // Assert
    should(rendered).containEql('learning is enabled, mining every 60 minutes');
    should(rendered).containEql('pending: 3 (1 strong, 2 weak)');
    should(rendered).containEql('40 observations, 6 proposals, 1 tombstone');
    should(rendered).containEql('watermark: 2026-07-31T08:00:00.000Z');
  });

  it('should say never rather than printing undefined for a subsystem that has not run', () => {
    // Arrange
    const fresh = learningStatus({
      enabled: false,
      running: true,
      intervalMinutes: 1,
      watermarkAt: undefined,
      lastRunAt: undefined,
    });

    // Act
    const rendered = renderLearningStatus(fresh);

    // Assert
    should(rendered).containEql('learning is disabled, mining every 1 minute (a run is in progress)');
    should(rendered).containEql('watermark: never · last run: never');
  });

  it('should fold the last run into the status when the daemon supplied one', () => {
    // Act
    const rendered = renderLearningStatus(learningStatus({ lastRun: runManifest() }));

    // Assert
    should(rendered).containEql('  run run-7 started');
  });
});

describe('run manifest rendering', () => {
  it('should report what the run scanned and produced', () => {
    // Act
    const rendered = renderRunManifest(runManifest());

    // Assert
    should(rendered).containEql('run run-7 started 2026-07-31T09:00:00.000Z finished 2026-07-31T09:04:00.000Z');
    should(rendered).containEql('scanned 12 sessions, 4 with signal · claude=3 codex=1');
    should(rendered).containEql('2 created, 1 strengthened, 0 suppressed');
    should(rendered).containEql('miners: miner-1');
  });

  it('should mark an unfinished run instead of leaving the reader to infer it', () => {
    // Act
    const rendered = renderRunManifest(
      runManifest({
        finishedAt: undefined,
        minerSessions: [],
        perHarness: { claude: 0, codex: 0 },
        message: 'nothing to mine',
      }),
    );

    // Assert
    should(rendered).containEql('(still running)');
    should(rendered).containEql('miners: none spawned');
    should(rendered).containEql('nothing to mine');
    should(rendered).containEql('claude=0 codex=0');
  });
});

describe('config and patch rendering', () => {
  it('should describe the schedule and the miner', () => {
    // Act
    const rendered = renderLearningConfig(learningConfig({ model: 'opus' }));

    // Assert
    should(rendered).containEql('miner: miner (opus)');
    should(rendered).containEql('every 60 minutes, batches of 20');
    should(rendered).containEql('at most 2 miners over 30 sessions');
    should(rendered).containEql('minimum gap between spawns: 15 minutes');
  });

  it('should omit the model when the config does not pin one', () => {
    // Act
    const rendered = renderLearningConfig(
      learningConfig({ enabled: false, maxMinersPerRun: 1, minSpawnGapMinutes: 1 }),
    );

    // Assert
    should(rendered).containEql('learning is disabled');
    should(rendered).containEql('miner: miner\n');
    should(rendered).containEql('at most 1 miner over 30 sessions');
  });

  it('should state that the human applies the patch, because the daemon never writes it', () => {
    // Act
    const rendered = renderLearningPatch(patchResponse());

    // Assert
    should(rendered).startWith('guidance.md — apply this yourself; the daemon never writes it');
    should(rendered).containEql('- install from the package directory');
  });
});
