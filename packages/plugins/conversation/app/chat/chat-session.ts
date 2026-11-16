/**
 * THE FERRET, AS THE CHAT DRAWS IT.
 *
 * Ferrets' `GET /v1/ferrets/:ferretId` answers its summary (`FerretSummarySchema`): who the ferret is and which of
 * its four states it is in. The chat was written against today's whole session view (`{ config, state, directory }`,
 * `FerretViewSchema`), which no 5.0 route serves — parsing the summary with it refused EVERY ferret, and the page
 * drew nothing. So the read is parsed with the schema of what the route serves, and projected here into the few
 * fields the chat reads, in the `{ config, state }` shape its components already take.
 *
 * A field the summary does not carry (the turn's start, the pane's activity line, a permission prompt or harness
 * dialog, the context gauge) is ABSENT, never invented: every reader already treats it as "not known". The question
 * a ferret waits on still comes from Conversation's own `GET /v1/ferrets/:ferretId/question`.
 *
 * Today's view is a structural subtype of {@link ChatSession}, so a caller holding one may still pass it.
 */

import type { FerretContext, FerretSummary, FerretView } from '@ferretry/core-ferrets/contract';

type ViewState = FerretView['state'];

/**
 * The status the chat shows while it has NOT read the ferret (the read failed, or answered a shape this build cannot
 * read): the page still draws from the id alone, and nothing on it may claim the ferret is working or finished.
 */
export const UNREAD_STATUS = 'unread';

interface ChatSessionConfig {
  readonly id: string;
  /** What it works on (Ferrets' `title`). */
  readonly name?: string | undefined;
  /** Its callsign (Ferrets' `name`). */
  readonly teammate?: string | undefined;
  /** The runtime it runs on. */
  readonly agent?: string | undefined;
}

export type ChatSessionState = Partial<
  Pick<
    ViewState,
    | 'turn'
    | 'turnState'
    | 'turnStateAt'
    | 'activity'
    | 'promptReady'
    | 'pendingQuestion'
    | 'permissionRequest'
    | 'harnessDialog'
    | 'waiting'
    | 'usageAuthOk'
    | 'usage5hPercent'
    | 'usageWeeklyPercent'
    | 'usageAtLimit'
    | 'usage5hResetAt'
    | 'usageWeeklyResetAt'
  >
> & {
  readonly status: ViewState['status'] | typeof UNREAD_STATUS;
};

export interface ChatSession {
  readonly config: ChatSessionConfig;
  readonly state: ChatSessionState;
  readonly context?: FerretContext | undefined;
}

/** Whether the chat has read this ferret at all (see {@link UNREAD_STATUS}). */
export const isUnread = (session: ChatSession): boolean => session.state.status === UNREAD_STATUS;

/** The ferret as the chat draws it while its read failed: its id, and nothing claimed about it. */
export const unreadChatSession = (ferretId: string): ChatSession => ({
  config: { id: ferretId },
  state: { status: UNREAD_STATUS },
});

/**
 * Ferrets' four states, in the chat's words. `working` and `idle` are a LIVE ferret whose turn the daemon's turn watch
 * decided, so they carry `turnState`; a stopped ferret that said `signal done` (`finishedAt`) finished its work.
 */
const stateOf = (summary: FerretSummary): Pick<ChatSessionState, 'status' | 'turnState'> => {
  switch (summary.state) {
    case 'starting':
      return { status: 'starting' };
    case 'working':
      return { status: 'running', turnState: 'working' };
    case 'idle':
      return { status: 'running', turnState: 'your-turn' };
    case 'stopped':
      return { status: summary.finishedAt === undefined ? 'stopped' : 'completed' };
  }
};

/** The usage the ferret's runtime monitor stamped (Ferrets' `quota`), in the names the composer reads. */
const usageOf = (quota: FerretSummary['quota']): ChatSessionState => {
  if (quota === undefined) return { status: UNREAD_STATUS };
  return {
    status: UNREAD_STATUS,
    ...(quota.authOk === undefined ? {} : { usageAuthOk: quota.authOk }),
    ...(quota.fiveHourPercent === undefined ? {} : { usage5hPercent: quota.fiveHourPercent }),
    ...(quota.weeklyPercent === undefined ? {} : { usageWeeklyPercent: quota.weeklyPercent }),
    ...(quota.atLimit === undefined ? {} : { usageAtLimit: quota.atLimit }),
    ...(quota.fiveHourResetAt === undefined ? {} : { usage5hResetAt: quota.fiveHourResetAt }),
    ...(quota.weeklyResetAt === undefined ? {} : { usageWeeklyResetAt: quota.weeklyResetAt }),
  };
};

/** Ferrets' summary of one ferret, as the chat draws it. */
export const chatSessionOf = (summary: FerretSummary): ChatSession => ({
  config: {
    id: summary.id,
    teammate: summary.name,
    ...(summary.title === undefined ? {} : { name: summary.title }),
    ...(summary.runtime === undefined ? {} : { agent: summary.runtime }),
  },
  state: {
    ...usageOf(summary.quota),
    ...stateOf(summary),
    ...(summary.waiting === undefined ? {} : { waiting: summary.waiting }),
  },
});
