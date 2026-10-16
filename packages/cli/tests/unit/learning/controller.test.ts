import { describe, it } from 'bun:test';
import should from 'should';
import { LearningController } from '../../../src/lib/learning/controller';
import { applyPreview, CapturingOutput, proposal, RecordingLearningGateway } from './fixtures';

function controller(gateway = new RecordingLearningGateway()): {
  subject: LearningController;
  gateway: RecordingLearningGateway;
  out: CapturingOutput;
} {
  const out = new CapturingOutput();
  return { subject: new LearningController(gateway, out, 'fy'), gateway, out };
}

describe('learning listing', () => {
  it('should default to the pending board, the only state that asks anything of a human', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act
    await subject.list({});

    // Assert
    should(gateway.listed).eql(['pending']);
  });

  it('should widen to every state under --all', async () => {
    // Arrange
    const { subject, gateway, out } = controller(
      new RecordingLearningGateway([proposal('p1'), proposal('p2', { state: 'accepted' })]),
    );

    // Act
    await subject.list({ all: true });

    // Assert
    should(gateway.listed).eql([undefined]);
    should(out.text).containEql('2 proposals');
  });

  it('should refuse a state the protocol does not define instead of forwarding the typo', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act + Assert
    await should(subject.list({ state: 'pendign' })).be.rejectedWith(
      '--state must be one of pending, accepted, applied, rejected, not "pendign"',
    );
    should(gateway.listed).be.empty();
  });

  it('should refuse --all together with --state rather than silently picking one', async () => {
    // Arrange
    const { subject } = controller();

    // Act + Assert
    await should(subject.list({ all: true, state: 'accepted' })).be.rejectedWith(
      '--all and --state contradict each other; pass one',
    );
  });

  it('should treat a blank --state as absent', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act
    await subject.list({ state: '   ' });

    // Assert
    should(gateway.listed).eql(['pending']);
  });

  it('should emit the protocol payload under --json', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.list({ json: true });

    // Assert
    should(JSON.parse(out.text)).be.an.Array().and.have.length(1);
  });
});

describe('learning show', () => {
  it('should find the proposal on the whole board, evidence included', async () => {
    // Arrange
    const { subject, gateway, out } = controller(new RecordingLearningGateway([proposal('p1'), proposal('p2')]));

    // Act
    await subject.show('p2', {});

    // Assert
    should(gateway.listed).eql([undefined]);
    should(out.text).startWith('p2  [pending]');
  });

  it('should name the id it could not find rather than printing an empty detail', async () => {
    // Arrange
    const { subject } = controller();

    // Act + Assert
    await should(subject.show('nope', {})).be.rejectedWith('no learning proposal "nope"');
  });

  it('should refuse a blank id instead of requesting an empty path segment', async () => {
    // Arrange
    const { subject } = controller();

    // Act + Assert
    await should(subject.show('  ', {})).be.rejectedWith('a proposal id is required');
  });
});

describe('learning judgements', () => {
  it('should accept a proposal and confirm the state it now holds', async () => {
    // Arrange
    const { subject, gateway, out } = controller();

    // Act
    await subject.accept(' p1 ', {});

    // Assert
    should(gateway.acted).eql([{ id: 'p1', request: { action: 'accept' } }]);
    should(out.text).containEql('accepted p1 — now accepted');
  });

  it('should record the reason a proposal was rejected', async () => {
    // Arrange
    const { subject, gateway } = controller(
      new RecordingLearningGateway([proposal('p1')], proposal('p1', { state: 'rejected' })),
    );

    // Act
    await subject.reject('p1', { note: ' too narrow ' });

    // Assert
    should(gateway.acted[0]?.request).eql({ action: 'reject', note: 'too narrow' });
  });

  it('should omit a blank note rather than sending an empty string', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act
    await subject.reject('p1', { note: '   ' });

    // Assert
    should(gateway.acted[0]?.request).eql({ action: 'reject' });
  });

  it('should reword a proposal from the words the human typed', async () => {
    // Arrange
    const { subject, gateway, out } = controller();

    // Act
    await subject.edit('p1', ['install', 'from', 'the', 'package', 'directory'], {});

    // Assert
    should(gateway.acted[0]?.request).eql({ action: 'edit', ruleText: 'install from the package directory' });
    should(out.text).containEql('reworded p1');
  });

  it('should refuse an edit with no replacement text', async () => {
    // Arrange
    const { subject } = controller();

    // Act + Assert
    await should(subject.edit('p1', ['  '], {})).be.rejectedWith('edit needs the replacement rule text');
  });

  it('should change where a lesson goes', async () => {
    // Arrange
    const { subject, gateway, out } = controller();

    // Act
    await subject.categorize('p1', 'repo', {});

    // Assert
    should(gateway.acted).eql([{ id: 'p1', request: { action: 'categorize', category: 'repo' } }]);
    should(out.text).containEql('categorized p1');
  });

  it('should refuse a category the protocol does not define', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act + Assert
    await should(subject.categorize('p1', 'project', {})).be.rejectedWith(
      'category must be one of global, repo, not "project"',
    );
    should(gateway.acted).be.empty();
  });

  it('should reopen a judged lesson', async () => {
    // Arrange
    const { subject, gateway, out } = controller();

    // Act
    await subject.reopen('p1', {});

    // Assert
    should(gateway.acted).eql([{ id: 'p1', request: { action: 'reopen' } }]);
    should(out.text).containEql('reopened p1');
  });
});

