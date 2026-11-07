import { implementDaemon } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { wardenFlags } from './lib/protocol.ts';
import { toWireBlessing, toWireFlag, toWireLeave, toWireRun } from './lib/wire-map.ts';
import { wardenRoutes } from './routes.ts';
import { createWardenSubsystem } from './subsystem.ts';

/**
 * Warden (§2.3): the sweep that watches ferrets, flags trouble and applies the remedies the owner allowed.
 *
 * DECLARED GAPS. The sweep sees only what Ferrets, Conversation and Asks tell it, so:
 * - Pane-level liveness (frozen frames, token counters, tool processes) and leftover browsers need a Terminals/Browsers
 *   read the manifest does not take. The liveness monitor is not built and the classifiers that need those facts stay
 *   quiet; what the sweep can flag from the contracts is a question nobody answered (an open ask of the ferret's own).
 * - Investigator wardens, failover, auto-move and revive need a folder Ferrets can start a warden in and the daemon can
 *   read reports back from, a "move to another login" in the Ferrets contract, and death causes. They are off, so
 *   nothing is spent and nothing is moved. The sweep, the nudge, resume, restart and stop remedies, blessings, reports
 *   and the agenda are on.
 * - The Jev guard is the real one over a Vault Warden does not need, so it answers `not_set` and no request leaves the
 *   machine (NO UNATTENDED SPEND BY SURPRISE holds trivially; the caps, pacing and per-day rules still run in the sweep).
 * - A nudge is sent as the owner (Conversation names no daemon sender); a standing notice cannot be refreshed in place
 *   (Asks has no update); a helper or pack member is "unattended" work, a lead is a person at a terminal.
 * - The board, send-ledger and stuck-input ports are absent, so their flags do not occur; the machine lists and the
 *   declared-wait watcher of today are not part of this port.
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
