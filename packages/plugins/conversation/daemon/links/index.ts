import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { ConfigFileDef, ConfigPort, RootHandle, StatePort } from '@ferretry/kernel/contract';
import { err, type Instant, ok } from '@ferretry/std';
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
} from './lib/conversation-index.ts';
import { type LinkCopier, type LinkKeeper, type LinkLedger, type LinkPreviewer, LinkService } from './lib/service.ts';
import { linkRoutes } from './routes.ts';

export * from './lib/service.ts';
export type { FerretConversationNames, IndexedConversation, IndexSource } from './lib/conversation-index.ts';

export interface LinkNeeds {
  readonly state: StatePort;
  /** Every tree of transcripts the harness plugins hand over, read-only; asked at the start of each index update. */
  readonly sources: () => Promise<readonly IndexSource[]>;
  /** The ferret that runs each harness conversation (`"<harness>:<id>"`) and its name now, from Ferrets. */
  readonly ferretNames: () => Promise<FerretConversationNames>;
  readonly keeper: LinkKeeper;
  /** The `imports` root, where an owner-requested copy of a conversation file is written. */
  readonly imports: RootHandle;
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

/** The most of a transcript an owner-requested copy holds in memory: one write, so one buffer. */
const COPY_MAX_BYTES = 256 * 1024 * 1024;
const COPY_WINDOW_BYTES = 4 * 1024 * 1024;

/**
 * Ferretry's own copy of a conversation, below the `imports` root at the same relative path. The history is read-only
 * (G162), so the original is never changed; the copy is written whole, so it is the file as it was when asked.
 */
const copier = (index: ConversationIndex, imports: RootHandle): LinkCopier => ({
  async copy({ harness, location }) {
    const source = index.sourceOf({ harness, ...location });
    if (source === undefined) return err({ reason: 'That conversation file is outside the folders Ferretry may use.' });
    const to = imports.resolve(`${harness}/${location.kind}/${location.label}/${location.path}`);
    if (!to.ok) return err({ reason: 'That conversation file is outside the folders Ferretry may use.' });
    const stat = await source.files.stat(location.path);
    if (stat === undefined) return err({ reason: 'Its file could not be found to copy.' });
    if (stat.size > COPY_MAX_BYTES)
      return err({ reason: 'Its file is too large to copy; link it instead, so it is read where it is.' });
    const whole = new Uint8Array(stat.size);
    for (let at = 0; at < stat.size; ) {
      const piece = await source.files.read(location.path, at, Math.min(COPY_WINDOW_BYTES, stat.size - at));
      if (piece === undefined || piece.length === 0) return err({ reason: 'Its file could not be read to copy.' });
      whole.set(piece.subarray(0, Math.min(piece.length, stat.size - at)), at);
      at += piece.length;
    }
    await imports.writeBytes(to.value, whole);
    return ok(undefined);
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
    copier: copier(index, needs.imports),
    now: needs.now,
    keptPublished: needs.kept,
    keepInSync: needs.keepInSync,
  });
  return { service, index, routes: linkRoutes(service) } as const;
}
