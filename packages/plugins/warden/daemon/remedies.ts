import type { AsksApi } from '@ferretry/core-asks/contract';
import type { FerretId, FerretsApi, LaunchOrigin } from '@ferretry/core-ferrets/contract';
import type { BrowsersApi, LeftoverBrowsersClosed } from '@ferretry/plugin-browsers/contract';
import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import { hasOpenQuestion } from './fleet.ts';
import {
  leftAloneUnproved,
  WARDEN_SWEEP_ORIGIN,
  type WardenRemedyPort,
  type WardenResumeOutcome,
} from './lib/index.ts';
import { authorizeWardenResume, WardenResumeRefused } from './resume-guard.ts';

/** What the remedies act through: Ferrets and Conversation, never around them; Asks to know a pending question. */
export interface WardenRemedyHost {
  readonly ferrets: FerretsApi;
  readonly conversation: ConversationApi;
  readonly asks: AsksApi;
  /**
   * Told after every remedy, whether it was done or failed (the `WardenActed` event), with the browsers a leftover
   * close left alone (each pid and why), so the owner is told what was not closed.
   */
  readonly acted: (
    ferret: string,
    action: string,
    outcome: 'done' | 'held' | 'failed',
    leftAlone?: LeftoverBrowsersClosed['leftAlone'],
  ) => void;
  /** Browsers, while it is on (an optional use): it closes the browsers left under a ferret's pane. */
  readonly browsers?: () => BrowsersApi | undefined;
  /**
   * Told when a resume that DID start the ferret could not type its notice (Conversation refused it, or the ferret's terminal
   * could not be reached). The resume stands; the notice's failure is journalled apart from it.
   */
  readonly noticeUndelivered?: (ferret: string, reason: string) => void;
}

/** Ferrets ANSWERED that it would not start the ferret, before it committed a relaunch: nothing was started. */
class ResumeRefused extends Error {}

/** The reason the Warden's restart gives Ferrets for the stop half of it (today's restart recorded the Warden). */
export const RESTART_STOP_REASON = 'restarted by the Warden: the process looked alive but was stuck';

/** The remedies, and the one guarded resume the remedies and the auto-revive share. */
export interface WardenRemedies {
  readonly remedies: WardenRemedyPort;
  /** An automatic resume (today's `resume` with actor `warden`): refused where today's `authorizeResume` refuses. */
  readonly resume: (ferret: string, message: string | undefined, origin: LaunchOrigin) => Promise<WardenResumeOutcome>;
}

