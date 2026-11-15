/**
 * WHAT THE ABOVE-COMPOSER SLOT IS HANDED (`ConversationAboveComposerProps`, `contract/slots.ts`): the rows on screen, whose turn
 * it is, what parks the turn on the person, and the send ledger's ids. Built here so the privacy rule is one function:
 * every part is projected field by field, never spread, so a field this file does not name (a permission prompt's command,
 * a send's words, an attachment) cannot leave Conversation by being added to its source later.
 */
import type {
  ConversationAboveComposerProps,
  ConversationNeedsInput,
  ConversationPromptOption,
  ConversationSendAcceptance,
} from '../../contract/index.ts';
import type { PendingQuestion } from '../questions/question-form.tsx';
import type { ChatSession } from './chat-session.ts';
import { rowSlotEntry } from './row-slots.tsx';
import type { LedgerSendRecord } from './send-ledger.ts';
import type { TranscriptEntry } from './transcript-entries.ts';

const labelsOf = (options: readonly { readonly label: string }[]): readonly ConversationPromptOption[] =>
  options.map(option => ({ label: option.label }));

/**
 * What the ferret is stopped on, as read-only data. A ferret that has ended is stopped on nothing (`ended`), and a
 * harness dialog is never beside a permission prompt (they share one pane).
 */
export function needsInputOf(
  session: ChatSession,
  question: PendingQuestion | null,
  ended: boolean,
): ConversationNeedsInput {
  if (ended) return {};
  const { permissionRequest: permission, harnessDialog: dialog, turnPrompt } = session.state;
  return {
    ...(question === null
      ? {}
      : {
          question: {
            questions: question.questions.map(asked => ({
              question: asked.question,
              ...(asked.multiSelect === undefined ? {} : { multiSelect: asked.multiSelect }),
              ...(asked.options === undefined ? {} : { options: labelsOf(asked.options) }),
            })),
          },
        }),
    ...(permission === undefined
      ? {}
      : {
          permissionRequest: {
            tool: permission.tool,
            question: permission.question,
            options: labelsOf(permission.options),
          },
        }),
    ...(dialog === undefined || permission !== undefined
      ? {}
      : { harnessDialog: { title: dialog.title, options: labelsOf(dialog.options) } }),
    ...(turnPrompt === undefined ? {} : { turnPrompt }),
  };
}

/**
 * The daemon's send ledger as ids and acceptance instants, oldest accepted first (ISO instants on the daemon's clock
 * order as text). Never a send's words.
 */
export const sendAcceptances = (sends: readonly LedgerSendRecord[]): readonly ConversationSendAcceptance[] =>
  sends
    .map(send => ({ sendId: send.sendId, acceptedAt: send.acceptedAt }))
    .sort((a, b) => (a.acceptedAt < b.acceptedAt ? -1 : a.acceptedAt > b.acceptedAt ? 1 : 0));

export interface AboveComposerInput {
  readonly session: ChatSession;
  readonly entries: readonly TranscriptEntry[];
  readonly sends: readonly LedgerSendRecord[];
  /** The question the ferret waits on, already null for an ended ferret. */
  readonly question: PendingQuestion | null;
  /** The ferret has ended: it is stopped on nothing. */
  readonly ended: boolean;
  /** The chat's last read of the ferret came back from the daemon and no refresh has failed since. */
  readonly live: boolean;
}

export function aboveComposerProps(input: AboveComposerInput): ConversationAboveComposerProps {
  const { session } = input;
  const rows = input.entries.flatMap(entry => {
    const offered = rowSlotEntry(entry);
    return offered === null ? [] : [offered];
  });
  const { turnState, turnStateAt } = session.state;
  return {
    rows,
    turn: {
      state: turnState ?? null,
      ...(turnStateAt === undefined ? {} : { at: turnStateAt }),
      live: input.live,
    },
    needsInput: needsInputOf(session, input.question, input.ended),
    sends: sendAcceptances(input.sends),
  };
}
