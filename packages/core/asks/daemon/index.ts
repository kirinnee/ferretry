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
 * - **Answers into a ferret's terminal**: typing into a ferret is Conversation's, provided under `ask.delivery:ferret`;
 *   unprovided, answers are held in the ferret's outbox, never lost, and shown as held.
 * - **Which ferrets exist, who started whom, a ferret's focus card, a card's gate**: Ferrets and Board provide them under
 *   `agenda.context`. With Ferrets off no ferret has a board and no raise is accepted; with Board off an item keeps the
 *   card it was raised with and a card's gate reads as asking.
 * - **Push counts** after a raise: Notify's; meanwhile a raise says nothing about devices.
 */
import { randomUUID } from 'node:crypto';
import { implementDaemon, perNeeder } from '@ferretry/kernel/manifest';
import { milliseconds } from '@ferretry/std';
import { AgendaContext, AskDeliveries, AskSources, type SourceKey } from '../contract/index.ts';
import { agendaContext } from './adapters/agenda-context.ts';
import manifest from '../manifest.ts';
import { askDelivery } from './adapters/ask-delivery.ts';
import { asksPort } from './adapters/asks-port.ts';
import { AskEvents } from './adapters/ask-events.ts';
import { sourceAnswers } from './adapters/source-answers.ts';
import { CARD_SOURCE, cardAskAnswers } from './adapters/card-ask-answers.ts';
import { FileAgendaLedgerRepository } from './adapters/agenda/file-agenda-ledger-repository.ts';
import { FileAgendaOutboxRepository } from './adapters/agenda/file-agenda-outbox-repository.ts';
import { FileAgendaSeenStore, SqliteAgendaVersionStore } from './adapters/agenda/file-agenda-versions.ts';
import { KeyedAgendaReplyTimers } from './adapters/agenda/keyed-agenda-reply-timers.ts';
import { StateAgendaFiles } from './adapters/agenda/state-agenda-files.ts';
import { tellFerret } from './adapters/agenda/tell-ferret.ts';
import { AgendaReplyBatcher, AgendaService } from './lib/agenda/index.ts';
import { KeyedSerialQueue } from './lib/agenda/serial-queue.ts';
import { AgendaChangeFanout, AgendaReplyDelivery, AgendaBoardUndelivered } from './lib/agenda/observers.ts';
import { agendaRoutes } from './lib/routes/agenda.ts';
import { AgendaRepliesFiles, AgendaPendingChangesFiles, AgendaPendingVersionsFiles } from '../manifest.ts';
import { AsksConfigFile } from '../contract/index.ts';
import { AgendaWaker, WAKE_SWEEP_MS } from './lib/agenda/waker.ts';
import { AgendaResurfacer, RESURFACE_SWEEP_MS } from './lib/agenda/resurfacer.ts';
import { AgendaLedgerFiles } from './lib/state.ts';

/** How often the outboxes that hold a change event are drained. */
const CHANGES_SWEEP_MS = 5_000;

/** The one plugin whose Asks view can tell a ferret something. */
const TELLING_PLUGIN = 'vault';

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
    // Lineage and card context are Ferrets' and Board's (`agenda.context`), read at each call; an answer that cannot be had
    // is the safe side of its question (see `agendaContext`). The machine agenda and the owner's chat are not on this
    // base: a notice with no owner home stays on the sub-ferret, and `fy agenda log` finds nothing.
    const context = agendaContext(key => hooks.provider(AgendaContext, key), warn);
    const agenda = new AgendaService(
      repository,
      { now },
      context.sessions,
      { raised: async () => undefined },
      new AgendaChangeFanout([
        new AgendaReplyDelivery({ add: (sessionId, key, message) => replies.add(sessionId, key, message) }, 'fy'),
        new AskEvents(kernel.events),
      ]),
      context.focus,
      context.subFerrets,
      context.cards,
      context.homes,
      context.gates,
      undefined,
      undefined,
      versions,
      seen,
    );

    // Typing into a ferret is Conversation's (`ask.delivery:ferret`); unprovided, answers stay held.
    const delivery = askDelivery(key => hooks.provider(AskDeliveries, key));
    const replyTimers = new KeyedAgendaReplyTimers(clock);
    kernel.lifecycle.onStop(() => replyTimers.close());
    const replies = new AgendaReplyBatcher(
      new FileAgendaOutboxRepository(files, uniqueId),
      delivery.messenger,
      replyTimers,
      new KeyedSerialQueue(),
      { now },
      undefined,
      undefined,
      { ...delivery.ports, undelivered: new AgendaBoardUndelivered(agenda) },
    );

    const sources = (key: SourceKey) => hooks.provider(AskSources, key);
    const boards = {
      ferrets: async () => {
        const listed = await state.list(AgendaLedgerFiles);
        // The cache holds every ledger that exists, so a read of all of them is not a miss per ledger.
        repository.holdLedgers(listed.length);
        return listed;
      },
    };
    const recover = async (signal: AbortSignal) => {
      const ferrets = [
        ...new Set(
          (
            await Promise.all(
              [AgendaLedgerFiles, AgendaRepliesFiles, AgendaPendingChangesFiles, AgendaPendingVersionsFiles].map(file =>
                state.list(file),
              ),
            )
          ).flat(),
        ),
      ];
      for (const ferret of ferrets) {
        signal.throwIfAborted();
        await agenda.list(ferret).catch(error => warn(String(error)));
      }
      await replies.resume(ferrets);
    };
    kernel.jobs.add({ id: 'recover', schedule: { onceAfterStart: true }, run: recover });
    kernel.jobs.add({
      id: 'changes',
      // Only the outboxes that hold an event (the outbox knows them): no ledger is listed or read on an idle tick.
      schedule: { every: milliseconds(CHANGES_SWEEP_MS) },
      run: async signal => {
        await agenda.flushPending(error => warn(String(error)), signal);
      },
    });
    const waker = new AgendaWaker(repository, agenda, boards.ferrets, now);
    kernel.jobs.add({
      id: 'wake',
      schedule: { every: milliseconds(WAKE_SWEEP_MS) },
      run: async () => {
        await waker.sweep();
      },
    });
    kernel.jobs.add({
      id: 'resurface',
      schedule: { every: milliseconds(RESURFACE_SWEEP_MS) },
      run: async () => {
        const afterMinutes = kernel.config.file(AsksConfigFile)?.resurfaceAfterMinutes;
        if (afterMinutes === undefined) return;
        await new AgendaResurfacer(repository, agenda, boards.ferrets, now, afterMinutes).sweep();
      },
    });

    // One port, one raise queue: the view without `tell` is the same port with that one call left off.
    const withTell = asksPort(agenda, boards, sources, tellFerret(replies));
    const { tell: _tell, ...withoutTell } = withTell;

    return {
      routes: {
        ...agendaRoutes(
          agenda,
          replies,
          undefined,
          undefined,
          cardAskAnswers(agenda, () => sources(CARD_SOURCE), now),
          sourceAnswers(agenda, sources, now),
          context.reach,
        ),
      },
      provides: {
        // Typing into a ferret is not for every plugin that holds Asks: `tell` is on the view of the one plugin that
        // owes a ferret something (Vault, when its request ends); every other needer's view has no `tell`.
        asks: perNeeder(needer => (needer.id === TELLING_PLUGIN ? withTell : withoutTell)),
      },
    };
  },
});
