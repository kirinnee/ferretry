/**
 * Asks' daemon half (§2.2): every question for the owner and the owner's answers, one board per ferret
 * (`state/asks/ferrets/<ferret>/…`, lead decision #13), with today's write order and durability.
 *
 * `build` wires today's agenda engine over the kernel's ports and hands back the nine routes and the Asks port. What
 * another subsystem owns is a seam here, unwired until that subsystem lands, and each says what it does meanwhile:
 *
 * - **Card asks** go to the Board's `ask.sources:card` `apply` before the answer is recorded; with no Board running, an
 *   answer to a card ask is refused and the ask stays open.
 * - **Held configuration edits** (`--confirms`): no config port yet, so `--confirms` is refused.
 * - **Clear all from agent ferrets**: which ferrets are agent ferrets is the Agenda plugin's; meanwhile `503`.
 * - **Answers into a ferret's terminal**: typing into a ferret is Conversation's, provided under `ask.delivery:ferret`;
 *   unprovided, answers are held in the ferret's outbox, never lost, and shown as held.
 * - **Which ferrets exist**: Ferrets needs Asks, so Asks cannot ask Ferrets (a core cycle): any well-formed ferret id
 *   has a board, and an owner raise for a ferret that does not exist makes an orphan board (a known gap; every
 *   ferret's own raise comes through its own token).
 * - **Push counts** after a raise: Notify's; meanwhile a raise says nothing about devices.
 */
import { randomUUID } from 'node:crypto';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { AskDeliveries, AskSources, type SourceKey } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { askDelivery } from './adapters/ask-delivery.ts';
import { asksPort } from './adapters/asks-port.ts';
import { CARD_SOURCE, cardAskAnswers } from './adapters/card-ask-answers.ts';
import { FileAgendaLedgerRepository } from './adapters/agenda/file-agenda-ledger-repository.ts';
import { FileAgendaOutboxRepository } from './adapters/agenda/file-agenda-outbox-repository.ts';
import { FileAgendaSeenStore, SqliteAgendaVersionStore } from './adapters/agenda/file-agenda-versions.ts';
import { KeyedAgendaReplyTimers } from './adapters/agenda/keyed-agenda-reply-timers.ts';
import { StateAgendaFiles } from './adapters/agenda/state-agenda-files.ts';
import {
  AgendaReplyBatcher,
  AgendaService,
  isAgendaSessionId,
} from './lib/agenda/index.ts';
import { KeyedSerialQueue } from './lib/agenda/serial-queue.ts';
import { agendaRoutes } from './lib/routes/agenda.ts';
import { agendaClearRoutes } from './lib/routes/agenda-clear.ts';
import { AgendaLedgerFiles } from './lib/state.ts';

export default implementDaemon(manifest, {
  build({ kernel, hooks }) {
    const { clock, log, state } = kernel;
    const uniqueId = (): string => randomUUID().replaceAll('-', '');
    const warn = (message: string): void => log.warn(message);
    const now = (): string => String(clock.now());

    const files = new StateAgendaFiles(state);
    const versions = new SqliteAgendaVersionStore(state);
    const seen = new FileAgendaSeenStore(files, uniqueId, warn);
    const repository = new FileAgendaLedgerRepository(files, uniqueId, versions, {
      now: () => clock.nowMs(),
      warn,
    });
    const agenda = new AgendaService(
      repository,
      { now },
      // Which ferrets exist is Ferrets' (no edge from Asks yet): a well-formed id has a board.
      { has: async ferret => isAgendaSessionId(ferret) },
      { raised: async () => undefined },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      versions,
      seen,
    );

    // Typing into a ferret is Conversation's (`ask.delivery:ferret`); unprovided, answers stay held.
    const delivery = askDelivery(key => hooks.provider(AskDeliveries, key));
    const replies = new AgendaReplyBatcher(
      new FileAgendaOutboxRepository(files, uniqueId),
      delivery.messenger,
      new KeyedAgendaReplyTimers(clock),
      new KeyedSerialQueue(),
      { now },
      undefined,
      undefined,
      delivery.ports,
    );

    const sources = (key: SourceKey) => hooks.provider(AskSources, key);
    const boards = { ferrets: async () => await state.list(AgendaLedgerFiles) };

    return {
      routes: {
        ...agendaRoutes(agenda, replies, undefined, undefined, cardAskAnswers(agenda, () => sources(CARD_SOURCE), now)),
        ...agendaClearRoutes(undefined),
      },
      provides: { asks: asksPort(agenda, boards, sources) },
    };
  },
});