export function createWardenRemedies(host: WardenRemedyHost): WardenRemedies {
  const { ferrets, conversation, asks, acted } = host;

  const act = async (ferret: string, action: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
      acted(ferret, action, 'done');
    } catch (error) {
      acted(ferret, action, 'failed');
      throw error;
    }
  };

  // D2 #19: every word the Warden types is Conversation's `warden` caller (today's `origin: 'daemon'`, authored by Ferretry's
  // Warden), so a notice is never recorded as the owner's own message, never retried on a person's behalf, and the
  // sweep's input_stuck / inbox_stuck looks can tell it apart. It is never sent as the owner or as a ferret.
  const say = async (ferret: string, message: string): Promise<void> => {
    const sent = await conversation.send(ferret as FerretId, { kind: 'warden' }, { message, label: 'action' });
    if (!sent.ok) throw new Error(`the message was refused: ${JSON.stringify(sent.error)}`);
  };

  // Today's `authorizeResume` under the Warden's automatic policy, checked before anything is stopped or started.
  const authorize = async (ferret: string): Promise<void> => {
    const target = await ferrets.get(ferret as FerretId);
    if (target === undefined) throw new WardenResumeRefused(`no ferret ${ferret} to resume`);
    authorizeWardenResume(target, await ferrets.list(), await hasOpenQuestion(asks, target.id));
  };

  /**
   * Resumes, and answers why its notice was not typed (nothing when it was, or there was none). A RELAUNCH (the ferret
   * was stopped) carries the message as its own turn document, whose pointer Ferrets types into the new pane, with the
   * Warden as its author (today's one resume: the message is the turn, no second send). Only a resume that relaunches
   * nothing — the ferret is running — still says the message, since nothing else would hand it over. WHICH of the two
   * happened is Ferrets' own answer (`ResumeOptions.decided`, told under that ferret's queue), never an earlier read of
   * its state: a start or stop between that read and the resume would otherwise drop the notice or type it twice.
   */
  const resumeOrThrow = async (
    ferret: string,
    message: string | undefined,
    what: string,
    origin: LaunchOrigin,
  ): Promise<string | undefined> => {
    // Every resume the Warden makes is automated recovery, not a person asking: Ferrets records it as such, and the
    // turn it writes is from the Warden.
    let relaunched: boolean | undefined;
    const resumed = await ferrets.resume(ferret as FerretId, message, {
      // Who asked for this resume is the caller's to say: Ferrets fences an agent's launch out of the state home.
      origin,
      automatic: true,
      actor: 'warden',
      decided: disposition => {
        relaunched = disposition === 'relaunching';
      },
    });
    if (!resumed.ok) {
      // Ferrets said `relaunching` only once the record was `starting`: a no AFTER that (the launch, or the pointer to
      // its turn, did not land) is not "nothing started", so it is a plain error the auto-revive counts as a revive
      // (cooldown, `crash_repeat`, the breaker), as today counted a relaunch whose pointer failed. Only a no before
      // the relaunch was committed is Ferrets' refusal.
      if (relaunched === true) throw new Error(`${what} relaunched the ferret, then failed: ${resumed.error.reason}`);
      throw new ResumeRefused(`${what} refused: ${resumed.error.reason}`);
    }
    // Ferrets that cannot say what it did (a port without `decided`) is read as a relaunch: the notice is then not typed
    // a second time, and a running ferret's notice goes undelivered rather than twice.
    if (message === undefined || relaunched !== false) return undefined;
    // The ferret is running: the resume is DONE whatever happens to its notice. A notice that cannot be typed is
    // journalled apart, never turned into a refusal: a refused revive is not recorded, so the limits that count
    // revives would never see this one.
    try {
      await say(ferret, message);
      return undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      host.noticeUndelivered?.(ferret, reason);
      return reason;
    }
  };

  const remedies: WardenRemedyPort = {
    nudge: async (ferret, message) => await act(ferret, 'nudge', async () => await say(ferret, message)),
    resume: async (ferret, message, origin) =>
      await act(ferret, 'resume', async () => {
        await authorize(ferret);
        await resumeOrThrow(ferret, message, 'resume', origin);
      }),
    // A restart replaces a process that only looks alive: stop it for real, then resume the conversation. Today this
    // was ONE resume that replaced the live pane under the automatic policy (`replaceLiveTerminal`); Ferrets has no
    // such resume (GAP(ferrets): `ResumeOptions` has no `replaceLiveTerminal`; a live pane is replaced only by a move, whose
    // in-flight gate a stuck process must not meet), so today's refusals are checked first, before the stop.
    restart: async (ferret, message, origin) =>
      await act(ferret, 'restart', async () => {
        await authorize(ferret);
        await ferrets.stop(ferret as FerretId, 'now', RESTART_STOP_REASON);
        // Stopped just now, so the resume relaunches it and its turn carries the message (Ferrets says so).
        await resumeOrThrow(ferret, message, 'restart', origin);
      }),
    stop: async (ferret, reason) =>
      await act(ferret, 'stop', async () => await ferrets.stop(ferret as FerretId, 'polite', reason)),
    // Today's failover: the same ferret relaunched on another login with its conversation, through Ferrets' move (the
    // moves module's flow and its refusals). Today's failover moved with `movedBy: 'warden'` only; `actor: 'warden'`
    // was only on the auto-move path, which is not built. A move Ferrets refuses throws with its reason, which the
    // sweep records as a failed act.
    failover: async (ferret, agent) =>
      await act(ferret, 'failover', async () => {
        if (ferrets.move === undefined) throw new Error('Moving a ferret to another account is not available here.');
        const moved = await ferrets.move(ferret as FerretId, agent, { movedBy: 'warden', origin: WARDEN_SWEEP_ORIGIN });
        if (!moved.ok) throw new Error(`the move was refused: ${moved.error.reason}`);
      }),
    // Today's remedy, through Browsers: the pane's tree is read again at this moment (through Terminals), nothing is
    // closed while a tool command runs, and only a top-level browser under THAT pane that Terminals re-proves just
    // before its signal is closed — never the ferret; every other one is left alone and reported.
    // The sweep calls this only when the owner lets the Warden close leftovers alone (`mayActAlone.closeLeftovers`).
    // Browsers off: nothing closes, and the sweep is never told of a leftover to close (`withLiveness`).
    // Recorded `done` when one closed, `failed` when every browser it proved refused the signal, and `held` when it
    // closed and refused nothing but left a browser alone because it could not prove it (`not-proved`, `invalid-pid`):
    // the owner is told. `gone` and `tool-running` alone are not ownership questions and raise nothing.
    closeLeftoverBrowsers: async ferret => {
      const browsers = host.browsers?.();
      if (browsers === undefined) return { closed: 0, leftAlone: [] };
      try {
        const result = await browsers.closeLeftoverBrowsers(ferret as FerretId);
        const refused = result.leftAlone.some(browser => browser.why === 'signal-refused');
        if (result.closed > 0) acted(ferret, 'close_leftover', 'done', result.leftAlone);
        else if (refused) acted(ferret, 'close_leftover', 'failed', result.leftAlone);
        else if (leftAloneUnproved(result.leftAlone)) acted(ferret, 'close_leftover', 'held', result.leftAlone);
        return result;
      } catch (error) {
        acted(ferret, 'close_leftover', 'failed');
        throw error;
      }
    },
  };

  return {
    remedies,
    // Total, as the auto-revive wants it: a refusal is `{ ok: false }`, never a throw.
    resume: async (ferret, message, origin) => {
      // Fail closed: once Ferrets was asked to start the ferret, anything but its own refusal counts as a revive, so
      // the cooldown, `crash_repeat` and the breaker apply to it. Only the guard (before the call) or a refusal
      // Ferrets answered before it committed a relaunch leaves nothing started.
      let asked = false;
      try {
        await authorize(ferret);
        asked = true;
        const unsent = await resumeOrThrow(ferret, message, 'revive', origin);
        return unsent === undefined ? { ok: true } : { ok: true, caveat: `It could not be told why: ${unsent}.` };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (asked && !(error instanceof ResumeRefused))
          return { ok: true, caveat: `Whether it started is not known (${reason}), so this counts as a revive.` };
        return { ok: false, reason };
      }
    },
  };
}
