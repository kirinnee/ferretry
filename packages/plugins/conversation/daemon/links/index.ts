import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { ConfigFileDef, ConfigPort, StatePort } from '@ferretry/kernel/contract';
import { err, type Instant, ok, type Result } from '@ferretry/std';
import {
  CONVERSATION_CONFIG,
  CONVERSATION_INDEX_STATE,
  type ConversationConfig,
  LINKS_STATE,
  type LinksFile,
} from '../../contract/index.ts';
import { ClaudeTranscriptParser } from '../reader/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../reader/lib/transcript/codex.ts';
import { PacedTranscriptParser } from '../reader/lib/transcript/sliced.ts';
import type { TranscriptParser } from '../reader/lib/transcript/types.ts';
import { conversationFiles } from './adapters/conversation-files.ts';
import { FileConversationDescriber } from './lib/conversation-describer.ts';
import {
  ConversationIndex,
  type FerretConversationNames,
  type IndexedConversation,
  type IndexParser,
  type IndexSource,
  type ScrubBatch,
} from './lib/conversation-index.ts';
import { type LinkCopier, type LinkKeeper, type LinkLedger, type LinkPreviewer, LinkService } from './lib/service.ts';
import { linkRoutes } from './routes.ts';

export * from './lib/service.ts';
export type { FerretConversationNames, IndexedConversation, IndexSource } from './lib/conversation-index.ts';

/** The harness plugin's own copy-on-link: `source` is the file's path below the harness's history folder (`projects/…`). */
export type LinkImporter = (
  harness: string,
  input: { readonly id: string; readonly source: string },
) => Promise<Result<void, { readonly reason: string }>>;

export interface LinkNeeds {
  readonly state: StatePort;
  /** Every tree of transcripts the harness plugins hand over, read-only; asked at the start of each index update. */
  readonly sources: () => Promise<readonly IndexSource[]>;
  /** The ferret that runs each harness conversation (`"<harness>:<id>"`) and its name now, from Ferrets. */
  readonly ferretNames: () => Promise<FerretConversationNames>;
  /** Scrubs the titles the index stores, one read of the vault's values per batch (the kernel's read-scoped redaction). */
  readonly scrubbing?: ScrubBatch;
  /** Offers Ferrets a title made from a ferret's conversation (`adoptTitle`); Ferrets keeps an owner's. */
  readonly adoptTitle?: (ferret: string, title: string) => Promise<'adopted' | 'kept'>;
  readonly keeper: LinkKeeper;
  /**
   * Asks a harness plugin to copy one conversation of the owner's own history into ITS shared history pool
   * (`FerretsApi.importConversation`): the harness owns its pool, Conversation writes no other plugin's state.
   */
  readonly importer: LinkImporter;
  readonly now: () => Instant;
  readonly yieldToLoop?: () => Promise<void>;
  readonly clockMs: () => number;
  /** Waits `ms`; absent, a listing waits for its refresh however long it takes. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly warn?: (message: string) => void;
  readonly kept: (ferret: FerretId, link: string) => void;
  /** "Keep in sync", read from `conversation.yaml` on every listing. */
  readonly keepInSync: () => boolean;
}

/**
 * "Keep in sync": `keepInSync` in the version of `conversation.yaml` IN EFFECT, asked each time it is called, so an
 * edit the kernel has loaded is live for the next listing. On when the file is absent or says nothing. A held edit
 * (a loosening waiting for the owner) is not in effect, as for every other setting.
 */
export const keepInSyncFrom =
  (config: Pick<ConfigPort, 'file'>): (() => boolean) =>
  () =>
    config.file(CONVERSATION_CONFIG as ConfigFileDef<ConversationConfig>)?.keepInSync ?? true;

const EMPTY: LinksFile = { format: 1, links: [] };

/** `links.json`: which conversations a ferret reads from the harness's own file. */
const ledger = (state: StatePort): LinkLedger => ({
  async read() {
    const read = await state.read(LINKS_STATE);
    if (!read.ok) throw new Error(read.error.sentence);
    return read.value ?? EMPTY;
  },
  async add(link) {
    const updated = await state.update(
      LINKS_STATE,
      (current): LinksFile => ({
        format: 1,
        links: [
          ...(current ?? EMPTY).links.filter(each => !(each.harness === link.harness && each.id === link.id)),
          link,
        ],
      }),
    );
    if (!updated.ok) throw new Error(updated.error.sentence);
  },
});

