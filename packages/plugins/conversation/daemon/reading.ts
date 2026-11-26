import type { AsksApi } from '@ferretry/core-asks/contract';
import type { ConversationStageSource, FerretId, FerretsApi, HarnessKey } from '@ferretry/core-ferrets/contract';
import { ApiError, type KernelPorts, type RouteHandler } from '@ferretry/kernel/contract';
import type { ToolHandler } from '@ferretry/kernel/manifest';
import { err, milliseconds, ok, type Result } from '@ferretry/std';
import type { ConversationApi, ConversationRefusal, RenderBody, RenderMeta } from '../contract/index.ts';
import { buildAttachments } from './attachments/index.ts';
import { AttachmentError } from './attachments/lib/index.ts';
import { buildLinks, keepInSyncFrom } from './links/index.ts';
import type { FerretConversationNames, IndexSource } from './links/index.ts';
import { ferretConversationNames, startTitleSweep, titleOffer, titleWatch } from './links/lib/ferret-names.ts';
import { indexSourcesOf } from './links/lib/history-groups.ts';
import type { LinkKeeper } from './links/lib/service.ts';
import type { TranscriptOpener } from './reader/adapters/file-reads.ts';
import type { HarnessTranscripts } from './reader/adapters/entries-source.ts';
import { registerReader } from './reader/index.ts';
import { TranscriptReadError, type TranscriptReadRedactor } from './reader/lib/reads.ts';
import type { TranscriptParser } from './reader/lib/transcript/types.ts';
import { messageTokenCodec } from './reader/adapters/message-token-key.ts';
import { buildRenders } from './renders/index.ts';
import { RenderError } from './renders/lib/types.ts';
import { buildSearch, WORK_SEARCH_WARM_DELAY_MS, type WorkSource } from './search/index.ts';
import { QUESTION_TAIL_EVENTS } from './questions/lib/watch.ts';
import { tryParseSessionId } from './seams/ferret-id.ts';
import { harnessFamily } from './seams/harness-family.ts';
import type { TranscriptEvent } from './seams/transcript-types.ts';

/**
 * The ONE sentence said by everything that needs the conversations a harness holds: the Conversations screen (its list
 * and preview), keeping one as a ferret, and the harness history. Fixed wording (owner decision lizzette 2026-11-11), so
 * the app draws it as it is and never a raw error. A ferret's own transcript is not behind it: that reads the harness's
 * bytes.
 */
const HARNESS_PENDING =
  'Not in 5.0 yet: keeping your Claude Code and Codex conversations as ferrets. It waits on Ferrets starting a ferret from a conversation a harness holds.';

const KEEP_PENDING = HARNESS_PENDING;

/** How long after start the conversation index starts reading: after the daemon is answering, before anyone asks. */
const INDEX_WARM_DELAY_MS = 2_000;

/**
 * Structured data with every string masked — the NAMES of its properties too. A secret used as an object key is serialised
 * next, and one with a quote, backslash or newline is then spelled in a way the final text pass cannot match, so a key is
 * masked as the original string, before any serialising.
 */
const scrubData = (value: unknown, text: (s: string) => string): unknown => {
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return value.map(item => scrubData(item, text));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(Object.entries(value).map(([name, each]) => [text(name), scrubData(each, text)]));
  return value;
};

/** Read-scoped masking: every answer is cut from masked text, the values opened for that read only. */
function readRedactor(kernel: KernelPorts): TranscriptReadRedactor {
  return {
    redact: async text => await kernel.redaction.read(scope => scope.text(text)),
    batch: async work =>
      await kernel.redaction.read(scope =>
        work({ text: text => scope.text(text), data: v => scrubData(v, scope.text) }),
      ),
  };
}

const refusalOf = (error: unknown): ConversationRefusal => {
  if (error instanceof AttachmentError) return { code: error.failure, message: error.message };
  if (error instanceof RenderError) return { code: error.code, message: error.message };
  if (error instanceof ApiError) return { code: error.code ?? 'failed', message: error.message };
  // No transcript this daemon can prove is the ferret's reads as "no such transcript"; the rest keep their own word.
  if (error instanceof TranscriptReadError)
    return { code: error.failure === 'no_transcript' ? 'not_found' : error.failure, message: error.message };
  return { code: 'failed', message: error instanceof Error ? error.message : String(error) };
};
const guarded = async <T>(work: () => Promise<T>): Promise<Result<T, ConversationRefusal>> => {
  try {
    return ok(await work());
  } catch (error) {
    return err(refusalOf(error));
  }
};

