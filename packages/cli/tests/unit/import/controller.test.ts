import { describe, it } from 'bun:test';
import should from 'should';
import {
  ContinueSessionController,
  ImportController,
  parseSinceDuration,
  sinceInstant,
} from '../../../src/lib/import/controller.ts';
import {
  CapturingImportOutput,
  conversation,
  listing,
  NOW_MS,
  RecordingImportGateway,
  ScriptedPrompt,
} from './fixtures.ts';

const CONTEXT = { now: () => NOW_MS, binaryName: 'fy' };

function importController(gateway = new RecordingImportGateway()) {
  const out = new CapturingImportOutput();
  return { subject: new ImportController(gateway, out, CONTEXT), gateway, out };
}

function continueController(
  gateway = new RecordingImportGateway(),
  prompt = new ScriptedPrompt([]),
  interactive = false,
) {
  const out = new CapturingImportOutput();
  return { subject: new ContinueSessionController(gateway, out, prompt, { ...CONTEXT, interactive }), gateway, out };
}

describe('parseSinceDuration', () => {
  it('should read days, hours and weeks', () => {
    // Act + Assert
    should(parseSinceDuration('7d')).equal(7 * 86_400_000);
    should(parseSinceDuration('2h')).equal(2 * 3_600_000);
    should(parseSinceDuration('1w')).equal(604_800_000);
  });

  it('should reject anything else', () => {
    // Act + Assert
    should(() => parseSinceDuration('7')).throw(/--since takes/);
    should(() => parseSinceDuration('7days')).throw(/--since takes/);
    should(() => parseSinceDuration('')).throw(/--since takes/);
  });
});

describe('sinceInstant', () => {
  it('should subtract the duration from now and emit an ISO instant', () => {
    // Act
    const instant = sinceInstant('1d', () => NOW_MS);

    // Assert
    should(instant).equal(new Date(NOW_MS - 86_400_000).toISOString());
  });
});

describe('ImportController.list', () => {
  it('should ask for nothing extra when no filter was given', async () => {
    // Arrange
    const { subject, gateway } = importController();

    // Act
    await subject.list({});

    // Assert
    should(gateway.queries).eql([{}]);
  });

  it('should pass the query, harness and a converted since instant', async () => {
    // Arrange
    const { subject, gateway } = importController();

    // Act
    await subject.list({ query: 'login bug', harness: 'claude', since: '1d' });

    // Assert
    should(gateway.queries).eql([
      { harness: 'claude', q: 'login bug', since: new Date(NOW_MS - 86_400_000).toISOString() },
    ]);
  });

  it('should render the listing by default and JSON on request', async () => {
    // Arrange
    const row = conversation();
    const { subject, out } = importController(new RecordingImportGateway(listing([row])));

    // Act
    await subject.list({});
    await subject.list({ json: true });

    // Assert
    should(out.messages[0]).containEql(row.id);
    should(JSON.parse(out.messages[1] ?? '')).eql(listing([row]));
  });

  it('should reject a malformed --since before asking the daemon', async () => {
    // Arrange
    const { subject, gateway } = importController();

    // Act + Assert
    await should(subject.list({ since: 'soon' })).be.rejectedWith(/--since takes/);
    should(gateway.queries).be.empty();
  });
});

