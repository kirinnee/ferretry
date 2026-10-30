import { describe, it } from 'bun:test';
import should from 'should';
import {
  type ObservationStorage,
  recordTurnChange,
} from '../../../../src/adapters/session/observer/session-observation-applier.ts';
import { parseSessionId } from '../../../../src/lib/index.ts';

/** The usage-limit dialog is recorded as a rate-limited session, and released again when it closes. */

const AT = '2026-10-30T10:00:00.000Z';
const ID = parseSessionId('limited-1');

const DIALOG = {
  id: '0123456789abcdef',
  harness: 'claude' as const,
  selected: 1,
  kind: 'usage-limit' as const,
  title: 'What do you want to do?',
  body: "You've hit your org's monthly spend limit",
  options: [
    { number: 1, label: 'Stop and wait for limit to reset', grantsTrust: false },
    { number: 2, label: 'Wait here, then continue automatically at Nov 1, 12am', grantsTrust: false },
  ],
};

function memory(initial: Record<string, unknown>) {
  const state = { value: initial };
  const storage = {
    async updateState(_id: unknown, update: (raw: unknown) => unknown) {
      state.value = update(state.value) as Record<string, unknown>;
      return state.value;
    },
    async append() {},
  } as unknown as ObservationStorage;
  return { state, storage };
}

const base = { id: 'limited-1', status: 'running', turn: 1, turnState: 'working' };

describe('recordTurnChange on the usage-limit dialog', () => {
  it('should mark the session rate_limited with the quota, and choose nothing', async () => {
    // Arrange
    const { state, storage } = memory(base);

    // Act
    const written = await recordTurnChange(
      storage,
      ID,
      { from: 'working', to: 'needs-input', confirmed: true, dialog: DIALOG } as never,
      AT,
    );

    // Assert
    should(written).be.true();
    should(state.value.status).equal('rate_limited');
    should(state.value.turnState).equal('needs-input');
    should(state.value.quota).containEql({ atLimit: true, unavailable: true, unavailableReason: 'spend_limit' });
    should((state.value.quota as { retryAt?: number }).retryAt).be.a.Number();
  });

  it('should return a session to running, and clear the quota it set, once the dialog is gone', async () => {
    // Arrange
    const { state, storage } = memory({
      ...base,
      status: 'rate_limited',
      turnState: 'needs-input',
      harnessDialog: DIALOG,
      quota: { atLimit: true, unavailable: true, unavailableReason: 'spend_limit', retryAt: 9, resetAt: 9 },
    });

    // Act
    await recordTurnChange(storage, ID, { from: 'needs-input', to: undefined } as never, AT);

    // Assert
    should(state.value.status).equal('running');
    should(state.value.quota).be.undefined();
    should(state.value.harnessDialog).be.undefined();
  });

  it('should leave a session awaiting a question alone', async () => {
    // Arrange
    const { state, storage } = memory({ ...base, status: 'awaiting_question' });

    // Act
    await recordTurnChange(
      storage,
      ID,
      { from: 'working', to: 'needs-input', confirmed: true, dialog: DIALOG } as never,
      AT,
    );

    // Assert
    should(state.value.status).equal('awaiting_question');
    should(state.value.quota).be.undefined();
  });
});