describe('learning apply', () => {
  it('should show the preview and write nothing without --yes', async () => {
    // Arrange
    const { subject, gateway, out } = controller();

    // Act
    await subject.apply('p1', {});

    // Assert
    should(gateway.previewed).eql(['p1']);
    should(gateway.applied).be.empty();
    should(out.text).containEql('nothing written yet');
    should(out.text).containEql('fy learning apply p1 --yes');
  });

  it('should apply with the previewed etag only under --yes', async () => {
    // Arrange
    const { subject, gateway, out } = controller(
      new RecordingLearningGateway(
        [proposal('p1')],
        proposal('p1'),
        undefined,
        undefined,
        undefined,
        undefined,
        applyPreview({ etag: 'etag-9' }),
        proposal('p1', { state: 'applied' }),
      ),
    );

    // Act
    await subject.apply('p1', { yes: true });

    // Assert
    should(gateway.previewed).eql(['p1']);
    should(gateway.applied).eql([{ id: 'p1', etag: 'etag-9' }]);
    should(out.text).containEql('applied p1 — now applied');
  });
});

describe('learning scan', () => {
  it('should estimate by default, scoped to every ferret not instructed to learn', async () => {
    // Arrange
    const { subject, gateway, out } = controller();

    // Act
    await subject.scan({});

    // Assert
    should(gateway.estimated).eql([{ scope: { kind: 'not-passive' } }]);
    should(gateway.scanned).be.empty();
    should(out.text).containEql('re-run with --start');
  });

  it('should narrow the scope to the named sessions, trimmed and de-blanked', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act
    await subject.scan({ sessions: ' s1 , s2,, s3 ', agent: ' miner ', model: ' opus ' });

    // Assert
    should(gateway.estimated).eql([
      { scope: { kind: 'sessions', sessionIds: ['s1', 's2', 's3'] }, agent: 'miner', model: 'opus' },
    ]);
  });

  it('should actually scan only under --start', async () => {
    // Arrange
    const { subject, gateway, out } = controller();

    // Act
    await subject.scan({ start: true });

    // Assert
    should(gateway.scanned).eql([{ scope: { kind: 'not-passive' } }]);
    should(gateway.estimated).be.empty();
    should(out.text).containEql('scan scan-1');
  });

  it('should refuse --estimate and --start together', async () => {
    // Arrange
    const { subject } = controller();

    // Act + Assert
    await should(subject.scan({ estimate: true, start: true })).be.rejectedWith(
      'scan once: pass --estimate or --start, not both',
    );
  });
});

describe('learning runs, status and patches', () => {
  it('should mine without spawning miners unless asked', async () => {
    // Arrange
    const { subject, gateway, out } = controller();

    // Act
    await subject.run({});

    // Assert
    should(gateway.ran).eql([false]);
    should(out.text).containEql('run run-7');
  });

  it('should pass --spawn through to the daemon', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act
    await subject.run({ spawn: true });

    // Assert
    should(gateway.ran).eql([true]);
  });

  it('should report the subsystem status', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.status({});

    // Assert
    should(out.text).containEql('learning is enabled');
  });

  it('should report the mining config', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.config({});

    // Assert
    should(out.text).containEql('miner: miner');
  });

  it('should print the guidance patch for the human to apply', async () => {
    // Arrange
    const { subject, gateway, out } = controller();

    // Act
    await subject.patch('p1', {});

    // Assert
    should(gateway.patched).eql(['p1']);
    should(out.text).containEql('the daemon never writes it');
  });

  it('should emit machine payloads under --json for every read verb', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.status({ json: true });
    await subject.config({ json: true });
    await subject.run({ json: true });
    await subject.patch('p1', { json: true });
    await subject.show('p1', { json: true });
    await subject.accept('p1', { json: true });

    // Assert — every line is a parseable protocol payload, not a human rendering
    should(out.lines).have.length(6);
    for (const line of out.lines) should(JSON.parse(line)).be.an.Object();
  });
});
