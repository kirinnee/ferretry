import { ASK_REFERENCE_SIGIL } from '@ferretry/core-asks/contract';
import type { ConfigFileDef, FerretId } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { milliseconds } from '@ferretry/std';
import {
  AGENDA_CONFIG,
  AgendaBuzzed,
  type AgendaApi,
  AgendaModeChanged,
  type AgendaConfig,
  type BuzzKind,
  DAEMON_AGENDA_ID,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { StateBuzzLedger } from './adapters/state-buzz-ledger.ts';
import { StateModeStore, StateNudgeStore, StateRestNudgeStore, StateSeenStore } from './adapters/state-stores.ts';
import { AgendaModeService, adoptAgendaDefault } from './lib/agenda-mode.ts';
import { agendaArchiveKeeps } from './lib/archive-keeps.ts';
import { agendaLaunchPart } from './lib/launch-parts.ts';
import {
  askBuzzKey,
  askBuzzKind,
  askBuzzWords,
  type BuzzableAsk,
  stopBuzzKey,
  stopBuzzWords,
  waitingOnOwner,
} from './lib/buzz-policy.ts';
import { BuzzService } from './lib/buzz-service.ts';
import { AgendaAgentClearer } from './lib/clear-agents.ts';
import { MachineAgendaView } from './lib/machine-agenda.ts';
import { AgendaReferenceMenu } from './lib/reference-menu.ts';
import { AGENDA_REST_NUDGE_ID_PREFIX, AgendaRestNudger, REST_NUDGE_SWEEP_MS } from './lib/rest-nudge.ts';
import { AGENDA_NUDGE_ID_PREFIX, AgendaTurnNudge, NudgeSendFailure } from './lib/turn-nudge.ts';
import { AgendaRollup } from './lib/rollup.ts';
import { markSeen } from './lib/seen.ts';
import { buzzBody, buzzTitle } from './lib/words.ts';
import { agendaRoutes } from './routes.ts';

const REFERENCE_MENU_HOOK = `reference.catalog:${ASK_REFERENCE_SIGIL}` as const;

/** The command the nudge's words name (the product's one binary). */
const BINARY_NAME = 'fy';

/** The agenda's own defaults when `config/agenda.yaml` is absent: every switch on. */
const DEFAULT_CONFIG: AgendaConfig = { agendaMode: true, agendaNudge: true, deadlineWarnHours: 3 };

/**
 * Agenda's daemon half (§2.3): your list of asks and notices as a view over Asks, the per-ferret agenda mode, the daemon
 * agenda, and the buzzes to your phone.
 *
 * SEAMS NOT BOUND HERE (declared GAPS; each degrades in words instead of guessing):
 * - **Deadline buzzes and wake scheduling.** Asks owns the engine's wake sweep and resurfacing timer;
 *   they act on Asks' own ledger and belong beside it. `AgendaApi.buzz` is the generic once-per-moment buzz whoever knows
 *   a deadline or a wake calls.
 * - **A notice's `--buzz`.** Asks' summary carries no `blocking` flag yet; the buzz reads it when the summary has it.
 * - **Agent ferrets.** Ferrets records a role, not "interactive or not": a helper ferret counts as an agent ferret.
 * - **Taking a buzz down on other devices.** Access's port has no clear; opening an ask records it as seen and answers
 *   the tags, and clears only when Access offers `clear`.
 * - (A ferret parked on a permission prompt or a dialog is Conversation's `prompt` Asks source, not Agenda's. The
 *   turn-end check is `lib/turn-nudge.ts`, taken on `turn.ended`; the rest nudge is `lib/rest-nudge.ts`, a job.)
 */
export default implementDaemon(manifest, {
  build({ needs, uses, kernel }) {
    const { asks, ferrets } = needs;
    const { clock, log, state } = kernel;

    const config = (): AgendaConfig =>
      kernel.config.file(AGENDA_CONFIG as ConfigFileDef<AgendaConfig>) ?? DEFAULT_CONFIG;
    const ledger = new StateBuzzLedger(state);
    const seen = new StateSeenStore(state);
    const modeStore = new StateModeStore(state);
    const nudgeStore = new StateNudgeStore(state);
    const warn = (message: string): void => log.warn(message);

    const buzzes = new BuzzService({
      ledger,
      access: () => uses.access.current(),
      now: () => clock.now(),
      buzzed: (key, kind, at) => kernel.events.publish(AgendaBuzzed, { key, kind, at }),
      warn,
    });

    const rollup = new AgendaRollup(asks);
    const clearer = new AgendaAgentClearer(
      {
        // v4's rule (`config.mode === 'auto'`, the set the app's Agents filter lists): a ferret that is not interactive.
        agentFerrets: async () =>
          (await ferrets.list()).filter(ferret => ferret.mode === 'auto').map(ferret => ferret.id),
      },
      asks,
    );
    const machine = new MachineAgendaView(asks, DAEMON_AGENDA_ID as FerretId);
    const modes = new AgendaModeService({
      facts: async ferret => {
        const summary = await ferrets.get(ferret as FerretId);
        if (summary === undefined) return undefined;
        return {
          enabled: (await modeStore.recorded(ferret)) ?? config().agendaMode,
          running: summary.state !== 'stopped',
        };
      },
      write: async (ferret, enabled, at) => await modeStore.write(ferret, enabled, at),
      now: () => String(clock.now()),
    });

    const setMode = async (ferret: FerretId, enabled: boolean) => {
      const outcome = await modes.set(ferret, enabled);
      kernel.events.publish(AgendaModeChanged, { ferret, enabled });
      return { enabled, ...outcome };
    };

    /** One ask's own buzz, when it is a moment that buzzes (a notice asked for the phone; a card's ask). */
    const buzzAsk = async (ask: BuzzableAsk): Promise<void> => {
      const kind = askBuzzKind(ask);
      if (kind === undefined || ask.ferret === undefined) return;
      await buzzes.buzz(askBuzzKey(ask.ferret, ask.id), kind, askBuzzWords(ask), { ferret: ask.ferret, ask: ask.id });
    };

    /** A ferret went idle with asks waiting: ONE buzz for the stop, named by the instant it began. */
    const buzzStop = async (ferret: FerretId): Promise<void> => {
      const waiting = waitingOnOwner(await asks.open({ ferret, state: 'open' }));
      const [first, ...rest] = waiting;
      if (first === undefined) return;
      const name = (await ferrets.get(ferret))?.name ?? ferret;
      const stoppedAt = String(clock.now());
      await buzzes.buzz(
        stopBuzzKey(ferret, stoppedAt),
        'stopped',
        stopBuzzWords(ferret, name, [first, ...rest], stoppedAt),
        {
          ferret,
        },
      );
    };

    /**
     * THE TURN-END CHECK: a ferret that ends a turn asking the owner for something it did not raise gets one nudge, typed
     * through Conversation as Agenda's own words (`{ kind: 'agenda' }`, fixed text; only the ferret's own asks are quoted back
     * to it). A ferret that is stopped or gone is never nudged: Conversation refuses an Agenda send to one, so a nudge
     * can never revive it. One nudge per ferret until a message that is not Agenda's reaches it (state/agenda/nudges.json).
     */
    const turnNudge = new AgendaTurnNudge(
      {
        mark: async ferret => await nudgeStore.mark(ferret),
        reserve: async (ferret, taken, replacing) => await nudgeStore.reserve(ferret, taken, replacing),
        release: async (ferret, sendId) => await nudgeStore.release(ferret, sendId),
        pause: async ms =>
          await new Promise<void>(resolve => {
            kernel.clock.after(milliseconds(ms), resolve);
          }),
        now: () => String(clock.now()),
        sends: async ferret => {
          const read = await uses.conversation.current()?.sends(ferret as FerretId);
          return (read?.sends ?? [])
            .filter(send => send.withdrawn !== true)
            .map(send => ({
              sendId: send.sendId,
              acceptedAt: send.acceptedAt,
              message: send.message,
              agenda:
                send.by?.feature === 'Agenda' ||
                send.sendId.startsWith(AGENDA_NUDGE_ID_PREFIX) ||
                send.sendId.startsWith(AGENDA_REST_NUDGE_ID_PREFIX),
            }));
        },
        enabled: () => config().agendaNudge,
        subject: async ferret => {
          const summary = await ferrets.get(ferret as FerretId);
          if (summary === undefined || summary.state === 'stopped') return undefined;
          return {
            parent: summary.parent !== undefined,
            mode: summary.mode === 'auto' ? 'auto' : 'interactive',
            agenda: (await modeStore.recorded(ferret)) ?? config().agendaMode,
          };
        },
        tail: async (ferret, limit) => {
          const read = await uses.conversation.current()?.transcriptEvents(ferret as FerretId, { limit });
          return read?.ok === true ? read.value.events : [];
        },
        send: async (ferret, sendId, message) => {
          const sent = await uses.conversation
            .current()
            ?.send(ferret as FerretId, { kind: 'agenda' }, { message, sendId, label: 'action' });
          if (sent?.ok === false) throw new NudgeSendFailure(sent.error.code, sent.error.message);
        },
      },
      BINARY_NAME,
    );

    /**
     * THE REST NUDGE: a ferret silent on an item the owner replied to is nudged on v4's schedule (30 min, then doubling to
     * a day), capped at `AGENDA_REST_NUDGE_LIMIT` per rest. Asks owns the items (read from its boards); the counters are
     * Agenda's own (state/agenda/rest-nudges.json) and written before each send. The send is the turn-end check's: the same
     * Conversation port as `{ kind: 'agenda' }`, never reviving a stopped ferret, never the owner's words.
     */
    const restStore = new StateRestNudgeStore(state);
    const restNudger = new AgendaRestNudger(
      {
        records: async ferret => await restStore.records(ferret),
        reserve: async (ferret, taken, live) => await restStore.reserve(ferret, taken, live),
        release: async (ferret, sendId, prior) => await restStore.release(ferret, sendId, prior),
        prune: async (roster, resting) => await restStore.prune(roster, resting),
        // Every ferret Ferrets still lists (stopped ones too: they can resume); a removed or archived one is not.
        roster: async () => (await ferrets.list()).map(ferret => ferret.id as string),
        enabled: () => config().agendaNudge,
        boards: async () => await asks.snapshots(),
        // Nothing is counted while Conversation is off: a count spent on a nudge that cannot be typed would be lost.
        running: async ferret => {
          if (uses.conversation.current() === undefined) return false;
          const summary = await ferrets.get(ferret as FerretId);
          return summary !== undefined && summary.state !== 'stopped';
        },
        now: () => String(clock.now()),
        send: async (ferret, sendId, message) => {
          const sent = await uses.conversation
            .current()
            ?.send(ferret as FerretId, { kind: 'agenda' }, { message, sendId, label: 'action' });
          if (sent?.ok === false) throw new NudgeSendFailure(sent.error.code, sent.error.message);
        },
        failed: (ferret, error) => warn(`agenda could not nudge ${ferret} about a resting item: ${String(error)}`),
      },
      BINARY_NAME,
    );
    kernel.jobs.add({
      id: 'rest-nudge',
      schedule: { every: milliseconds(REST_NUDGE_SWEEP_MS) },
      run: async () => {
        await restNudger.sweep();
      },
    });

    const api: AgendaApi = {
      open: async query => await rollup.page(query),
      daemonAgenda: async () => await machine.list(),
      mode: async ferret => {
        const reading = await modes.get(ferret);
        return { enabled: reading.enabled, restartRequired: reading.restartRequired, note: reading.note };
      },
      setMode: async (ferret, enabled) => {
        const { enabled: now, restartRequired, note } = await setMode(ferret, enabled);
        return { enabled: now, restartRequired, note };
      },
      clearAgents: async ({ dryRun }) => (dryRun ? await clearer.preview() : await clearer.clear()),
      buzz: async (key, kind: BuzzKind, message) =>
        await buzzes.buzz(
          key,
          kind,
          {
            tag: `agenda-${key}`.slice(0, 200),
            title: buzzTitle(message.title),
            body: buzzBody(message.body),
            url: '/agenda',
          },
          {},
        ),
    };

    return {
      routes: agendaRoutes({
        rollup,
        clearer,
        modes,
        machine,
        asks,
        ferrets,
        ledger,
        seen,
        access: () => uses.access.current(),
        now: () => clock.now(),
        modeChanged: (ferret, enabled) =>
          kernel.events.publish(AgendaModeChanged, { ferret: ferret as FerretId, enabled }),
      }),
      provides: { agenda: api },
      subscribers: {
        // A raise, a close or a change: an ask that is a buzzing moment makes its one buzz.
        'asks.changed': async ({ ferret, askId, state: askState }) => {
          if (askState !== 'open') return;
          const ask = (await asks.get({ ferret, id: askId }).catch(() => undefined)) as BuzzableAsk | undefined;
          if (ask !== undefined) await buzzAsk({ ...ask, ferret: ask.ferret ?? ferret });
        },
        // The owner answered it, so they have seen it.
        'asks.answered': async ({ ferret, askId }) => {
          await markSeen(seen, ferret, askId, clock.now()).catch(error => warn(`seen mark failed: ${String(error)}`));
        },
      },
      hooks: {
        // The composer's `!` menu (reference.catalog): the ferret's open asks. Asked only while Conversation is on.
        [REFERENCE_MENU_HOOK]: new AgendaReferenceMenu(asks),
        // The session archive (Ferrets): whether a ferret's own board holds an open item. Off until the owner names an
        // age; a board that cannot be read keeps that ferret live.
        'session.archive-keeps': () => [{ id: 'agenda', item: agendaArchiveKeeps(asks) }],
        // What a launch says about agenda mode: FY_AGENDA follows the ferret's switch (or the machine default).
        'launch.parts': () => [
          {
            id: 'agenda',
            item: agendaLaunchPart(async ferret => (await modeStore.recorded(ferret)) ?? config().agendaMode),
          },
        ],
        // A ferret's round ended: only one that finished its work is checked (an interrupted or failed round said nothing).
        'turn.ended': ({ ferret, outcome }) => {
          if (outcome !== 'completed') return;
          void turnNudge
            .check(ferret)
            .catch(error => warn(`agenda could not check the end of a turn of ${ferret}: ${String(error)}`));
        },
        'ferret.changed': ({ ferret, state: now, previous, change }) => {
          const work =
            change === 'started'
              ? adoptAgendaDefault(
                  {
                    machineDefault: () => config().agendaMode,
                    recorded: async id => await modeStore.recorded(id),
                    enable: async id => await modeStore.write(id, true, String(clock.now())),
                  },
                  ferret,
                  true,
                ).then(() => undefined)
              : now === 'idle' && previous !== 'idle'
                ? buzzStop(ferret)
                : Promise.resolve();
          void work.catch(error => warn(`agenda could not follow a ferret change: ${String(error)}`));
        },
      },
    };
  },
});