/** The longest text the index parses without pacing: its head and tail reads, 1.25 MiB at most. */
const DIRECT_PARSE_MAX_CHARS = 2 * 1024 * 1024;

/**
 * Ferretry's own copy of a conversation of the owner's computer, in the harness's shared history pool at the same
 * relative path, which the ferret then resumes. The index says where the conversation is; the harness plugin makes the
 * copy (it owns its pool): it reads the owner's history through its read-only root, so the original is never written,
 * linked or locked, and the copy is written whole. A conversation already in the pool needs no copy; one still in a
 * ferret's own home (not pooled yet) is refused, since no other ferret could resume it from there.
 */
const copier = (importer: LinkImporter): LinkCopier => ({
  async copy({ harness, id, location }) {
    if (location.kind === 'pool') return ok(undefined);
    if (location.kind !== 'computer')
      return err({
        reason: "That conversation is in a ferret's own home, not in the shared pool, so it cannot be kept.",
      });
    return await importer(harness, { id, source: location.path });
  },
});

/** A preview is read fresh from the one file the index names: the same read, parse and clean as a listing used to do. */
const previewer = (
  index: ConversationIndex,
  parsers: ConstructorParameters<typeof FileConversationDescriber>[1],
): LinkPreviewer => ({
  async preview(conversation: IndexedConversation, count) {
    const source = index.sourceOf(conversation);
    if (source === undefined) return undefined;
    const describer = new FileConversationDescriber(conversationFiles(source.files), parsers);
    return await describer.preview(
      {
        harness: conversation.parser,
        source: conversation.path,
        relativePath: conversation.path,
        nameId: conversation.row.id,
      },
      count,
    );
  },
});

/** The links: the service, the index it reads and its five routes. Part a's `daemon/index.ts` registers `routes` under their manifest keys. */
export function buildLinks(needs: LinkNeeds) {
  const pacing = { now: needs.clockMs, yieldToLoop: needs.yieldToLoop ?? (async () => undefined) };
  const parsers = {
    claude: new PacedTranscriptParser(new ClaudeTranscriptParser(), pacing),
    codex: new PacedTranscriptParser(new CodexTranscriptParser(), pacing),
  };
  // The index reads at most a megabyte or so at a time and hands the loop back between files, so a read that size is parsed
  // in one go (pacing it in slices costs half again as much); only a wider one, the rare first-4-MiB look, is sliced.
  const direct = (parser: TranscriptParser, paced: PacedTranscriptParser): IndexParser => ({
    async parse(input) {
      return input.text.length <= DIRECT_PARSE_MAX_CHARS ? parser.parse(input) : await paced.parse(input);
    },
  });
  const index = new ConversationIndex({
    sqlite: () => needs.state.sqlite(CONVERSATION_INDEX_STATE),
    sources: needs.sources,
    ferretNames: needs.ferretNames,
    ...(needs.scrubbing === undefined ? {} : { scrubbing: needs.scrubbing }),
    ...(needs.adoptTitle === undefined ? {} : { adoptTitle: needs.adoptTitle }),
    parsers: {
      claude: direct(new ClaudeTranscriptParser(), parsers.claude),
      codex: direct(new CodexTranscriptParser(), parsers.codex),
    },
    nowMs: needs.clockMs,
    ...(needs.sleep === undefined ? {} : { sleep: needs.sleep }),
    ...(needs.yieldToLoop === undefined ? {} : { yieldToLoop: needs.yieldToLoop }),
    ...(needs.warn === undefined ? {} : { warn: needs.warn }),
  });
  const service = new LinkService({
    index,
    previewer: previewer(index, parsers),
    ledger: ledger(needs.state),
    keeper: needs.keeper,
    copier: copier(needs.importer),
    now: needs.now,
    keptPublished: needs.kept,
    keepInSync: needs.keepInSync,
  });
  return { service, index, routes: linkRoutes(service) } as const;
}
