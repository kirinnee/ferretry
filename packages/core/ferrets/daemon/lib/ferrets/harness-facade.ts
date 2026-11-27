import { posix } from 'node:path';
import { ApiError } from '@ferretry/kernel/contract';
import { err, ok, type Result } from '@ferretry/std';
import {
  runnerDeliveryFailure,
  type AskedQuestionFile,
  type DeliveryOutcome,
  type FerretHarness,
  type FerretId,
  type FormKey,
  type PickerKey,
  type HarnessDeliveryFailure,
  type HarnessFile,
  type Harness,
  type HarnessForm,
  type HarnessInterrupted,
  type HarnessQueueOptions,
  type HarnessRefusal,
  type QueueOutcome,
  type Runner,
  type RunnerComposerCleared,
  type RunnerComposerSubmitted,
  type RunnerDelivery,
  type RunnerDeliveryFailure,
  type RunnerFormCapture,
  type RunnerHandle,
  type RunnerHeldAt,
  type RunnerLook,
  type RunnerPaneObservation,
  type TranscriptReader,
} from '../../../contract/index.ts';
import { isFileBackedQueue, queuedMessageInstruction } from '../protocol/turn-handoff.ts';
import type { FerretRegistry } from '../registry/registry.ts';
import type { FerretsPorts } from './service.ts';

/** The optional Auto check is a fact of the installed harness member, never a list of harness names. */
export function harnessFacts(harness: Harness | undefined): Harness['facts'] | undefined {
  if (harness === undefined) return undefined;
  return harness.autoLaunchRefusal === undefined ? harness.facts : { ...harness.facts, checksAutoLaunch: true };
}

/**
 * What the harness facade takes from Ferrets, handed in whole so it holds no state of its own and reaches no global:
 * the registry (a ferret's record and its pane handle NOW), the service's ports (the runner, the harness plugins, the
 * session files and the "delivered" mark) and Ferrets' own rule for who may touch whom. Ferrets builds it; the facade
 * only reads.
 */
export interface HarnessFacadeDeps {
  readonly registry: Pick<FerretRegistry, 'get'>;
  /** Throws a 403 when a ferret caller is neither the target nor its lead or helper (a person is never refused). */
  readonly requireMayTouch: (caller: FerretId | undefined, target: FerretId) => void;
  readonly ports: Pick<FerretsPorts, 'ready' | 'runner' | 'harness' | 'session' | 'delivered'>;
}

/**
 * Whether one look shows the ferret mid-turn (today's `paneMidTurn`, from the pane alone): the harness's own working
 * line is on screen and no prompt is. A permission prompt or a harness dialog is not "busy" (the delivery answers it as
 * a dialog), and a look that saw nothing proves nothing, so neither is answered early. Read from the pane, never the
 * record: a ferret the turn watch still calls `working` but whose pane shows neither work nor a prompt goes on to the
 * delivery's own wait, because typing into an idle prompt as if it were a queue is the worse mistake.
 */
function midTurn(look: RunnerLook | undefined): boolean {
  if (look === undefined) return false;
  return look.working && !look.atPrompt && !look.permission && look.prompt === undefined && look.dialog === undefined;
}

/**
 * A runner's closed failure in the harness seam's words: a refusal (nothing typed) keeps its kind and fields, and a
 * typed-but-unproven write becomes {@link HarnessUnconfirmed}, a different shape, so it is never read as a refusal.
 */
function harnessDeliveryFailure(failure: RunnerDeliveryFailure): HarnessDeliveryFailure {
  switch (failure.kind) {
    case 'not_ready':
      return { refused: 'not_ready', why: failure.why };
    case 'composer_occupied':
      return { refused: 'composer_occupied', draft: failure.draft };
    case 'composer_unreadable':
      return { refused: 'composer_unreadable' };
    case 'held':
      return { refused: failure.code };
    case 'unconfirmed':
      return { unconfirmed: true, stranded: failure.stranded };
  }
}