describe('ImportController.select', () => {
  it('should refuse an empty selection before asking the daemon', async () => {
    // Arrange
    const { subject, gateway } = importController();

    // Act + Assert
    await should(subject.select({ select: [], runtime: 'claude-work' })).be.rejectedWith(
      '--select needs at least one conversation id',
    );
    should(gateway.queries).be.empty();
  });

  it('should require a runtime', async () => {
    // Arrange
    const { subject } = importController();

    // Act + Assert
    await should(subject.select({ select: ['c-1'] })).be.rejectedWith('--runtime is required with --select');
    await should(subject.select({ select: ['c-1'], runtime: '  ' })).be.rejectedWith(
      '--runtime is required with --select',
    );
  });

  it('should refuse more than ten starts before asking the daemon', async () => {
    // Arrange
    const ids = Array.from({ length: 11 }, (_, index) => `c-${index}`);
    const { subject, gateway } = importController();

    // Act + Assert
    await should(subject.select({ select: ids, runtime: 'claude-work', start: true })).be.rejectedWith(/at most 10/);
    should(gateway.queries).be.empty();
  });

  it('should locally refuse unknown ids without calling adopt', async () => {
    // Arrange
    const gateway = new RecordingImportGateway(listing([conversation({ id: 'c-1' })]));
    const { subject, out } = importController(gateway);

    // Act
    await subject.select({ select: ['c-ghost'], runtime: 'claude-work' });

    // Assert
    should(gateway.adoptRequests).be.empty();
    should(out.exitCode).equal(1);
    should(out.messages[0]).containEql('c-ghost');
    should(out.messages[0]).containEql('refused');
  });

  it('should adopt known ids with the given harness, and still report unknown ones as refused', async () => {
    // Arrange
    const gateway = new RecordingImportGateway(listing([conversation({ id: 'c-1', harness: 'codex' })]), {
      adopted: [{ id: 'c-1', session: 's-1', name: 'Fable', status: 'running' }],
      refused: [],
    });
    const { subject, out } = importController(gateway);

    // Act
    await subject.select({ select: ['c-1', 'c-ghost'], runtime: 'codex-work', harness: 'codex', start: true });

    // Assert
    should(gateway.adoptRequests).eql([
      { harness: 'codex', runtime: 'codex-work', conversations: [{ id: 'c-1', start: true }] },
    ]);
    should(out.exitCode).equal(1); // the unknown id still counts as a refusal
    should(out.messages[0]).containEql('s-1');
    should(out.messages[0]).containEql('c-ghost');
  });

  it('should infer the harness from the one matched row when none was given', async () => {
    // Arrange
    const gateway = new RecordingImportGateway(listing([conversation({ id: 'c-1', harness: 'codex' })]));
    const { subject } = importController(gateway);

    // Act
    await subject.select({ select: ['c-1'], runtime: 'codex-work' });

    // Assert
    should(gateway.adoptRequests[0]?.harness).equal('codex');
  });

  it('should refuse to infer a harness spanning more than one', async () => {
    // Arrange
    const gateway = new RecordingImportGateway(
      listing([conversation({ id: 'c-1', harness: 'claude' }), conversation({ id: 'c-2', harness: 'codex' })]),
    );
    const { subject } = importController(gateway);

    // Act + Assert
    await should(subject.select({ select: ['c-1', 'c-2'], runtime: 'work' })).be.rejectedWith(/more than one harness/);
    should(gateway.adoptRequests).be.empty();
  });

  it('should not call adopt when every selected id is unknown', async () => {
    // Arrange
    const gateway = new RecordingImportGateway(listing([]));
    const { subject, out } = importController(gateway);

    // Act
    await subject.select({ select: ['c-ghost'], runtime: 'work' });

    // Assert
    should(gateway.adoptRequests).be.empty();
    should(out.exitCode).equal(1);
  });

  it('should print JSON when asked', async () => {
    // Arrange
    const gateway = new RecordingImportGateway(listing([conversation({ id: 'c-1' })]), {
      adopted: [{ id: 'c-1', session: 's-1', name: 'Fable', status: 'running' }],
      refused: [],
    });
    const { subject, out } = importController(gateway);

    // Act
    await subject.select({ select: ['c-1'], runtime: 'work', json: true });

    // Assert
    should(JSON.parse(out.messages[0] ?? '')).have.property('adopted');
  });
});

