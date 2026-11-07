import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { RootHandle, StatePort } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { FINDER_STATE, LINKS_STATE, type LinksFile } from '../../contract/index.ts';
import { ClaudeTranscriptParser } from '../reader/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../reader/lib/transcript/codex.ts';
import { PacedTranscriptParser } from '../reader/lib/transcript/sliced.ts';
import { conversationFiles } from './adapters/conversation-files.ts';
import { FileConversationDescriber } from './lib/conversation-describer.ts';
import { type FinderCache, type LinkHarness, type LinkKeeper, type LinkLedger, LinkService } from './lib/service.ts';
import { linkRoutes } from './routes.ts';

export * from './lib/service.ts';
export { FileConversationDescriber } from './lib/conversation-describer.ts';

export interface LinkNeeds {
  readonly state: StatePort;
  /** The `harness-history` root, read-only. */
  readonly history: RootHandle;
  readonly harnesses: () => readonly LinkHarness[];
  readonly keeper: LinkKeeper;
  readonly now: () => Instant;
  readonly yieldToLoop?: () => Promise<void>;
  readonly clockMs: () => number;
  readonly kept: (ferret: FerretId, link: string) => void;
}

const EMPTY: LinksFile = { format: 1, links: [] };

/** `links.json`: which conversations a ferret reads from the harness's own file. */
const ledger = (state: StatePort): LinkLedger => ({
  async read() {
    const read = await state.read(LINKS_STATE);
    if (!read.ok) throw new Error(read.error.sentence);
    return read.value ?? EMPTY;
  },
  async add(link) {
    const updated = await state.update(LINKS_STATE, (current): LinksFile => ({
      format: 1,
      links: [...(current ?? EMPTY).links.filter(each => !(each.harness === link.harness && each.id === link.id)), link],
    }));
    if (!updated.ok) throw new Error(updated.error.sentence);
  },
});

/** `finder.json`: a cache. A damaged one is dropped and rebuilt, so a read that fails answers empty. */
const finder = (state: StatePort): FinderCache => ({
  async read() {
    const read = await state.read(FINDER_STATE);
    return read.ok && read.value !== undefined ? (read.value as { files?: Record<string, Record<string, string>> }).files ?? {} : {};
  },
  async write(files) {
    await state.write(FINDER_STATE, { format: 1, files } as never);
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
    now: needs.now,
    keptPublished: needs.kept,
  });
  return { service, routes: linkRoutes(service) } as const;
}
