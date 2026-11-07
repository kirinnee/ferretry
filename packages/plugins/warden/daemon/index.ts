import { implementDaemon } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { wardenFlags } from './lib/protocol.ts';
import { toWireBlessing, toWireFlag, toWireLeave, toWireRun } from './lib/wire-map.ts';
import { wardenRoutes } from './routes.ts';
import { createWardenSubsystem } from './subsystem.ts';

/**
 * Warden (§2.3): the sweep that watches ferrets, flags trouble and applies the remedies the owner allowed.
 *
 * DECLARED GAPS, each with its reason in `ports-pending.json` `pendingReasons.warden`.
 * The sweep sees only what Ferrets, Conversation and Asks tell it, so:
 * - Pane-level liveness (frozen frames, token counters, tool processes) is today's liveness monitor, fed by Terminals'
 *   `liveness` look at each ferret's own pane and Conversation's transcript tail every 30 s while Terminals (an
 *   optional use) is on; off, `dead_monitor`, `sus_*` and `agent_frozen` do not run. A browser left under a pane is
 *   closed through Browsers' `closeLeftoverBrowsers` (an optional use) behind today's `mayActAlone.closeLeftovers`;
 *   off, that check does not run. A quiet ferret is nudged once by the reflex, never one that declared a wait, each
 *   timed by its own nudge and frozen times (`FerretSummary.waiting`, `nudgeAfterSeconds`, `killAfterSeconds`).
 * - A sub-ferret overdue on a report is nudged and its parent told, skipping one that declared a wait or said
 *   `signal done` (`FerretSummary.waiting` / `finishedAt`).
 * - Auto-revive resumes a ferret Ferrets reports as having died (`FerretSummary.cause`) through `FerretsApi.resume`
 *   (automatic). A failover act is a move through `FerretsApi.move`, but nothing reaches it yet: the sweep routes every
 *   failover through the auto-move service, which is not built (it needs fleet facts, the owner hold and the ferret's
 *   background jobs, none of which Ferrets offers). Investigator wardens refuse: Ferrets takes a work folder, but the
 *   Warden has no folder of its own to give it, so nothing is spent.
 * - The Jev guard is the real one, but its key waits on the kernel's `secrets.resolve`: it answers `not_set` and no
 *   request leaves the machine (NO UNATTENDED SPEND BY SURPRISE holds trivially; the caps, pacing and per-day rules
 *   still run in the sweep).
 * - A nudge is sent as the owner until Conversation has a `warden` caller; a standing notice cannot be refreshed in
 *   place (Asks has no update); unattended is the ferret's own start mode, as today.
 * - Board is an optional use: on, a card Board calls orphaned is flagged `orphaned_card` (read through Board's
 *   contract, every page of them, with each lane named from Board's lane sets); off, that flag does not run. A
 *   resumed auto ferret is told its focus card from Board's `focusOf` (`daemon/board.ts`).
 * - The stuck-input/inbox acts are absent, so their flags do not occur; the machine lists and the declared-wait
 *   watcher of today are not part of this port (an orphaned card is told by a notice on one ferret's board instead).
 */
export default implementDaemon(manifest, {
  build(ctx) {
    const { kernel } = ctx;
    const { ferrets, conversation, asks } = ctx.needs;
    const subsystem = createWardenSubsystem({
      kernel,
      ferrets,
      conversation,
      asks,
      usage: () => ctx.uses.usage.current(),
      board: () => ctx.uses.board.current(),
      terminals: () => ctx.uses.terminals.current(),
      browsers: () => ctx.uses.browsers.current(),
    });

    // Arming reads the interval from `warden.yaml` and starts the timer: after `build`, in a job (§7.6 step 4).
    let disarm: (() => void) | undefined;
    kernel.lifecycle.onStop(() => disarm?.());
    kernel.jobs.add({
      id: 'warden-arm',
      schedule: { onceAfterStart: true },
      lane: 'main',
      run: async () => {
        disarm = subsystem.arm();
      },
    });

    return {
      routes: wardenRoutes(subsystem),
      provides: {
        warden: {
          flags: async () => wardenFlags(await subsystem.status()).map(toWireFlag),
          config: async () => (await subsystem.config()).config,
          configure: async patch => (await subsystem.updateConfig(patch)).config,
          sweep: async options => toWireRun(await subsystem.run(options.spawn)),
          investigate: async request => {
            const view = await subsystem.investigate(request.ferret, request.note);
            return { state: view.state, message: view.message };
          },
          leave: async request => toWireLeave(await subsystem.leave(request.ferret, request.duration)).blessing,
          blessed: async ferret => {
            const blessing = (await subsystem.status()).blessings.find(entry => entry.sessionId === ferret);
            return blessing === undefined ? undefined : toWireBlessing(blessing);
          },
        },
      },
      hooks: {
        'ferret.changed': payload => {
          if (payload.state === 'stopped') subsystem.nudgeSweep('paneDied');
        },
        'turn.ended': () => subsystem.nudgeSweep('turnEnd'),
      },
    };
  },
});
