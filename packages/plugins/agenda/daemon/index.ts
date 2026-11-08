import type { ConfigFileDef, FerretId } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
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
import { StateModeStore, StateSeenStore } from './adapters/state-stores.ts';
import { AgendaModeService, adoptAgendaDefault } from './lib/agenda-mode.ts';
import { agendaArchiveKeeps } from './lib/archive-keeps.ts';
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
import { AgendaRollup } from './lib/rollup.ts';
import { markSeen } from './lib/seen.ts';
import { buzzBody, buzzTitle } from './lib/words.ts';
import { agendaRoutes } from './routes.ts';

const REFERENCE_MENU_HOOK = 'reference.catalog:!' as const;

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
 * - **The turn-end and rest nudges, the harness-prompt asks.** They read a ferret's transcript and type into it
 *   (Conversation's); they stay unported until Conversation provides those seams.
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
        // Ferrets records a role, not "interactive or not": a helper is the ferret nobody chats with.
        agentFerrets: async () =>
          (await ferrets.list()).filter(ferret => ferret.role === 'helper').map(ferret => ferret.id),
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
      await buzzes.buzz(
        stopBuzzKey(ferret, String(clock.now())),
        'stopped',
        stopBuzzWords(ferret, name, [first, ...rest]),
        {
          ferret,
        },
      );
    };

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
