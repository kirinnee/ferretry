import type { FerretId, FerretsApi } from '@ferretry/core-ferrets/contract';
import type { AsksWardenAgenda } from './asks.ts';
import {
  type DialogNotice,
  type DialogNoticePort,
  isTeachable,
  isTerminalStatus,
  permissionAsDialog,
  teachSentence,
  type WardenFleetSession,
  WatchedDialogSchema,
  WARDEN_LABEL,
  type WatchedDialog,
} from './lib/index.ts';

/**
 * Every ferret parked on a harness dialog right now, read through Ferrets' own `prompt` (the dialog its turn watch
 * recorded, masked). A warden's own ferrets and a finished one are not looked at; a ferret Ferrets cannot answer for,
 * or whose dialog does not read as one, shows none. Throws only when the fleet itself cannot be read.
 */
export async function ferretDialogs(
  ferrets: Pick<FerretsApi, 'prompt'>,
  fleet: () => Promise<readonly WardenFleetSession[]>,
): Promise<readonly WatchedDialog[]> {
  const watched = (await fleet()).filter(
    session => session.config.label !== WARDEN_LABEL && !isTerminalStatus(session.state.status),
  );
  const found = await Promise.all(
    watched.map(async (session): Promise<WatchedDialog | undefined> => {
      const prompt = await ferrets.prompt?.(session.config.id as FerretId).catch(() => undefined);
      const screen = WatchedDialogSchema.safeParse(prompt?.dialog);
      const dialog = screen.success ? screen.data : permissionAsDialog(prompt?.permissionRequest);
      if (dialog === undefined) return undefined;
      return {
        sessionId: session.config.id,
        name: session.config.teammate ?? session.config.label ?? session.config.id,
        ...(session.config.harness === undefined ? {} : { harness: session.config.harness }),
        dialog,
      };
    }),
  );
  return found.filter((each): each is WatchedDialog => each !== undefined);
}

/** The dialog notice port over the Warden's agenda: a plain notice on the ferret's own board, closed with its episode. */
export function agendaDialogNotices(
  agenda: Pick<AsksWardenAgenda, 'noticeOutcome' | 'resolveSource'>,
): DialogNoticePort {
  return {
    raise: async (notice: DialogNotice) => {
      const { write } = await agenda.noticeOutcome(notice.sessionId, {
        sourceRef: notice.ref,
        subject: notice.subject,
        why: notice.why,
        howToResolve: isTeachable(notice.context)
          ? `${notice.howToResolve} ${teachSentence(notice.sessionId)}`
          : notice.howToResolve,
        context: notice.context,
      });
      return write === 'refreshed' ? 'unchanged' : write;
    },
    clear: async (sessionId, ref) => {
      await agenda.resolveSource(sessionId, 'agent-raised', ref, 'The ferret is no longer at that dialog.');
    },
  };
}