type ReadingApi = Pick<
  ConversationApi,
  | 'transcript'
  | 'transcriptEvents'
  | 'transcriptLog'
  | 'logPage'
  | 'logSearch'
  | 'addAttachment'
  | 'attachment'
  | 'unlockAttachment'
  | 'relockAttachment'
  | 'saveRender'
  | 'renderMeta'
  | 'render'
  | 'searchWork'
  | 'related'
  | 'links'
  | 'previewLink'
  | 'keep'
>;

export interface ReadingHalf {
  /**
   * The parsed tail of a Codex or Claude Code ferret's transcript, for the question watch (Codex's `request_user_input` is
   * in the transcript while the form is open; Claude's call lands with its result, so its tail is what says a form on the
   * pane is over): `'unreadable'` when it cannot be read, `undefined` for any other harness.
   */
  questionEvents(ferret: string, limit?: number): Promise<readonly TranscriptEvent[] | 'unreadable' | undefined>;
  /** The conversation file the ferret's transcript is now (a replaced conversation is a different file); `undefined` when unknown. */
  questionFile(ferret: string): Promise<string | undefined>;
  readonly routes: Readonly<Record<string, RouteHandler>>;
  readonly tools: { readonly search_work: ToolHandler };
  readonly api: ReadingApi;
  /** `conversation.stage` (Ferrets' start asks it): one indexed conversation's transcript staged where its harness resumes it. */
  readonly stage: ConversationStageSource['stage'];
  /**
   * A stored original of THIS ferret, its digest re-checked: what a send hands to the agent. Rejects with an
   * {@link AttachmentError} for an id that is not this ferret's, a missing or altered original, or an unknown ferret.
   */
  download(
    ferret: string,
    id: string,
  ): Promise<{
    readonly attachment: { readonly id: string; readonly filename: string; readonly mime: string };
    readonly bytes: Uint8Array;
  }>;
  /** A ferret stopped or is gone: its attachment plaintext is zeroed and forgotten, and its transcript handle is closed. */
  release(ferret: string): void;
  /** The daemon is stopping: nothing more is scheduled. */
  stop(): void;
}

/**
 * Part b's slices (reader, links, attachments, renders, work search) over the kernel's ports and the declared needs. A
 * ferret's transcript is read from its harness's proved bytes (Ferrets' `transcriptBytes`). What only a harness plugin
 * can still say (the conversations a harness holds, starting a ferret from one) refuses with the sentence at
 * {@link HARNESS_PENDING} until Ferrets offers it.
 */
