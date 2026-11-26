import { type AskAnswer } from '@ferretry/core-asks/contract';
import { statusOf, type SessionView } from '@ferretry/core-mailbox/contract';
import { ApiError } from '@ferretry/kernel/contract';
import { err, milliseconds, ok } from '@ferretry/std';
import {
  type Question,
  QuestionAnswered,
  QuestionAsked,
  QuestionSchema,
  QUESTION_ANSWERED_STATE,
  QUESTION_STATE,
} from '../../contract/index.ts';
import {
  buildQuestionAnswering,
  clearAskedQuestion,
  panePending,
  QuestionAsks,
  questionEntry,
  writeAskedQuestion,
  writeProjectedQuestion,
} from '../questions/adapters/index.ts';
import { agendaAnswers } from '../questions/lib/agenda-answer.ts';
import { ANSWER_FAILURES, SessionAnswerError, sessionAnswerRoutes } from '../questions/lib/mounts/session-answer.ts';
import { QUESTION_WATCH_MS, QuestionWatch } from '../questions/lib/watch.ts';
import { routeTable } from '../seams/api.ts';
import { parseSessionId, tryParseSessionId } from '../seams/ferret-id.ts';
import { KeyedSerialExecutor } from '../seams/keyed-serial-executor.ts';
import { built, type ConversationFeature } from './types.ts';

/**
 * The question a ferret is waiting on: `question.json`, the Agenda's card for it, answering its form, and THE QUESTION
 * WATCH. The watch is the one 2 s cadence: it reads Claude Code's hook file over the roster (and once on a ferret's
 * state change) and makes it `question.json`, which is what the app, the agenda and the send guard read; it also retires
 * the question when the transcript says it was answered. Reads only. Its tick also keeps the Agenda's cards (the
 * reconcile, then the prompts feature's sweep) in their one order.
 */