describe('ContinueSessionController.run', () => {
  it('should refuse and point at `fy start` when --continue was not given', async () => {
    // Arrange
    const { subject, gateway, out } = continueController();

    // Act
    await subject.run({});

    // Assert
    should(gateway.queries).be.empty();
    should(out.exitCode).equal(1);
    should(out.errors[0]).containEql('fy start');
  });

  it('should refuse when nothing matched', async () => {
    // Arrange
    const { subject, out } = continueController(new RecordingImportGateway(listing([])));

    // Act
    await subject.run({ continue: true });

    // Assert
    should(out.exitCode).equal(1);
    should(out.errors[0]).containEql('no conversations matched');
  });

  it('should open an already-adopted match without adopting again', async () => {
    // Arrange
    const gateway = new RecordingImportGateway(listing([conversation({ id: 'c-1', adoptedBy: 's-1' })]));
    const { subject, out } = continueController(gateway);

    // Act
    await subject.run({ continue: true, runtime: 'work' });

    // Assert
    should(gateway.adoptRequests).be.empty();
    should(out.messages[0]).containEql('already kept as s-1');
    should(out.exitCode).be.undefined();
  });

  it('should adopt the single match and report how to attach', async () => {
    // Arrange
    const gateway = new RecordingImportGateway(listing([conversation({ id: 'c-1', harness: 'claude' })]), {
      adopted: [{ id: 'c-1', session: 's-9', name: 'Fable', status: 'running' }],
      refused: [],
    });
    const { subject, out } = continueController(gateway);

    // Act
    await subject.run({ continue: true, runtime: 'claude-work' });

    // Assert
    should(gateway.adoptRequests).eql([
      { harness: 'claude', runtime: 'claude-work', conversations: [{ id: 'c-1', start: true }] },
    ]);
    should(out.messages[0]).containEql('s-9');
    should(out.messages[0]).containEql('attach');
  });

  it('should refuse a missing runtime non-interactively', async () => {
    // Arrange
    const gateway = new RecordingImportGateway(listing([conversation({ id: 'c-1' })]));
    const { subject, out } = continueController(gateway, new ScriptedPrompt([]), false);

    // Act
    await subject.run({ continue: true });

    // Assert
    should(gateway.adoptRequests).be.empty();
    should(out.exitCode).equal(1);
    should(out.errors[0]).containEql('--runtime');
  });

  it('should ask for a runtime interactively when none was given', async () => {
    // Arrange
    const gateway = new RecordingImportGateway(listing([conversation({ id: 'c-1' })]), {
      adopted: [{ id: 'c-1', session: 's-1', name: 'Fable', status: 'running' }],
      refused: [],
    });
    const {
      subject,
      gateway: recordedGateway,
      out,
    } = continueController(gateway, new ScriptedPrompt(['claude-work']), true);

    // Act
    await subject.run({ continue: true });

    // Assert
    should(recordedGateway.adoptRequests[0]?.runtime).equal('claude-work');
    should(out.messages[0]).containEql('s-1');
  });

  it('should reject an empty interactively-typed runtime', async () => {
    // Arrange
    const gateway = new RecordingImportGateway(listing([conversation({ id: 'c-1' })]));
    const { subject } = continueController(gateway, new ScriptedPrompt(['   ']), true);

    // Act + Assert
    await should(subject.run({ continue: true })).be.rejectedWith('a runtime name is required');
  });

  it('should refuse several matches non-interactively', async () => {
    // Arrange
    const rows = [conversation({ id: 'c-1' }), conversation({ id: 'c-2' })];
    const { subject, out } = continueController(
      new RecordingImportGateway(listing(rows)),
      new ScriptedPrompt([]),
      false,
    );

    // Act
    await subject.run({ continue: true, runtime: 'work' });

    // Assert
    should(out.exitCode).equal(1);
    should(out.errors[0]).containEql('narrow the search');
  });

  it('should let an interactive caller pick among several matches', async () => {
    // Arrange
    const rows = [conversation({ id: 'c-1' }), conversation({ id: 'c-2', project: '/work/other' })];
    const gateway = new RecordingImportGateway(listing(rows), {
      adopted: [{ id: 'c-2', session: 's-2', name: 'Fable', status: 'running' }],
      refused: [],
    });
    const { subject, out } = continueController(gateway, new ScriptedPrompt(['2']), true);

    // Act
    await subject.run({ continue: true, runtime: 'work' });

    // Assert
    should(gateway.adoptRequests[0]?.conversations).eql([{ id: 'c-2', start: true }]);
    should(out.messages[1]).containEql('s-2');
  });

  it('should reject an out-of-range interactive choice', async () => {
    // Arrange
    const rows = [conversation({ id: 'c-1' }), conversation({ id: 'c-2' })];
    const gateway = new RecordingImportGateway(listing(rows));
    const { subject } = continueController(gateway, new ScriptedPrompt(['9']), true);

    // Act + Assert
    await should(subject.run({ continue: true, runtime: 'work' })).be.rejectedWith(/not a listed choice/);
  });

  it('should report a daemon refusal and exit non-zero', async () => {
    // Arrange
    const gateway = new RecordingImportGateway(listing([conversation({ id: 'c-1' })]), {
      adopted: [],
      refused: [{ id: 'c-1', code: 'already_adopted', reason: 'already kept as s-1' }],
    });
    const { subject, out } = continueController(gateway);

    // Act
    await subject.run({ continue: true, runtime: 'work' });

    // Assert
    should(out.exitCode).equal(1);
    should(out.errors[0]).containEql('already kept as s-1');
  });

  it('should pass the query, harness and a since instant to the search', async () => {
    // Arrange
    const gateway = new RecordingImportGateway(listing([conversation({ id: 'c-1' })]), {
      adopted: [{ id: 'c-1', session: 's-1', name: 'Fable', status: 'running' }],
      refused: [],
    });
    const { subject } = continueController(gateway);

    // Act
    await subject.run({ continue: true, query: 'login bug', harness: 'claude', since: '2h', runtime: 'work' });

    // Assert
    should(gateway.queries[0]).eql({
      harness: 'claude',
      q: 'login bug',
      since: new Date(NOW_MS - 2 * 3_600_000).toISOString(),
      limit: 20,
    });
  });

  it('should throw when the daemon neither adopts nor refuses', async () => {
    // Arrange
    const gateway = new RecordingImportGateway(listing([conversation({ id: 'c-1' })]), { adopted: [], refused: [] });
    const { subject } = continueController(gateway);

    // Act + Assert
    await should(subject.run({ continue: true, runtime: 'work' })).be.rejectedWith(
      'the daemon adopted nothing and refused nothing',
    );
  });
});