export function buildReading(deps: {
  readonly kernel: KernelPorts;
  readonly ferrets: FerretsApi;
  readonly asks: Pick<AsksApi, 'open'> & Partial<Pick<AsksApi, 'snapshots'>>;
  readonly onKept: (ferret: FerretId, link: string) => void;
  /** The work other plugins hand the work search through `search.sources` (Board's cards), asked on every use. */
  readonly workSources?: () => readonly WorkSource[];
  /** The transcript parsers harness plugins declare (`transcript.parsers`), asked on the first read. */
  readonly parsers?: () => readonly TranscriptParser[];
}): ReadingHalf {
  const { kernel, ferrets, asks } = deps;

  /**
   * The ferret's own harness transcript as RAW bytes (G162): `undefined` while no transcript is proved, `unsupported`
   * for a harness that offers entries only. Rejects with the seam's 503 `plugin_unavailable` while the harness is off.
   * Conversation is the ONE consumer; every answer cut from these bytes is masked by the reader (`readRedactor`).
   */
  const bytes: TranscriptOpener = async ferret => {
    const id = tryParseSessionId(ferret);
    const harness = id === undefined ? undefined : await ferrets.harness?.(id);
    if (harness === undefined) return undefined;
    return harness.transcriptBytes === undefined ? 'unsupported' : await harness.transcriptBytes();
  };
  /** What a read falls back to when the harness offers no bytes: its masked entries. */
  const entries: HarnessTranscripts = async ferret => {
    const id = tryParseSessionId(ferret);
    const summary = id === undefined ? undefined : await ferrets.get(id);
    const harness = id === undefined ? undefined : await ferrets.harness?.(id);
    // The format the harness declares for its own entries: Claude Code and Codex by family, any other harness by its facts.
    const family =
      summary === undefined
        ? undefined
        : (harnessFamily(summary.harness) ?? ferrets.harnessFacts(summary.harness)?.transcriptFormat);
    if (family === undefined || harness === undefined) return undefined;
    // The seam's reader is bound to this ferret; the entries source names the ferret itself, so the binding drops it.
    const bound = harness.transcript;
    return {
      harness: family,
      reader: {
        read: async (_ferret, after, limit) => await bound.read(after, limit),
        follow: (_ferret, signal) => bound.follow(signal),
        find: async (_ferret, entry) => await bound.find(entry),
      },
    };
  };
  const reader = registerReader({
    bytes,
    transcripts: entries,
    ...(deps.parsers === undefined ? {} : { parsers: deps.parsers }),
    exists: async ferret => {
      const id = tryParseSessionId(ferret);
      return id !== undefined && (await ferrets.get(id)) !== undefined;
    },
    codec: messageTokenCodec(kernel.state),
    redactor: readRedactor(kernel),
    // Hands the loop back between parse slices, so a long transcript never blocks the daemon (v4 paced the same way).
    yieldToLoop: async () => await kernel.clock.sleep(milliseconds(0)),
    sleep: async (delay: number) => await kernel.clock.sleep(milliseconds(delay)),
    instant: () => kernel.clock.now(),
    now: () => kernel.clock.nowMs(),
  });

  // The transcripts the index reads: every tree each harness plugin hands over through Ferrets (the owner's own home, each
  // ferret's home, later the pool), read-only. A harness that FAILS offers none and its rows stay as they were; one that answers with none (its owner-history switch is off) has them removed.
  const sources = async (): Promise<readonly IndexSource[]> =>
    indexSourcesOf((await ferrets.historySources?.()) ?? [], harnessFamily);
  // Which ferret runs each harness conversation, and its name now (Ferrets' registry, not its files): a rename shows on the
  // next listing.
  const ferretNames = async (): Promise<FerretConversationNames> => ferretConversationNames(await ferrets.list());
  const keeper: LinkKeeper = {
    keep: async () => ({ ok: false, error: { code: 'unavailable', reason: KEEP_PENDING } }),
  };
  const links = buildLinks({
    state: kernel.state,
    sources,
    ferretNames,
    // A refresh clears a ferret's name or an owner's title only from a roster Ferrets says is whole (loaded, every record read);
    // a Ferrets that cannot say is never taken as complete.
    rosterComplete: async () => (await ferrets.rosterComplete?.()) ?? false,
    // Every title is scrubbed with the vault's values before it is stored or offered to a ferret (one read per batch).
    scrubbing: async work => await kernel.redaction.read(scope => work(text => scope.text(text))),
    // r11 S11: a ferret's conversation title is offered to Ferrets (in-process; it keeps an owner's title).
    adoptTitle: titleOffer(ferrets),
    importer: async (harness, input) =>
      (await ferrets.importConversation?.(harness as HarnessKey, input)) ??
      err({ reason: 'No harness is offering to keep a copy of that conversation.' }),
    keeper,
    now: () => kernel.clock.now(),
    clockMs: () => kernel.clock.nowMs(),
    sleep: async ms => await kernel.clock.sleep(milliseconds(ms)),
    yieldToLoop: async () => await kernel.clock.sleep(milliseconds(0)),
    warn: message => kernel.log.warn(message),
    kept: deps.onKept,
    // The version of conversation.yaml in effect, asked on every listing: an edit is live for the next one.
    keepInSync: keepInSyncFrom(kernel.config),
  });

  const attachments = buildAttachments({
    state: kernel.state,
    workers: kernel.workers,
    clock: kernel.clock,
    ferrets,
  });
  const renders = buildRenders({ state: kernel.state, clock: kernel.clock });
  const search = buildSearch({
    asks,
    redaction: kernel.redaction,
    ...(deps.workSources === undefined ? {} : { sources: deps.workSources }),
    now: () => kernel.clock.nowMs(),
    warn: message => kernel.log.warn(message),
  });
  // Today's warm-up: the index is built a little after start, so the first search rarely waits for it.
  const cancelWarm = kernel.clock.after(milliseconds(WORK_SEARCH_WARM_DELAY_MS), () => search.service.warm());
  // The conversation index is read a little after start, in the background, so the first link listing finds most of it done.
  const cancelIndexWarm = kernel.clock.after(milliseconds(INDEX_WARM_DELAY_MS), () => void links.index.refresh());
  // A title the CLI writes later (Claude Code's `ai-title` comes after the first exchange) reaches the drawer without anyone opening the
  // Conversations list: while a ferret can still take one, the index is kept at its own freshness bound.
  const cancelTitleSweep = startTitleSweep({
    every: (intervalMs, tick) => kernel.clock.every(milliseconds(intervalMs), tick),
    watching: async () => titleWatch(await ferrets.list()),
    refresh: async only => await links.index.refreshConversations(only),
    warn: message => kernel.log.warn(message),
  });

  /** The ferret must exist, as the routes' `known` requires; the same 404 for every port member. */
  const knownFerret = async (ferret: FerretId): Promise<void> => {
    if ((await ferrets.get(ferret)) === undefined) throw new ApiError(404, `no ferret ${ferret}`, 'not_found');
  };
  const api: ReadingApi = {
    // The same reader the routes use: every answer is cut from the harness's bytes and masked by `readRedactor`.
    // The newest messages (a tail) unless a cursor continues forward; `through` ends the page at a message.
    transcript: async (ferret, options) =>
      await guarded(async () => {
        await knownFerret(ferret);
        const backward =
          options?.cursor === undefined
            ? { ...(options?.through === undefined ? {} : { through: options.through }) }
            : undefined;
        return await reader.reads.messages(ferret, options?.cursor, options?.limit, backward);
      }),
    transcriptEvents: async (ferret, options) =>
      await guarded(async () => {
        await knownFerret(ferret);
        return await reader.reads.transcriptEvents(ferret, options?.limit);
      }),
    // Today's `operatorReads.logs`: every event kind, rendered and masked as the log is.
    transcriptLog: async (ferret, options) =>
      await guarded(async () => {
        await knownFerret(ferret);
        return { v: 1 as const, ferret, log: await reader.reads.logs(ferret, options?.limit) };
      }),
    logPage: async (ferret, options) =>
      await guarded(async () => {
        await knownFerret(ferret);
        return await reader.reads.logPage(ferret, options ?? {});
      }),
    logSearch: async (ferret, query, options) =>
      await guarded(async () => {
        await knownFerret(ferret);
        return await reader.reads.logSearch(ferret, { q: query, ...options });
      }),

    addAttachment: async (ferret, upload) =>
      await guarded(async () =>
        attachments.scoped.upload(ferret, {
          filename: upload.filename,
          mime: upload.mime,
          bytes: Uint8Array.from(Buffer.from(upload.base64, 'base64')),
        }),
      ),
    attachment: async (ferret, id) =>
      await guarded(async () => {
        const found = await attachments.scoped.download(ferret, id);
        return { attachment: found.attachment, base64: Buffer.from(found.bytes).toString('base64') };
      }),
    unlockAttachment: async (ferret, id, password) =>
      await guarded(async () => attachments.scoped.unlock(ferret, id, password)),
    relockAttachment: async (ferret, id) => await guarded(async () => attachments.scoped.lock(ferret, id)),

    saveRender: async (ferret, request) => await guarded(async () => renders.service.save(request, ferret)),
    renderMeta: async id =>
      await renders.service.meta(id).then(
        (meta: RenderMeta) => meta,
        () => undefined,
      ),
    render: async id =>
      await renders.service.body(id).then(
        (body: RenderBody) => body,
        () => undefined,
      ),

    // read-scoped: none — the work search service scrubs every hit through the kernel redaction before it leaves.
    searchWork: async query => await search.service.search(query),
    related: async request => await search.service.related(request),

    links: async query => await links.service.list(query),
    previewLink: async (harness, id) => {
      const found = await links.service.preview(harness, id).catch(refusalOf);
      if (found === undefined) return err({ code: 'not_found', message: 'No such conversation is on this machine.' });
      return 'code' in found ? err(found) : ok(found);
    },
    keep: async request => await links.service.keep(request),
  };

  const questionEvents: ReadingHalf['questionEvents'] = async (ferret, limit = QUESTION_TAIL_EVENTS) => {
    const id = tryParseSessionId(ferret);
    const summary = id === undefined ? undefined : await ferrets.get(id);
    if (summary === undefined || harnessFamily(summary.harness) === undefined) return undefined;
    const read = await reader.tail(ferret, limit).catch(() => undefined);
    return read?.kind === 'read' ? read.events : 'unreadable';
  };
  const questionFile: ReadingHalf['questionFile'] = async ferret => {
    const read = await reader.tail(ferret, QUESTION_TAIL_EVENTS).catch(() => undefined);
    return read?.kind === 'read' ? read.file : undefined;
  };

  return {
    questionEvents,
    questionFile,
    routes: {
      ...reader.routes,
      ...links.routes,
      ...attachments.routes,
      ...renders.routes,
      ...search.routes,
    },
    tools: search.tools,
    api,
    stage: async ({ harness, conversation }) => await links.service.stage(harness, conversation),
    download: async (ferret, id) => await attachments.scoped.download(ferret, id),
    release: ferret => {
      // Attachments first (their plaintext is the case worth failing closed for), then the ferret's transcript handle.
      try {
        attachments.release(ferret);
      } finally {
        reader.release(ferret);
      }
    },
    stop: () => {
      cancelWarm();
      cancelIndexWarm();
      cancelTitleSweep();
      // Every transcript handle the reader opened is closed with the daemon (a harness would close an idle one in a
      // minute; the one consumer does not wait for that).
      void reader.close();
    },
  };
}
