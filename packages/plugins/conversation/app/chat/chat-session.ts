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

import {
  type FerretContext,
  type FerretSummary,
  type FerretView,
  type OpenRecordedHarness,
  recordedHarnessOf,
} from '@ferretry/core-ferrets/contract';
import type { ChatPrompt } from './chat-prompt.ts';

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
  /** The login it runs on: the name Usage's account feed is keyed by (never its runtime's name). */
  readonly login?: string | undefined;
  /** The harness family it runs (Ferrets' `harness`), or a third harness's own key: the composer reads only the two families. */
  readonly harness?: OpenRecordedHarness | undefined;
}

export type ChatSessionState = Partial<
  Pick<
    ViewState,
    | 'turn'
    | 'turnState'
    | 'turnStateAt'
    | 'turnPrompt'
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
  readonly movedTo?: FerretSummary['movedTo'];
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

/**
 * What the observer recorded about a LIVE ferret's turn (the prompt read, `chat-prompt.ts`), in the chat's names. The
 * summary's `stateAt` is never used for this: the registry stamps it later from its own clock and folds `needs-input` into
 * `idle`, so it is not the instant the turn changed. The observer's own state wins over the summary's coarser one (which
 * stays as the fallback for every other reader); its date, the words and the permission request or dialog ride with it.
 * A ferret that is not live (starting, stopped) is stopped on nothing, and a read that is absent claims nothing.
 */
const turnOf = (
  summary: FerretSummary,
  prompt: ChatPrompt | undefined,
): Pick<ChatSessionState, 'turnState' | 'turnStateAt' | 'turnPrompt' | 'permissionRequest' | 'harnessDialog'> => {
  if (prompt === undefined || (summary.state !== 'working' && summary.state !== 'idle')) return {};
  return {
    ...(prompt.turnState === undefined ? {} : { turnState: prompt.turnState }),
    ...(prompt.turnStateAt === undefined ? {} : { turnStateAt: prompt.turnStateAt }),
    ...(prompt.turnPrompt === undefined ? {} : { turnPrompt: prompt.turnPrompt }),
    ...(prompt.permissionRequest === undefined ? {} : { permissionRequest: prompt.permissionRequest }),
    ...(prompt.harnessDialog === undefined ? {} : { harnessDialog: prompt.harnessDialog }),
  };
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

/** Ferrets' summary of one ferret, with what the observer recorded about its turn (when that was read), as the chat draws it. */
export const chatSessionOf = (summary: FerretSummary, prompt?: ChatPrompt): ChatSession => ({
  ...(summary.movedTo === undefined ? {} : { movedTo: summary.movedTo }),
  config: {
    id: summary.id,
    teammate: summary.name,
    ...(summary.title === undefined ? {} : { name: summary.title }),
    ...(summary.login === undefined ? {} : { login: summary.login }),
    harness: recordedHarnessOf(summary.harness),
  },
  state: {
    ...usageOf(summary.quota),
    ...stateOf(summary),
    ...turnOf(summary, prompt),
    ...(summary.waiting === undefined ? {} : { waiting: summary.waiting }),
  },
});
