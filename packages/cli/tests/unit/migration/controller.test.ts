import { describe, it } from 'bun:test';
import should from 'should';
import { MigrationController, renderConversionPreview } from '../../../src/lib/migration/controller.ts';
import { RecordingProgress } from '../progress/fixtures.ts';
import { migrationHarness, READY_PREVIEW, RecordingMigrationGateway } from './fixtures.ts';

describe('session migration', () => {
  it('should trim and pass the complete migration request through the daemon gate', async () => {
    // Arrange
    const { gateway, io, presenter } = migrationHarness();
    const subject = new MigrationController(gateway, presenter);

    // Act
    await subject.execute('  Fable  ', {
      agent: '  codex-secondary  ',
      model: '  gpt-5.6-sol  ',
      allowContextDowngrade: true,
      requestId: '  logical-move-1  ',
    });

    // Assert
    should(gateway.calls).deepEqual([
      {
        id: 'Fable',
        agent: 'codex-secondary',
        model: 'gpt-5.6-sol',
        allowContextDowngrade: true,
        requestId: 'logical-move-1',
        forceInflight: false,
      },
    ]);
    should(io.out[0]).containEql('codex-secondary');
  });

  it('should omit blank optional models and let the client mint an idempotency key', async () => {
    // Arrange
    const { gateway, presenter } = migrationHarness();
    const subject = new MigrationController(gateway, presenter);

    // Act
    await subject.execute('ses-1', { agent: 'codex-secondary', model: '   ' });

    // Assert
    should(gateway.calls).deepEqual([
      { id: 'ses-1', agent: 'codex-secondary', allowContextDowngrade: false, forceInflight: false },
    ]);
  });

  it('should pass a conversation choice through and refuse one the daemon does not know', async () => {
    // Arrange
    const { gateway, presenter } = migrationHarness();
    const subject = new MigrationController(gateway, presenter);

    // Act
    await subject.execute('ses-1', { agent: 'claude-default', conversation: ' previous ' });
    const refused = subject.execute('ses-1', { agent: 'claude-default', conversation: 'guess' });

    // Assert
    await should(refused).be.rejectedWith('--conversation must be one of resume, fresh, previous, convert');
    should(gateway.calls).deepEqual([
      {
        id: 'ses-1',
        agent: 'claude-default',
        allowContextDowngrade: false,
        forceInflight: false,
        conversation: 'previous',
      },
    ]);
  });

  it('should print the schema-parsed session under --json', async () => {
    // Arrange
    const { gateway, io, presenter } = migrationHarness();
    const subject = new MigrationController(gateway, presenter);

    // Act
    await subject.execute('ses-1', { agent: 'codex-secondary', json: true });

    // Assert
    should(JSON.parse(io.out[0] ?? '')).have.properties('config', 'state', 'directory');
  });

  it('should reject blank required values before the destructive call', async () => {
    // Arrange
    const { gateway, presenter } = migrationHarness();
    const subject = new MigrationController(gateway, presenter);

    // Act + Assert
    await should(subject.execute('   ', { agent: 'codex-secondary' })).be.rejectedWith(
      'a session id or callsign is required',
    );
    await should(subject.execute('ses-1', { agent: '   ' })).be.rejectedWith('--agent must name a fleet account');
    await should(subject.execute('ses-1', { agent: 'codex-secondary', requestId: '   ' })).be.rejectedWith(
      '--request-id must not be blank',
    );
    should(gateway.calls).be.empty();
  });

  it('should treat --convert as the convert conversation and refuse it beside a different --conversation', async () => {
    // Arrange
    const { gateway, presenter } = migrationHarness();
    const subject = new MigrationController(gateway, presenter);

    // Act
    await subject.execute('ses-1', { agent: 'codex-secondary', convert: true });
    await subject.execute('ses-1', { agent: 'codex-secondary', convert: true, conversation: 'convert' });
    const refused = subject.execute('ses-1', { agent: 'codex-secondary', convert: true, conversation: 'fresh' });

    // Assert
    await should(refused).be.rejectedWith(
      '--convert and --conversation fresh ask for different things; pass one of them',
    );
    should(gateway.calls.map(call => call.conversation)).deepEqual(['convert', 'convert']);
  });

  it('should print a conversion preview, as lines or JSON, without moving anything', async () => {
    // Arrange
    const { gateway, io, presenter } = migrationHarness();
    const subject = new MigrationController(gateway, presenter);

    // Act
    await subject.execute('ses-1', { agent: 'codex-secondary', model: 'gpt-5.6-sol', convert: true, preview: true });
    await subject.execute('ses-1', { agent: 'codex-secondary', convert: true, preview: true, json: true });

    // Assert
    should(gateway.calls).be.empty();
    should(gateway.previews).deepEqual([
      { id: 'ses-1', agent: 'codex-secondary', model: 'gpt-5.6-sol' },
      { id: 'ses-1', agent: 'codex-secondary' },
    ]);
    should(io.out.slice(0, -1)).deepEqual([...renderConversionPreview(READY_PREVIEW)]);
    should(JSON.parse(io.out.at(-1) ?? '')).deepEqual(READY_PREVIEW);
  });

  it('should refuse --preview without --convert, since only a conversion has one', async () => {
    // Arrange
    const { gateway, presenter } = migrationHarness();
    const subject = new MigrationController(gateway, presenter);

    // Act + Assert
    await should(subject.execute('ses-1', { agent: 'codex-secondary', preview: true })).be.rejectedWith(
      '--preview needs --convert: only a conversion has a preview',
    );
    should(gateway.previews).be.empty();
  });

  it('should describe every part of a ready preview in plain words', () => {
    // Arrange + Act
    const lines = renderConversionPreview(READY_PREVIEW);

    // Assert
    should(lines).deepEqual([
      'Moving onto codex-secondary (gpt-5.6-sol, Codex 0.163.0), converted from Claude Code 2.1.281.',
      '12 of 40 turns will move; the 28 oldest are left out to fit.',
      'The newest turn is too long and will be shortened.',
      '9 shell commands carry over as Codex commands; 31 other tool calls become short text notes.',
      '2 attachments carry over as file references.',
      'Not carried: thinking (14), subagent work (3), harness notes (57).',
      'Earlier history was already compacted; its summary carries over.',
      'Run the same command without --preview to move it. The original conversation stays on disk.',
    ]);
  });

  it('should leave out the parts of a small preview that are zero, and name a refusal', () => {
    // Arrange
    const small = {
      ...READY_PREVIEW,
      summary: {
        ...READY_PREVIEW.summary,
        sourceHarness: 'codex',
        targetHarness: 'claude',
        turns: 1,
        keptTurns: 1,
        omittedTurns: 0,
        cutNewest: false,
        nativeToolCalls: 1,
        toolCallsAsText: 1,
        attachments: 0,
        dropped: { reasoning: 0, sidechains: 0, internal: 0, compactions: 0 },
      },
    } as const;
    const { sourceVersion: _unrecorded, ...unversioned } = small.summary;

    // Act
    const lines = renderConversionPreview({ ...small, summary: unversioned });
    const refused = renderConversionPreview({ kind: 'refused', targetAgent: 'claude-default', reason: 'Too new.' });

    // Assert
    should(lines).deepEqual([
      'Moving onto codex-secondary (gpt-5.6-sol, Claude Code 0.163.0), converted from Codex.',
      'All 1 turn will move.',
      '1 shell command carries over as Claude Code commands; 1 other tool call becomes a short text note.',
      'Run the same command without --preview to move it. The original conversation stays on disk.',
    ]);
    should(refused).deepEqual(["Can't convert onto claude-default: Too new."]);
    should(new RecordingMigrationGateway()).have.property('previews');
  });
});

describe('session migration progress', () => {
  it('should name the move, and leave the result for after the step', async () => {
    // Arrange
    const progress = new RecordingProgress();
    const { gateway, io, presenter } = migrationHarness();
    const subject = new MigrationController(gateway, presenter, progress);

    // Act
    await subject.execute('ses-1', { agent: 'codex-secondary' });

    // Assert
    should(progress.events).deepEqual(['start Moving ses-1 to codex-secondary', 'succeed']);
    should(io.out.length).be.above(0);
  });

  it('should name the preview too', async () => {
    // Arrange
    const progress = new RecordingProgress();
    const { gateway, presenter } = migrationHarness();
    const subject = new MigrationController(gateway, presenter, progress);

    // Act
    await subject.execute('ses-1', { agent: 'codex-secondary', convert: true, preview: true });

    // Assert
    should(progress.events).deepEqual(['start Previewing the conversion', 'succeed']);
  });
});