/**
 * A ferret's harness seam (`FerretsApi.harness`): the pane side of message delivery (deliver, queue, interrupt, the
 * composer and question acts, the transcript), bound to ONE ferret. A caller that is a ferret reaches only itself and
 * its helpers (the same rule as stop and resume): a refusal is a 403, and an unknown ferret answers `undefined`.
 */
export async function openHarness(
  { registry, ports, requireMayTouch }: HarnessFacadeDeps,
  ferret: FerretId,
  caller?: FerretId,
): Promise<FerretHarness | undefined> {
  await ports.ready?.();
  if (registry.get(ferret) === undefined) return undefined;
  requireMayTouch(caller, ferret);
  /**
   * The ferret's pane and runner NOW, or why there is nothing to write to. The handle is only a pane id, which can name
   * ANOTHER ferret's pane (a converted v4 record, a tmux-server restart), so every runner call made through it passes
   * `ferret`: the runner acts only on a pane in this ferret's own session and otherwise refuses as for a gone pane.
   */
  const pane = (): Result<{ readonly handle: RunnerHandle; readonly runner: Runner }, HarnessRefusal> => {
    const handle = registry.get(ferret)?.handle as RunnerHandle | undefined;
    const runner = ports.runner();
    if (handle === undefined) return err({ refused: 'no_pane' });
    if (runner === undefined) return err({ refused: 'plugin_unavailable' });
    return ok({ handle, runner });
  };
  /**
   * One of the runner's own writes (deliver, queue), answered as the closed failure its rejection carries. None is
   * wrapped in an act here: the runner acts on the ferret's pane (op `keys`) for each write it makes, so an outer act
   * would wait on the inner one and neither would ever settle. A rejection that carries no closed failure is a failure
   * nobody could classify, and it rejects as it came.
   */
  const written = async <T>(write: () => Promise<T>): Promise<Result<T, HarnessDeliveryFailure>> => {
    try {
      return ok(await write());
    } catch (error) {
      const failure = runnerDeliveryFailure(error);
      if (failure === undefined) throw error;
      return err(harnessDeliveryFailure(failure));
    }
  };
  const reader = (): TranscriptReader => {
    const record = registry.get(ferret);
    const harness = record === undefined ? undefined : ports.harness(record.harness);
    if (harness === undefined)
      throw new ApiError(503, 'the harness that wrote this conversation is off', 'plugin_unavailable');
    return harness.transcript;
  };
  /**
   * Whether this ferret's harness takes messages through its own protocol (codex-protocol-send), for this text. A
   * native slash command (`/compact`) is the TUI's to parse, so it is always typed.
   */
  const injects = (text: string): boolean => {
    const record = registry.get(ferret);
    const harness = record === undefined ? undefined : ports.harness(record.harness);
    return harness?.inject !== undefined && !text.trimStart().startsWith('/');
  };
  /**
   * The harness's own protocol (codex-protocol-send): types nothing and reads no screen, so an unreadable frame cannot
   * stall the send. Not wrapped in an act: it types nothing (the act deadlock the notes above describe is about keys).
   * A throw is `unavailable`: nothing reached the harness's protocol call's acceptance.
   */
  const inject = async (text: string): Promise<'handed' | 'unavailable' | 'uncertain'> => {
    const record = registry.get(ferret);
    const harness = record === undefined ? undefined : ports.harness(record.harness);
    if (harness?.inject === undefined) return 'unavailable';
    try {
      return await harness.inject(ferret, text);
    } catch {
      return 'unavailable';
    }
  };
  const attachmentsFolder = ports.session?.attachmentsFolder?.bind(ports.session);
  const attach = ports.session?.attach?.bind(ports.session);
  const media = ports.session?.media?.bind(ports.session);
  return {
    deliver: async (delivery: RunnerDelivery): Promise<Result<DeliveryOutcome, HarnessDeliveryFailure>> => {
      const found = pane();
      if (!found.ok) return found;
      // A harness that takes messages through its own protocol is answered BUSY, nothing typed or handed: Conversation
      // then takes its queue path, which marks the row as a queued, busy-typed send before `queue` hands it over. A
      // hand-over looks like nothing on the pane or in the transcript until the agent's current turn ends, and a row
      // that did not say "queued" was read as absent at its deadline and handed again — a second copy (review #F4344).
      if (injects(delivery.text)) return err({ refused: 'not_ready', why: 'busy' });
      // Ruling #45: one look first. A ferret visibly at work is answered busy NOW, nothing typed, rather than after
      // the delivery's readiness wait gives up on a prompt that will not come until the turn ends.
      const look = await found.value.runner.look?.(found.value.handle, ferret).catch(() => undefined);
      if (midTurn(look)) return err({ refused: 'not_ready', why: 'busy' });
      // A pane parked on a tool permission waits for a person, so the readiness wait would only run out its ~27 s while
      // holding the ferret's one send lane (an interrupt and every later send queue behind it): answered at once.
      // Startup dialogs (`prompt`, `dialog`) are NOT answered here: the delivery's own wait answers them.
      if (look?.permission === true) return err({ refused: 'not_ready', why: 'dialog' });
      // The runner guards each write with kernel.act on this pane itself; a hold it meets types nothing.
      const delivered = await written(
        async () => await found.value.runner.deliver(found.value.handle, delivery, ferret),
      );
      if (delivered.ok) ports.delivered?.(ferret);
      return delivered;
    },
    queue: async (
      text: string,
      options?: HarnessQueueOptions,
    ): Promise<Result<QueueOutcome, HarnessDeliveryFailure>> => {
      const found = pane();
      if (!found.ok) return found;
      const { handle, runner } = found.value;
      if (injects(text)) {
        // Handed to the harness's own protocol: the text as given goes, nothing is typed, and where it landed is for
        // the transcript to say (`left`). Cut off after it may have been accepted: unconfirmed, never sent again.
        const handed = await inject(text);
        if (handed === 'uncertain') return err({ unconfirmed: true, stranded: false });
        if (handed === 'handed') {
          ports.delivered?.(ferret);
          return ok('left');
        }
        // Not handed, and nothing sent: typed as it always was. `deliver` answered busy without looking, so the pane
        // is looked at now: an idle one is typed at its prompt (where it lands is again the transcript's to say), a
        // working one goes to its own queue below.
        const look = await runner.look?.(handle, ferret).catch(() => undefined);
        if (!midTurn(look)) {
          const delivered = await written(async () => await runner.deliver(handle, { text }, ferret));
          if (!delivered.ok) return delivered;
          ports.delivered?.(ferret);
          return ok('left');
        }
      }
      const queue = runner.queue?.bind(runner);
      if (queue === undefined) return err({ refused: 'plugin_unavailable' });
      // Ruling #45 (today's `native-file` path): a long message goes by file, written BEFORE any key, and the queue
      // is typed the one-line pointer. With nowhere to write it, it is refused rather than pasted inline.
      let typed = text;
      if (isFileBackedQueue(text)) {
        const write = ports.session?.queued?.bind(ports.session);
        if (write === undefined) return err({ refused: 'plugin_unavailable' });
        // A file that could not be written typed nothing: answered as a refusal, so the message may go again.
        const file = await write(ferret, text, options?.sendId).catch(() => undefined);
        if (file === undefined) return err({ refused: 'plugin_unavailable' });
        typed = queuedMessageInstruction(file);
      }
      // As `deliver`: the runner acts on this pane for each write it makes, so it is NOT wrapped in a second act here.
      const queued = await written(async () => await queue(handle, typed, ferret));
      if (queued.ok) ports.delivered?.(ferret);
      return queued;
    },
    interrupt: async (): Promise<Result<HarnessInterrupted, HarnessRefusal>> => {
      const found = pane();
      if (!found.ok) return found;
      const { handle, runner } = found.value;
      const record = registry.get(ferret);
      // The harness names its own stop key; the runner's raw signal (`C-c`) is never the fallback: it quits Codex.
      const stop = record === undefined ? undefined : ports.harness(record.harness)?.turnStop;
      const stopTurn = runner.stopTurn?.bind(runner);
      if (stop === undefined || stopTurn === undefined) return err({ refused: 'plugin_unavailable' });
      // Today's `shouldPressStopKey`: idle, the key is pressed only at an interactive pane whose harness it cannot harm.
      const whenIdle = record?.mode === 'interactive' && stop.safeWhenIdle;
      try {
        // As `deliver`: the runner acts on this pane for its one keystroke, so it is NOT wrapped in a second act here.
        return ok(await stopTurn(handle, { key: stop.key, whenIdle }, ferret));
      } catch (error) {
        const failure = runnerDeliveryFailure(error);
        if (failure?.kind === 'held') return err({ refused: failure.code });
        if (failure?.kind === 'not_ready' && failure.why === 'exited') return err({ refused: 'no_pane' });
        throw error;
      }
    },
    // ── the send path's pane look and composer acts (additive). None is wrapped in a second act here: the runner acts
    // on the pane for each write it makes, and the reads write nothing.
    observe: async (): Promise<Result<RunnerPaneObservation, HarnessRefusal>> => {
      const found = pane();
      if (!found.ok) return found;
      const { handle, runner } = found.value;
      const observe = runner.observe?.bind(runner);
      if (observe === undefined) return err({ refused: 'plugin_unavailable' });
      const seen = await observe(handle, ferret).catch(() => undefined);
      return seen === undefined ? err({ refused: 'no_pane' }) : ok(seen);
    },
    heldAt: async (text: string): Promise<Result<RunnerHeldAt | undefined, HarnessRefusal>> => {
      const found = pane();
      if (!found.ok) return found;
      const { handle, runner } = found.value;
      const heldAt = runner.heldAt?.bind(runner);
      if (heldAt === undefined) return err({ refused: 'plugin_unavailable' });
      // A pane that cannot be read REJECTS (it is not "not held"): the caller decides what an unread pane allows.
      return ok(await heldAt(handle, text, ferret));
    },
    clearComposer: async (text: string): Promise<Result<RunnerComposerCleared, HarnessDeliveryFailure>> => {
      const found = pane();
      if (!found.ok) return found;
      const { handle, runner } = found.value;
      const clear = runner.clearComposer?.bind(runner);
      if (clear === undefined) return err({ refused: 'plugin_unavailable' });
      return await written(async () => await clear(handle, text, ferret));
    },
    submitComposer: async (
      text: string,
      strict?: boolean,
    ): Promise<Result<RunnerComposerSubmitted, HarnessDeliveryFailure>> => {
      const found = pane();
      if (!found.ok) return found;
      const { handle, runner } = found.value;
      const submit = runner.submitComposer?.bind(runner);
      if (submit === undefined) return err({ refused: 'plugin_unavailable' });
      return await written(async () => await submit(handle, text, strict, ferret));
    },
    stopActive: async (): Promise<Result<RunnerPaneObservation | undefined, HarnessRefusal>> => {
      const found = pane();
      if (!found.ok) return found;
      const { handle, runner } = found.value;
      const record = registry.get(ferret);
      const stop = record === undefined ? undefined : ports.harness(record.harness)?.turnStop;
      const stopActive = runner.stopActiveTurn?.bind(runner);
      if (stop === undefined || stopActive === undefined) return err({ refused: 'plugin_unavailable' });
      // NEVER pressed idle (unlike `interrupt`, whose idle rule is the person's own Stop): a send-now's stop is for an
      // ACTIVE turn only. An idle press would answer a permission prompt or dismiss a question the person has not
      // decided; the runner presses only while the pane it reads shows work (`shouldPressStopKey`).
      try {
        return ok(await stopActive(handle, { key: stop.key, whenIdle: false }, ferret));
      } catch (error) {
        const failure = runnerDeliveryFailure(error);
        if (failure?.kind === 'held') return err({ refused: failure.code });
        if (failure?.kind === 'not_ready' && failure.why === 'exited') return err({ refused: 'no_pane' });
        throw error;
      }
    },
    // A file write into THIS ferret's own `attachments/` folder (never a pane key, so no act): the name is checked bare
    // by the writer before any file is written, and the paths answered are the folder's own.
    ...(attachmentsFolder === undefined || attach === undefined
      ? {}
      : {
          deliverFiles: async (files: readonly HarnessFile[]): Promise<readonly string[]> => {
            const folder = await attachmentsFolder(ferret);
            await attach(ferret, files);
            return files.map(file =>
              posix.join(folder, ...(file.folder === undefined ? [] : [file.folder]), file.name),
            );
          },
        }),
    // The same file write into THIS ferret's own `media/` folder (`FY_MEDIA_DIR`): the answer is each name as
    // `src: media:<name>` takes it.
    ...(media === undefined
      ? {}
      : {
          deliverMedia: async (files: readonly HarnessFile[]): Promise<readonly string[]> => {
            await media(ferret, files);
            return files.map(file => file.name);
          },
        }),
    // ── the structured-question acts (additive). The writes are the runner's own guarded ones (not wrapped in a second
    // act here, for the reason `deliver` is not); the reads write nothing. No answer carries pane text but `capture`'s.
    askedQuestion: async (): Promise<AskedQuestionFile | undefined> => {
      const read = ports.session?.askedQuestion?.bind(ports.session);
      if (read === undefined) return undefined;
      const asked = await read(ferret).catch(() => undefined);
      if (asked === undefined) return undefined;
      const record = registry.get(ferret);
      const harness = record === undefined ? undefined : ports.harness(record.harness);
      const stamp = await harness?.transcriptStamp?.(ferret).catch(() => undefined);
      return { ...asked, ...(stamp === undefined ? {} : { transcript: stamp.file }) };
    },
    form: {
      capture: async (): Promise<Result<RunnerFormCapture, HarnessRefusal>> => {
        const found = pane();
        if (!found.ok) return found;
        const { handle, runner } = found.value;
        const capture = runner.formCapture?.bind(runner);
        if (capture === undefined) return err({ refused: 'plugin_unavailable' });
        const seen = await capture(handle, ferret).catch(() => undefined);
        return seen === undefined ? err({ refused: 'no_pane' }) : ok(seen);
      },
      key: async (key: FormKey): Promise<Result<void, HarnessDeliveryFailure>> => {
        const found = pane();
        if (!found.ok) return found;
        const { handle, runner } = found.value;
        const press = runner.formKey?.bind(runner);
        if (press === undefined) return err({ refused: 'plugin_unavailable' });
        return await written(async () => await press(handle, key, ferret));
      },
      pickerKey: async (key: PickerKey): Promise<Result<void, HarnessDeliveryFailure>> => {
        const found = pane();
        if (!found.ok) return found;
        const { handle, runner } = found.value;
        const press = runner.pickerKey?.bind(runner);
        if (press === undefined) return err({ refused: 'plugin_unavailable' });
        return await written(async () => await press(handle, key, ferret));
      },
      paste: async (text: string): Promise<Result<void, HarnessDeliveryFailure>> => {
        const found = pane();
        if (!found.ok) return found;
        const { handle, runner } = found.value;
        const paste = runner.formPaste?.bind(runner);
        if (paste === undefined) return err({ refused: 'plugin_unavailable' });
        return await written(async () => await paste(handle, text, ferret));
      },
    } satisfies HarnessForm,
    // Bound to the ferret this seam was opened for: there is no target to name, so it cannot read another ferret's.
    transcript: {
      read: async (after, limit) => await reader().read(ferret, after, limit),
      readCovering: async since => {
        const current = reader();
        return current.readCovering === undefined
          ? { entries: await current.read(ferret), covered: true }
          : await current.readCovering(ferret, since);
      },
      follow: signal => reader().follow(ferret, signal),
      find: async entry => await reader().find(ferret, entry),
    },
    // G162: resolved on every call like the reader, so an off harness is a 503 and an entries-only one has no bytes.
    transcriptBytes: async () => {
      const record = registry.get(ferret);
      const harness = record === undefined ? undefined : ports.harness(record.harness);
      if (harness === undefined)
        throw new ApiError(503, 'the harness that wrote this conversation is off', 'plugin_unavailable');
      return await harness.transcriptBytes?.(ferret);
    },
  };
}
