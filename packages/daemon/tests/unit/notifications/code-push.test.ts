import { describe, it } from 'bun:test';
import type { InputTargetFacts, PushDeliveryResult } from '@ferretry/protocol';
import should from 'should';
import { KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
} from '../../../src/lib/agenda/index.ts';
import { InputAgendaAdapter } from '../../../src/lib/input-requests/agenda-adapter.ts';
import type { InputRequestService } from '../../../src/lib/input-requests/service.ts';
import { AgendaBuzz } from '../../../src/lib/notifications/buzz.ts';
import { NotificationService } from '../../../src/lib/notifications/service.ts';
import type { NotificationLedgerEntry, NotificationRecord } from '../../../src/lib/notifications/types.ts';
import type { PushDispatch } from '../../../src/lib/push/types.ts';
import { FACTS, inputRequestService, RAISE, SESSION } from '../input-requests/support.ts';

/**
 * THE OWNER'S ASK, WIRED END TO END: a card asking for a one-time code pushes at high priority the moment it is raised.
 * Nothing here is a stubbed lookup: the input service raises on the real agenda, the real buzz hears the raise, and the
 * real notification service asks the input service what the card is about, exactly as fyd.ts wires them. The push is
 * made INSIDE the raise, before the request is held, which is what this proves the subject survives.
 */

const NOW = '2026-10-30T12:00:00.000Z';

class Boards implements AgendaLedgerRepository {
  ledger: AgendaLedger | null = null;

  async read(): Promise<AgendaLedger | null> {
    return this.ledger;
  }

  async transact(_sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(this.ledger);
    if (mutation.ok && mutation.changed) this.ledger = mutation.ledger;
    return mutation;
  }
}

class Ledger {
  readonly records: NotificationRecord[] = [];

  async find(key: string): Promise<NotificationLedgerEntry | undefined> {
    const requested = this.records.find(record => record.key === key && record.phase === 'requested');
    return requested === undefined || requested.phase !== 'requested' ? undefined : { requested };
  }

  async append(record: NotificationRecord): Promise<void> {
    this.records.push(record);
  }
}

function wired(facts: InputTargetFacts) {
  const dispatches: PushDispatch[] = [];
  const boards = new Boards();
  const clock = { now: () => NOW };
  let input: InputRequestService | undefined;
  const notifications = new NotificationService({
    ledger: new Ledger(),
    sessions: { describe: async () => ({ name: 'Hadi', interactive: true }) },
    push: {
      list: async () => [{}],
      notify: async (dispatch): Promise<PushDeliveryResult> => {
        dispatches.push(dispatch);
        return { delivered: 1, failed: 0 };
      },
    },
    serial: new KeyedSerialExecutor(),
    clock,
    subjectOf: (sessionId, item) =>
      item.input === undefined ? 'other' : (input?.pushSubjectOf(sessionId, item.input.requestId) ?? 'other'),
  });
  const buzz = new AgendaBuzz(boards, { current: async () => undefined }, notifications, clock);
  const agenda = new AgendaService(boards, clock, { has: async () => true }, buzz, { changed: async () => undefined });
  input = inputRequestService({ facts, agenda: new InputAgendaAdapter(agenda) }).service;
  return { service: input, dispatches };
}

describe('a one-time code card, raised on the real agenda', () => {
  const OTP = {
    ...FACTS,
    foreground: { ...FACTS.foreground, comm: 'ssh', argv: 'ssh bastion' },
    program: 'ssh',
    echo: 'on',
    promptLine: 'Verification code:',
  } as InputTargetFacts;

  it('should push at high priority the moment it is raised, while its ferret still waits', async () => {
    // Arrange
    const { service, dispatches } = wired(OTP);

    // Act
    await service.raise(SESSION, { ...RAISE, prompt: 'The bastion wants the 2FA code', sensitivity: 'code' });

    // Assert — one push, high, under the card's own tag, carrying no value.
    should(dispatches).have.length(1);
    should(dispatches[0]?.urgency).equal('high');
    should(dispatches[0]?.payload).containDeep({ urgency: 'high' });
    should(dispatches[0]?.payload.tag).endWith(':A1');
  });

  it('should push a password card at its raise too, at normal priority', async () => {
    // Arrange
    const { service, dispatches } = wired(FACTS);

    // Act
    await service.raise(SESSION, RAISE);

    // Assert
    should(dispatches).have.length(1);
    should(dispatches[0]?.urgency).be.undefined();
  });
});
