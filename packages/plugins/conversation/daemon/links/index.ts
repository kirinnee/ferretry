import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { ConfigFileDef, ConfigPort, RootHandle, StatePort } from '@ferretry/kernel/contract';
import { err, type Instant, ok } from '@ferretry/std';
import {
  CONVERSATION_CONFIG,
  type ConversationConfig,
  FINDER_STATE,
  LINKS_STATE,
  type LinksFile,
} from '../../contract/index.ts';
import { ClaudeTranscriptParser } from '../reader/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../reader/lib/transcript/codex.ts';
import { PacedTranscriptParser } from '../reader/lib/transcript/sliced.ts';
import { conversationFiles } from './adapters/conversation-files.ts';
import { FileConversationDescriber } from './lib/conversation-describer.ts';
import {
  type FinderCache,
  type LinkCopier,
  type LinkHarness,
  type LinkKeeper,
  type LinkLedger,
  LinkService,
} from './lib/service.ts';
import { linkRoutes } from './routes.ts';

export * from './lib/service.ts';

export interface LinkNeeds {
  readonly state: StatePort;
  /** The `harness-history` root, read-only. */
  readonly history: RootHandle;
  readonly harnesses: () => readonly LinkHarness[];
  readonly keeper: LinkKeeper;
  /** The `imports` root, where an owner-requested copy of a conversation file is written. */
  readonly imports: RootHandle;
  readonly now: () => Instant;
  readonly yieldToLoop?: () => Promise<void>;
  readonly clockMs: () => number;
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

/** `finder.json`: a cache. A damaged one is dropped and rebuilt, so a read that fails answers empty. */
const finder = (state: StatePort): FinderCache => ({
  async read() {
    const read = await state.read(FINDER_STATE);
    return read.ok ? (read.value?.files ?? {}) : {};
  },
  async write(files) {
    await state.write(FINDER_STATE, { format: 1, files: { ...files } });
  },
});

/**
 * Ferretry's own copy of a conversation, below the `imports` root at the same relative path. The harness-history root is
 * read-only (G162), so the original is never changed; the copy is written whole, so it is the file as it was when asked.
 */
const copier = (history: RootHandle, imports: RootHandle): LinkCopier => ({
  async copy({ source }) {
    const from = history.resolve(source);
    const to = imports.resolve(source);
    if (!from.ok || !to.ok) return err({ reason: 'That conversation file is outside the folders Ferretry may use.' });
    const bytes = await history.readBytes(from.value);
    await imports.writeText(to.value, new TextDecoder('utf-8').decode(bytes));
    return ok(undefined);
  },
});

/** The links: the service and its five routes. Part a's `daemon/index.ts` registers `routes` under their manifest keys. */
export function buildLinks(needs: LinkNeeds) {
  const pacing = { now: needs.clockMs, yieldToLoop: needs.yieldToLoop ?? (async () => undefined) };
  const files = conversationFiles(needs.history);
  const describer = new FileConversationDescriber(files, {
    claude: new PacedTranscriptParser(new ClaudeTranscriptParser(), pacing),
    codex: new PacedTranscriptParser(new CodexTranscriptParser(), pacing),
  });
  const service = new LinkService({
    harnesses: needs.harnesses,
    files,
    describer,
    ledger: ledger(needs.state),
    finder: finder(needs.state),
    keeper: needs.keeper,
    copier: copier(needs.history, needs.imports),
    now: needs.now,
    keptPublished: needs.kept,
    keepInSync: needs.keepInSync,
  });
  return { service, routes: linkRoutes(service) } as const;
}
