import { describe, it } from 'bun:test';
import should from 'should';
import { extractSession, type RawSessionInput } from '../../../src/lib/learning/index.ts';

const baseInput = (overrides: Partial<RawSessionInput> = {}): RawSessionInput => ({
  sessionId: 'session-1',
  teammate: 'violet',
  mode: 'auto',
  cwd: '/workspace',
  repo: '/workspace',
  harness: 'claude',
  status: 'completed',
  records: [],
  turnTexts: [],
  inbox: [],
  interrupts: 0,
  ...overrides,
});

describe('learning extraction', () => {
  it('should skip a routine completed auto session with only its opening brief', () => {
    // Arrange
    const input = baseInput({
      records: [{ type: 'chat.user', timestamp: '2026-07-30T12:00:00.000Z', data: { text: 'Implement the task.' } }],
      turnTexts: ['Implement the task.'],
    });

    // Act
    const actual = extractSession(input);

    // Assert
    should(actual.hasSignal).be.false();
    should(actual.signalReasons).deepEqual([]);
    should(actual.corpus).equal('Implement the task.\nImplement the task.');
    should(actual.at).equal('2026-07-30T12:00:00.000Z');
  });

  it('should include human-side material but never assistant output in the verification corpus', () => {
    // Arrange
    const input = baseInput({
      mode: 'interactive',
      finishedAt: '2026-07-30T14:00:00.000Z',
      records: [
        { type: 'chat.user', data: { text: 'Initial request' } },
        { type: 'chat.assistant', data: { text: 'MODEL SECRET' } },
        { type: 'chat.user', data: { text: 'Use direnv exec .' } },
      ],
      turnTexts: ['Keep commands safe'],
      inbox: [{ text: 'Also run the tests' }, { text: 'Check the gate', from: 'lead', fromName: 'Ari' }],
    });

    // Act
    const actual = extractSession(input);

    // Assert
    should(actual.hasSignal).be.true();
    should(actual.humanMessages).equal(2);
    should(actual.teammateSteers).equal(1);
    should(actual.corpus).containEql('Use direnv exec .');
    should(actual.corpus).not.containEql('MODEL SECRET');
    should(actual.digest).containEql('[steer(Ari)] Check the gate');
    should(actual.signalReasons).containEql('interactive session (human at the wheel)');
  });

  it('should identify non-routine auto-session signals and count repeated tool failures', () => {
    // Arrange
    const input = baseInput({
      status: 'failed',
      records: [
        { type: 'tool.result', data: { isError: true } },
        { type: 'tool.result', data: { isError: true } },
        { type: 'tool.result', data: { isError: false } },
      ],
      inbox: [{ text: 'Please retry this', from: 'lead' }],
      interrupts: 1,
    });

    // Act
    const actual = extractSession(input);

    // Assert
    should(actual.hasSignal).be.true();
    should(actual.toolFailures).equal(2);
    should(actual.signalReasons).deepEqual([
      '1 lead/peer steer(s)',
      '1 interrupt(s)',
      '2 tool failures',
      'terminal status failed',
    ]);
  });

  it('should cap the miner digest without changing the full verification corpus', () => {
    // Arrange
    const longText = 'x'.repeat(8_100);
    const input = baseInput({ turnTexts: [longText] });

    // Act
    const actual = extractSession(input);

    // Assert
    should(actual.corpus).equal(longText);
    should(actual.digest).endWith('… [truncated]');
    should(actual.digest.length).equal(8_014);
  });
});
