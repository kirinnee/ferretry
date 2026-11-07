import type { AsksApi } from '@ferretry/core-asks/contract';
import type { FerretId, FerretsApi } from '@ferretry/core-ferrets/contract';
import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import { hasOpenQuestion } from './fleet.ts';
import type { WardenRemedyPort, WardenResumeOutcome } from './lib/index.ts';
import { authorizeWardenResume, WardenResumeRefused } from './resume-guard.ts';

/** What the remedies act through: Ferrets and Conversation, never around them; Asks to know a pending question. */
export interface WardenRemedyHost {
  readonly ferrets: FerretsApi;
  readonly conversation: ConversationApi;
  readonly asks: AsksApi;
  /** Told after every remedy, whether it was done or failed (the `WardenActed` event). */
  readonly acted: (ferret: string, action: string, outcome: 'done' | 'failed') => void;
}

/** The reason the Warden's restart gives Ferrets for the stop half of it (today's restart recorded the Warden). */
export const RESTART_STOP_REASON = 'restarted by the Warden: the process looked alive but was stuck';

/** The remedies, and the one guarded resume the remedies and the auto-revive share. */
export interface WardenRemedies {
  readonly remedies: WardenRemedyPort;
  /** An automatic resume (today's `resume` with actor `warden`): refused where today's `authorizeResume` refuses. */
  readonly resume: (ferret: string, message?: string) => Promise<WardenResumeOutcome>;
}

const refuse = (what: string): never => {
  throw new Error(`${what} is not available on this machine yet.`);
};

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

  // GAP(conversation): nudges must carry actor warden (D2 #19); needs Conversation's additive warden caller. Today the
  // daemon was the sender (`origin: 'daemon', by: { kind: 'ferretry', feature: 'Warden' }`), so a Warden notice was
  // never kept, retried or counted as the owner's own message. Conversation's `ConversationCaller` names only the
  // owner and a ferret on 5.0, so until it gains `{ kind: 'warden' }` the Warden's words go as the owner's.
  const say = async (ferret: string, message: string): Promise<void> => {
    const sent = await conversation.send(ferret as FerretId, { kind: 'owner' }, { message, label: 'action' });
    if (!sent.ok) throw new Error(`the message was refused: ${JSON.stringify(sent.error)}`);
  };

  // Today's `authorizeResume` under the Warden's automatic policy, checked before anything is stopped or started.
  const authorize = async (ferret: string): Promise<void> => {
    const target = await ferrets.get(ferret as FerretId);
    if (target === undefined) throw new WardenResumeRefused(`no ferret ${ferret} to resume`);
    authorizeWardenResume(target, await ferrets.list(), await hasOpenQuestion(asks, target.id));
  };

  const resumeOrThrow = async (ferret: string, message: string | undefined, what: string): Promise<void> => {
    const resumed = await ferrets.resume(ferret as FerretId, message);
    if (!resumed.ok) throw new Error(`${what} refused: ${resumed.error.reason}`);
    if (message !== undefined) await say(ferret, message);
  };

  const remedies: WardenRemedyPort = {
    nudge: async (ferret, message) => await act(ferret, 'nudge', async () => await say(ferret, message)),
    resume: async (ferret, message) =>
      await act(ferret, 'resume', async () => {
        await authorize(ferret);
        await resumeOrThrow(ferret, message, 'resume');
      }),
    // A restart replaces a process that only looks alive: stop it for real, then resume the conversation. Today this
    // was ONE resume that replaced the live pane under the automatic policy (`replaceLiveTerminal`); Ferrets has no
    // such resume yet (GAP(ferrets): an additive automatic resume that replaces a live pane), so today's refusals are
    // checked first, before the stop.
    restart: async (ferret, message) =>
      await act(ferret, 'restart', async () => {
        await authorize(ferret);
        await ferrets.stop(ferret as FerretId, 'now', RESTART_STOP_REASON);
        await resumeOrThrow(ferret, message, 'restart');
      }),
    stop: async (ferret, reason) =>
      await act(ferret, 'stop', async () => await ferrets.stop(ferret as FerretId, 'polite', reason)),
    // GAP(ferrets): moving a ferret to another login needs Ferrets' additive `move`; until then a failover refuses.
    failover: async () => refuse('Moving a ferret to another account'),
    // GAP(terminals/browsers): today closed the browsers left under the ferret's own pane, read from its process tree.
    // Neither Terminals' port (`of`, `holders`) nor Browsers' (`state`, `pagesOf`) reads a pane's processes or closes
    // one, so nothing is closed and the sweep reports zero.
    closeLeftoverBrowsers: async () => 0,
  };

  return {
    remedies,
    // Total, as the auto-revive wants it: a refusal is `{ ok: false }`, never a throw.
    resume: async (ferret, message) => {
      try {
        await authorize(ferret);
        await resumeOrThrow(ferret, message, 'revive');
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
