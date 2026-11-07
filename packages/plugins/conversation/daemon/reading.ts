import type { AsksApi } from '@ferretry/core-asks/contract';
import type { FerretId, FerretsApi } from '@ferretry/core-ferrets/contract';
import { ApiError, type KernelPorts, type RouteHandler } from '@ferretry/kernel/contract';
import type { ToolHandler } from '@ferretry/kernel/manifest';
import { err, milliseconds, ok, type Result } from '@ferretry/std';
import type { ConversationApi, ConversationRefusal, RenderBody, RenderMeta } from '../contract/index.ts';
import { buildAttachments } from './attachments/index.ts';
import { AttachmentError } from './attachments/lib/index.ts';
import { buildLinks } from './links/index.ts';
import type { LinkHarness, LinkKeeper } from './links/lib/service.ts';
import { registerReader } from './reader/index.ts';
import type { TranscriptReadRedactor } from './reader/lib/reads.ts';
import { messageTokenCodec } from './reader/adapters/message-token-key.ts';
import { buildRenders } from './renders/index.ts';
import { RenderError } from './renders/lib/types.ts';
import { buildSearch, WORK_SEARCH_WARM_DELAY_MS, type WorkSource } from './search/index.ts';
import { tryParseSessionId } from './seams/ferret-id.ts';

/** Said by everything that needs a harness plugin's transcript reader or conversation lists. */
export const HARNESS_PENDING =
  'This needs the harness plugin that wrote the conversation, and Conversation is not connected to it yet. Read the conversation from the harness itself for now.';

/** THE HARNESS SEAM: Ferrets offers no way to reach a ferret's harness reader from another plugin yet, so these refuse. */
const harnessPending = (): never => {
  throw new ApiError(503, HARNESS_PENDING, 'conversation_harness_unavailable');
};

const KEEP_PENDING =
  'Keeping a conversation as a ferret waits on Ferrets starting a ferret from a harness conversation.';

const scrubData = (value: unknown, text: (s: string) => string): unknown => {
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return value.map(item => scrubData(item, text));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(Object.entries(value).map(([name, each]) => [name, scrubData(each, text)]));
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
  readonly routes: Readonly<Record<string, RouteHandler>>;
  readonly tools: { readonly search_work: ToolHandler };
  readonly api: ReadingApi;
  /** A ferret stopped or is gone: its attachment plaintext is zeroed and forgotten. */
  release(ferret: string): void;
  /** The daemon is stopping: nothing more is scheduled. */
  stop(): void;
}

/**
 * Part b's slices (reader, links, attachments, renders, work search) over the kernel's ports and the declared needs. What
 * only a harness plugin can say (a ferret's transcript, the conversations a harness holds, starting a ferret from one)
 * refuses with a sentence at {@link HARNESS_PENDING} until Ferrets offers it.
 */
export function buildReading(deps: {
  readonly kernel: KernelPorts;
  readonly ferrets: FerretsApi;
  readonly asks: Pick<AsksApi, 'open'>;
  readonly onKept: (ferret: FerretId, link: string) => void;
  /** The work other plugins hand the work search through `search.sources` (Board's cards), asked on every use. */
  readonly searchSources?: () => readonly WorkSource[];
}): ReadingHalf {
  const { kernel, ferrets, asks } = deps;
  const history = kernel.roots.root('harness-history');
  const imports = kernel.roots.root('imports');

  const reader = registerReader({
    transcripts: async () => harnessPending(),
    exists: async ferret => {
      const id = tryParseSessionId(ferret);
      return id !== undefined && (await ferrets.get(id)) !== undefined;
    },
    codec: messageTokenCodec(kernel.state),
    redactor: readRedactor(kernel),
    history,
    locate: { locate: async () => harnessPending() },
    now: () => kernel.clock.nowMs(),
  });

  const harnesses = (): readonly LinkHarness[] => harnessPending();
  const keeper: LinkKeeper = {
    keep: async () => ({ ok: false, error: { code: 'unavailable', reason: KEEP_PENDING } }),
  };
  const links = buildLinks({
    state: kernel.state,
    history,
    imports,
    harnesses,
    keeper,
    now: () => kernel.clock.now(),
    clockMs: () => kernel.clock.nowMs(),
    kept: deps.onKept,
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
    ...(deps.searchSources === undefined ? {} : { sources: deps.searchSources }),
    now: () => kernel.clock.nowMs(),
    warn: message => kernel.log.warn(message),
  });
  // Today's warm-up: the index is built a little after start, so the first search rarely waits for it.
  const cancelWarm = kernel.clock.after(milliseconds(WORK_SEARCH_WARM_DELAY_MS), () => search.service.warm());

  const pendingRefusal = async () => err({ code: 'conversation_harness_unavailable', message: HARNESS_PENDING });
  const api: ReadingApi = {
    // THE HARNESS SEAM: the routes serve these through `registerReader`; the port answers the same sentence.
    transcript: pendingRefusal,
    logPage: pendingRefusal,
    logSearch: pendingRefusal,

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

  return {
    routes: {
      ...reader.routes,
      ...links.routes,
      ...attachments.routes,
      ...renders.routes,
      ...search.routes,
    },
    tools: search.tools,
    api,
    release: ferret => attachments.release(ferret),
    stop: () => cancelWarm(),
  };
}
