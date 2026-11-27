import type { FencedPath, FerretId, RootEntry, RootHandle } from '@ferretry/kernel/contract';
import {
  FERRET_READABLE_FOLDERS,
  Harnesses,
  JobKeeper,
  type FerretsApi,
  type RelocationFile,
  type RelocationSource,
} from '../../contract/index.ts';
import { parseSessionId } from '../lib/session-id.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

/** The journal's name in a move: it is a `history` area file, never a path below the session folder. */
const HISTORY_FILE = 'history.jsonl';
/** The most journal events one page reads; the journal is read page by page until it ends. */
const HISTORY_PAGE = 1_000;
/** The deepest folder a listing descends and the most names it walks: a session folder is a handful of folders. */
const MAX_DEPTH = 6;
const MAX_NAMES = 20_000;

/**
 * What a ferret holds that may leave this machine in a move (`FerretsApi.relocationSource`, C-45): its journal and the
 * three folders of its session folder an agent is already allowed to read (`FERRET_READABLE_FOLDERS`: `turns/`,
 * `channel/`, `attachments/`).
 *
 * It lists a closed set: `environment.json` (the plaintext session credential), the effect ledger, the completion
 * markers and `media/` sit beside those folders and are neither listed nor readable through the answer, whatever name a
 * caller asks for. A link is never listed and never followed; a file with a second hard link is skipped, as the kernel's
 * own copy skips it. Only Relocate is handed the member (`relocationPortFor`).
 */
function register(f: FerretsContext): FeatureContribution | undefined {
  const { hooks, registry, sessionFiles, sessionStore, ready } = f;
  const keeper = () => hooks.contributions(JobKeeper)[0]?.item;

  const walk = async (
    root: RootHandle,
    folder: string,
    depth: number,
    found: RelocationFile[],
    budget: { names: number },
  ): Promise<void> => {
    const fenced = root.resolve(folder);
    if (!fenced.ok) throw new Error(`${folder} cannot be confined to the session folder for a move`);
    let entries: readonly RootEntry[];
    try {
      entries = await root.entries(fenced.value, { strict: true });
    } catch (error) {
      // Only an absent optional top-level folder is empty. A known folder disappearing, a failed probe or an IO/permission
      // error must refuse the whole move, otherwise a successful export could silently drop attachments.
      if (
        depth === 1 &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT' &&
        (await root.lstat(fenced.value)) === undefined
      )
        return;
      throw new Error(`${folder} could not be listed for a move`, { cause: error });
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (++budget.names > MAX_NAMES) throw new Error('the session has too many files to move without loss');
      const path = `${folder}/${entry.name}`;
      if (entry.kind === 'directory') {
        if (depth >= MAX_DEPTH) throw new Error(`${path} is too deep to move without loss`);
        await walk(root, path, depth + 1, found, budget);
      } else if (entry.kind === 'file' && entry.links <= 1) found.push({ area: 'session', path, size: entry.size });
    }
  };

  const journal = async (ferret: FerretId, limitBytes = 64 * 1024 * 1024): Promise<Uint8Array> => {
    const id = parseSessionId(ferret);
    const lines: string[] = [];
    let after = 0;
    let bytes = 0;
    let pages = 0;
    for (;;) {
      if (++pages > MAX_NAMES) throw new Error('the journal has too many pages to move safely');
      const page = await sessionStore.replay(id, after, HISTORY_PAGE);
      for (const event of page.events) {
        const line = JSON.stringify(event);
        bytes += new TextEncoder().encode(line).length + 1;
        if (bytes > limitBytes) throw new Error('the journal is larger than a move reads at once');
        lines.push(line);
      }
      if (!page.hasMore || page.nextSequence === undefined) break;
      if (page.nextSequence <= after) throw new Error('the journal did not advance while reading the move');
      after = page.nextSequence;
    }
    return new TextEncoder().encode(lines.map(line => `${line}\n`).join(''));
  };

  const sourceOf = (ferret: FerretId): RelocationSource => {
    const root = () => sessionFiles.root(parseSessionId(ferret));
    return {
      files: async () => {
        const found: RelocationFile[] = [];
        const budget = { names: 0 };
        for (const folder of FERRET_READABLE_FOLDERS) await walk(root(), folder, 1, found, budget);
        found.push({ area: 'history', path: HISTORY_FILE, size: (await journal(ferret)).byteLength });
        return found;
      },
      read: async (file, limitBytes) => {
        if (file.area === 'history') {
          if (file.path !== HISTORY_FILE) throw new Error('the journal is the one history file of a move');
          const bytes = await journal(ferret, limitBytes);
          if (bytes.byteLength > limitBytes) throw new Error('the journal is larger than a move reads at once');
          return bytes;
        }
        const top = file.path.split('/')[0] ?? '';
        if (!(FERRET_READABLE_FOLDERS as readonly string[]).includes(top))
          throw new Error('only the turns, queued messages and attachments of a ferret can be read for a move');
        const handle = root();
        const fenced = handle.resolve(file.path);
        if (!fenced.ok) throw new Error('that file is outside the ferret’s session folder');
        const lstat = await handle.lstat(fenced.value as FencedPath);
        if (lstat?.kind !== 'file' || lstat.links > 1) throw new Error('that is not a plain file of this ferret');
        if (lstat.size > limitBytes) throw new Error(`${file.path} is larger than one file of a move can be`);
        const bytes = await handle.readBytes(fenced.value, limitBytes + 1);
        if (bytes.length > limitBytes) throw new Error(`${file.path} grew beyond the move’s file limit`);
        return bytes;
      },
      busy: async () => {
        const record = registry.get(ferret);
        const reasons: string[] = [];
        if (record === undefined) return ['this machine does not know the ferret'];
        if (record.state !== 'idle' && record.state !== 'stopped')
          reasons.push('the ferret is still working; let it finish its turn first');
        const jobs = (
          await keeper()
            ?.jobs(ferret)
            .catch(() => undefined)
        )?.filter(job => job.state === 'running');
        if (jobs !== undefined && jobs.length > 0)
          reasons.push(
            `${String(jobs.length)} background job${jobs.length === 1 ? ' is' : 's are'} still running; a job cannot move`,
          );
        return reasons;
      },
      conversation: async () => {
        const record = registry.get(ferret);
        const found = record === undefined ? 'unavailable' : hooks.provider(Harnesses, record.harness);
        if (found === 'unavailable' || found.packConversation === undefined)
          return {
            ok: false,
            error: { reason: 'this ferret’s harness cannot pack its conversation to move it to another machine yet' },
          };
        return await found.packConversation(ferret);
      },
    };
  };

  return {
    port: {
      relocationSource: async ferret => {
        await ready();
        return registry.get(ferret) === undefined ? undefined : sourceOf(ferret);
      },
    },
  };
}

/** Only Relocate is handed `relocationSource`: it reads session files no other plugin may. */
export function relocationPortFor(needer: string, port: Partial<FerretsApi>): Partial<FerretsApi> {
  const { relocationSource, ...rest } = port;
  return needer === 'relocate' && relocationSource !== undefined ? { ...rest, relocationSource } : rest;
}

export default { id: 'relocation-source', register } satisfies FerretsFeature;