export default {
  id: 'questions',
  register: f => {
    const { kernel, ferrets, asks, clock } = f;
    /** The one lane of each ferret's `question.json`: its writer, the exact-id clear and the withdrawal (r4 #2). */
    const questionSerial = new KeyedSerialExecutor();
    /** The Agenda's card for each stored question (Asks' source `question`), for either harness: one path. */
    const questionAsks = new QuestionAsks(asks, (ferret, error, outcome) =>
      kernel.log.warn(
        outcome === 'permanent'
          ? `conversation could not raise the agenda item of the question of ${ferret} and will not try again: ${String(error)}`
          : `conversation could not raise the agenda item of the question of ${ferret} yet, and will try again when the agenda has room: ${String(error)}`,
      ),
    );
    /** Asks failing is never the question's failure: it is logged, owed and tried again on the watch's next look. */
    const askFailure =
      (what: string) =>
      (error: unknown): void =>
        kernel.log.warn(`conversation could not ${what} the agenda item of a question: ${String(error)}`);
    /** The card of the exact question now stored, raised once (idempotent), after the question is durable. */
    const raiseQuestionAsk = async (ferret: string, toolUseId: string): Promise<void> => {
      const read = await kernel.state.read(QUESTION_STATE, ferret);
      if (read.ok && read.value?.toolUseId === toolUseId)
        await questionAsks.raise(ferret, read.value).catch(askFailure('raise'));
    };
    /** The questions an Agenda answer is typing into the form now: their card is the Agenda's to resolve, not the drive's. */
    const applying = new Set<string>();
    const applyingKey = (ferret: string, toolUseId: string): string => JSON.stringify([ferret, toolUseId]);
    /** Closes the watch skipped while an Agenda answer was typing into that question: owed again if the answer fails. */
    const deferred = new Set<string>();
    /**
     * An Agenda answer to the question failed: the card stays open (Asks leaves it), so a close skipped meanwhile is made now
     * if that exact question is no longer the stored one. Detached on purpose: the apply runs inside Asks' own board
     * mutation, and the close waits its turn behind it. A question still stored, or a file that cannot be read, is not over.
     */
    const closeIfReplaced = (ferret: string, toolUseId: string): void => {
      if (!deferred.delete(applyingKey(ferret, toolUseId))) return;
      void (async () => {
        const read = await kernel.state.read(QUESTION_STATE, ferret);
        if (!read.ok || read.value?.toolUseId === toolUseId) return;
        await questionAsks.close(ferret, toolUseId, 'answered').catch(askFailure('close'));
      })().catch(askFailure('close'));
    };
    const closeQuestionAsk = async (
      ferret: string,
      toolUseId: string,
      reason: 'answered' | 'withdrawn',
    ): Promise<void> => {
      if (reason === 'answered' && applying.has(applyingKey(ferret, toolUseId))) {
        // Not the drive's to close: the Agenda resolves it if the answer lands. The close is owed if it does not.
        deferred.add(applyingKey(ferret, toolUseId));
        return;
      }
      await questionAsks.close(ferret, toolUseId, reason).catch(askFailure('close'));
    };
    /**
     * The Agenda says what the stored questions say, after a restart (the one-time event is gone): every stored question
     * has its card, a card without a stored question is closed. An unreadable file or roster refuses the whole pass: it is
     * missing evidence, never "no question".
     */
    const reconcileQuestionAsks = async (): Promise<void> => {
      const stored = new Map<string, Question>();
      for (const { id } of await ferrets.list()) {
        const read = await kernel.state.read(QUESTION_STATE, id);
        if (!read.ok) throw new Error(`the question of ${id} is unreadable`);
        if (read.value !== undefined) stored.set(id, read.value);
      }
      await questionAsks.reconcile(stored);
    };
    let questionAsksReconciled = false;
    /** Set by this feature's `stop`: the question watch looks no more once it has. */
    let stopped = false;

    /** `question.json`: the question the ferret is waiting on, as the harness asked it (written where the transcript is read). */
    const askedQuestion = async (ferret: string): Promise<Question | undefined> => {
      const read = await kernel.state.read(QUESTION_STATE, ferret);
      if (!read.ok || read.value === undefined) return undefined;
      // The transcript it was proved against stays in the file: the route and the port answer the question only.
      const { transcript: _proof, conversation: _conversation, ...question } = read.value;
      return question;
    };
    f.late.askedQuestion = askedQuestion;

    /**
     * Answering a question's form is the structured-question drive (`questions/adapters/question-answering.ts`): the
     * service binds `question.json`, the driver types into the live form through Ferrets' form seam only after binding it
     * on a captured frame, the coordinator drives one logical answer at most once, and the stamp plus the exact-id clear of
     * `question.json` is the commit point. Its failures are the route's refusals (`SessionAnswerError`).
     */
    const answering = buildQuestionAnswering({
      state: kernel.state,
      ferrets,
      questionLane: questionSerial,
      // Its own queue: the answered clear re-enters the question lane, which an answer must not hold across the drive.
      serial: new KeyedSerialExecutor(),
      clock,
      status: async id => {
        const summary = await ferrets.get(id);
        return summary === undefined ? undefined : statusOf(summary);
      },
      publishAnswered: async (ferret, toolUseId) => {
        await closeQuestionAsk(ferret, toolUseId, 'answered');
        await kernel.events.publish(QuestionAnswered, { ferret, toolUseId });
      },
      released: async (ferret, toolUseId) => await closeQuestionAsk(ferret, toolUseId, 'withdrawn'),
      log: { info: (event, fields) => kernel.log.info(event, fields), warn: message => kernel.log.warn(message) },
      sleep: async ms => await kernel.clock.sleep(milliseconds(ms)),
    });
    const answerQuestion = async (...args: Parameters<typeof answering.answer>): Promise<SessionView> =>
      await answering.answer(...args);

    const questionWatch = new QuestionWatch({
      roster: async () => (await ferrets.list()).map(({ id, harness, state }) => ({ id, harness, state })),
      harness: async ferret => {
        const id = tryParseSessionId(ferret);
        return id === undefined ? undefined : await ferrets.harness?.(id);
      },
      current: async ferret => {
        const read = await kernel.state.read(QUESTION_STATE, ferret);
        return read.ok ? read.value : undefined;
      },
      lastAnswered: async ferret => {
        const read = await kernel.state.read(QUESTION_ANSWERED_STATE, ferret);
        // Unreadable is missing evidence, never "nothing was answered": the look decides nothing and tries again.
        if (!read.ok) throw new Error('the answered stamp is unreadable');
        return read.value?.toolUseId;
      },
      write: async (ferret, payload, askedAt, transcript) =>
        await writeAskedQuestion(kernel.state, questionSerial, ferret, payload, askedAt, transcript),
      clear: async (ferret, toolUseId) => await clearAskedQuestion(kernel.state, questionSerial, ferret, toolUseId),
      // A Codex ferret's question is in its transcript (the reading feature reads it).
      transcriptEvents: async (ferret, limit) =>
        await built(f.late.reading, 'reading half').questionEvents(ferret, limit),
      conversation: async ferret => await built(f.late.reading, 'reading half').questionConversation(ferret),
      paneForm: panePending(ferrets),
      writeProjected: async (ferret, pending, askedAt, conversation) =>
        await writeProjectedQuestion(
          kernel.state,
          questionSerial,
          ferret,
          pending,
          askedAt,
          () => kernel.clock.now(),
          conversation,
        ),
      asked: async (ferret, toolUseId) => {
        await raiseQuestionAsk(ferret, toolUseId);
        await kernel.events.publish(QuestionAsked, { ferret: parseSessionId(ferret), toolUseId });
      },
      answered: async (ferret, toolUseId) => {
        await closeQuestionAsk(ferret, toolUseId, 'answered');
        await kernel.events.publish(QuestionAnswered, { ferret: parseSessionId(ferret), toolUseId });
      },
    });
    let cancelQuestionWatch: (() => void) | undefined;
    const watchQuestions = (): void => {
      if (stopped) return;
      cancelQuestionWatch = kernel.clock.after(milliseconds(QUESTION_WATCH_MS), () => {
        void (async () => {
          // The Agenda first (once after boot, then only what failed before is retried), so a card never waits on a look.
          if (!questionAsksReconciled) {
            await reconcileQuestionAsks().then(() => {
              questionAsksReconciled = true;
            }, askFailure('reconcile'));
          } else await questionAsks.settle();
          // The cards of the ferrets parked on a prompt (the prompts feature), then the questions themselves.
          await f.late.prompts?.sweep();
          await questionWatch.sweep();
        })()
          .catch(() => undefined)
          .finally(watchQuestions);
      });
    };
    watchQuestions();

    f.late.questions = {
      look: ferret => void questionWatch.look(ferret).catch(() => undefined),
      // The ferret stopped or went away: the question it was asking is withdrawn, so `question.json` goes.
      withdraw: async ferret => {
        questionWatch.forget(ferret);
        const stored = await kernel.state.read(QUESTION_STATE, ferret);
        await clearAskedQuestion(kernel.state, questionSerial, ferret);
        // Only the question that was stored when the withdrawal began: a newer one is its own.
        if (stored.ok && stored.value !== undefined)
          await closeQuestionAsk(ferret, stored.value.toolUseId, 'withdrawn');
      },
    };

    return {
      routes: routeTable(sessionAnswerRoutes({ question: askedQuestion, answer: answerQuestion })),
      port: {
        question: async ferret => await askedQuestion(ferret),
        answer: async (ferret, request) => {
          try {
            // No request id comes with the port's call: one is minted, and a repeat finds the question no longer pending.
            await answering.answer(ferret, { ...request, requestId: String(kernel.ids.mint('answer')) });
            return ok(undefined);
          } catch (error) {
            if (error instanceof SessionAnswerError)
              return err({ code: ANSWER_FAILURES[error.failure].code, message: error.message });
            return err({
              code: error instanceof ApiError ? (error.code ?? 'answer_refused') : 'session_answer_failed',
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
      },
      hooks: () => ({
        // The owner's answer on the Agenda is typed into the ferret's own question form BEFORE the card counts as answered.
        'ask.sources:question': {
          schema: QuestionSchema,
          title: 'Question',
          form: true,
          // The card's entry names the ferret and the tool-use id together: the question it was raised for, if it still waits.
          apply: async (answer: AskAnswer) => {
            let found: { readonly ferret: string; readonly question: Question } | undefined;
            for (const { id } of await ferrets.list()) {
              const read = await kernel.state.read(QUESTION_STATE, id);
              if (read.ok && read.value !== undefined && questionEntry(id, read.value.toolUseId) === answer.entry) {
                found = { ferret: id, question: read.value };
                break;
              }
            }
            if (found === undefined)
              return { refused: 'That question is not waiting any more, so nothing was sent to the ferret.' };
            const mapped = agendaAnswers(found.question, { values: answer.values, text: answer.text });
            if (!mapped.ok) return { refused: `${mapped.reason}. The question is still open.` };
            const { toolUseId } = found.question;
            const key = applyingKey(found.ferret, toolUseId);
            applying.add(key);
            try {
              // One id per Agenda answer: a repeat of the same answer finds the drive already done, never a second one.
              await answering.answer(found.ferret, {
                toolUseId,
                labels: [],
                answers: mapped.answers,
                requestId: `agenda:${answer.id}`,
              });
              // The Agenda records this answer and resolves the card: nothing is owed.
              deferred.delete(key);
              return 'applied';
            } catch (error) {
              const why = error instanceof Error ? error.message : String(error);
              closeIfReplaced(found.ferret, toolUseId);
              return { refused: `The answer did not reach the ferret, so the question stays open: ${why}` };
            } finally {
              applying.delete(key);
            }
          },
        },
        // Ferrets' turn watch asks once per look whether a question is open: the stored `question.json` answers.
        'turn.question-open:question': { isOpen: async ferret => (await askedQuestion(ferret)) !== undefined },
      }),
      subscribers: {
        // The board changed: a question card it refused for now (it was full) is asked for again.
        'asks.changed': async () => {
          await questionAsks.retryWaiting();
        },
      },
      stop: () => {
        cancelQuestionWatch?.();
        stopped = true;
      },
    };
  },
} satisfies ConversationFeature;
