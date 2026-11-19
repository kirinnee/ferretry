import type {
  ConversationFinder,
  ConversationImport,
  FoundConversation,
  HarnessHistoryFiles,
  HarnessHistorySource,
  LaunchSpec,
} from '@ferretry/core-ferrets/contract';
import { historyFilesOver } from '@ferretry/core-ferrets/contract';
import { err, ok, type Result } from '@ferretry/std';
import type { ConfigFileDef } from '@ferretry/kernel/contract';
import { CLAUDE_CODE_CONFIG, type HarnessConfig } from '../../../contract/index.ts';
import { claudeTranscriptPath, isConversationId } from '../../lib/harness/claude-path.ts';
import { type ClaudeCore, claudeHome, FIRST_RECORDS_BYTES, type Serves } from './core.ts';

const configFile = CLAUDE_CODE_CONFIG as unknown as ConfigFileDef<HarnessConfig>;

/**
 * Whether the person's own `~/.claude` history may be read (`hostHistory`, default on); read at each call, and FAIL
 * CLOSED. The config port answers a file it cannot read with the last accepted value (or nothing, which reads as the
 * default on), so the value alone would let a broken file keep reading; the file's STATE is asked as well, and an
 * invalid or unreadable file, or a state that cannot be asked, is OFF.
 */
const hostHistoryOn = (core: ClaudeCore): boolean => {
  try {
    if (core.deps.config.fileState(configFile).state === 'invalid') return false;
    return core.deps.config.file(configFile)?.hostHistory ?? true;
  } catch {
    return false;
  }
};

/**
 * The owner's host history, behind the switch for EVERY operation. Conversation caches an issued source and reads through
 * it later (a fresh transcript preview, a re-listing), so the source checks `hostHistory` at each call, not once when it
 * was handed out: off, it lists nothing, finds nothing and reads nothing (the source seam is total, so a refusal is
 * "nothing there", never an error).
 */
const guardedHostFiles = (core: ClaudeCore, files: HarnessHistoryFiles): HarnessHistoryFiles => ({
  entries: async directory => (hostHistoryOn(core) ? await files.entries(directory) : []),
  stat: async path => (hostHistoryOn(core) ? await files.stat(path) : undefined),
  read: async (path, offset, length) => (hostHistoryOn(core) ? await files.read(path, offset, length) : undefined),
});

/**
 * The most `projects/*` folders `hasConversation` lists before it says "cannot tell". One ferret's home holds the
 * folders it was launched in (a handful); a home with more proves nothing either way.
 */
const MAX_PROJECT_FOLDERS = 1_000;
/** The same, for the shared pool, which holds the folders of every ferret on this harness. */
const MAX_POOL_PROJECT_FOLDERS = 5_000;
/** The largest transcript copy-on-link copies (the owner's biggest was 939 MB; p99 was 12 MB): a copy is held whole in memory. */
const MAX_IMPORT_BYTES = 256 * 1024 * 1024;

export const historyPart = (
  core: ClaudeCore,
): Serves<'conversations' | 'hasConversation' | 'historySources' | 'importConversation'> => ({
  /**
   * Whether `claude --resume <id>` would find its conversation in THIS ferret's home, where Claude keeps it as
   * `projects/<its own spelling of the folder>/<id>.jsonl`. Claude's spelling is NOT always the one Ferretry computes
   * (`claudeTranscriptPath`): it keys by the physical working folder (a folder reached through a link spells its real
   * path) and shortens a spelling over 200 characters with a hash. So `false` is answered ONLY when the id is in no
   * `projects/*` folder at all, after a complete listing of at most {@link MAX_PROJECT_FOLDERS} plain folders. Found under
   * Ferretry's own spelling is `true`; found under any other is `undefined` (Claude may well find it), and so is every
   * doubt: a linked or odd entry, a folder too many, a path the root refuses. A resume is never given up on a guess. A
   * ferret converted from v4 names a conversation whose transcript was left behind, and its home has no such file.
   */
  async hasConversation(spec: LaunchSpec, harnessConversation: string): Promise<boolean | undefined> {
    if (!isConversationId(harnessConversation) || !isConversationId(spec.ferret)) return undefined;
    try {
      const own = claudeHome(core, spec.ferret);
      const link = own.resolve('projects');
      if (!link.ok) return undefined;
      const there = await own.lstat(link.value);
      // No `projects` folder: Claude has written no conversation in this home.
      if (there === undefined) return false;
      // `projects` is the link to the shared pool: the conversation is looked for in the pool, which every ferret on this
      // harness reads (one `projects/*/<id>.jsonl` lookup), so a pooled conversation is resumed, never restarted.
      const pooled = there.kind === 'symlink';
      const home = pooled ? core.deps.roots.historyPool() : own;
      const projects = pooled ? home.resolve('projects') : link;
      if (!projects.ok) return undefined;
      const folder = pooled ? await home.lstat(projects.value) : there;
      if (folder === undefined) return false;
      if (folder.kind !== 'directory') return undefined;
      const ours = claudeTranscriptPath(spec.folder, harnessConversation);
      // Ferretry's own spelling is one lookup, before any listing: the common answer needs no walk of a big pool.
      const direct = home.resolve(ours);
      if (direct.ok && (await home.lstat(direct.value))?.kind === 'file') return true;
      const entries = await home.entries(projects.value);
      if (entries.length > (pooled ? MAX_POOL_PROJECT_FOLDERS : MAX_PROJECT_FOLDERS)) return undefined;
      let elsewhere = false;
      for (const entry of entries) {
        // A link could lead to the conversation, and is never followed to find out.
        if (entry.kind === 'symlink' || entry.kind === 'other') return undefined;
        if (entry.kind !== 'directory') continue;
        const relative = `projects/${entry.name}/${harnessConversation}.jsonl`;
        const file = home.resolve(relative);
        if (!file.ok) return undefined;
        if ((await home.lstat(file.value)) === undefined) continue;
        if (relative === ours) return true;
        elsewhere = true;
      }
      return elsewhere ? undefined : false;
    } catch {
      return undefined;
    }
  },

  /**
   * Copy-on-link (docs/design/shared-history.md, 3.2): the owner's own `~/.claude/projects/<folder>/<id>.jsonl` copied
   * into the shared pool at the same relative path, so a ferret started on it resumes the copy. The original is read
   * through the read-only `harness-history` root and is never written, linked or locked; the copy is written whole and
   * only if the pool has nothing at that name (a pooled file is never overwritten).
   */
  async importConversation(input: ConversationImport): Promise<Result<void, { readonly reason: string }>> {
    const refuse = (reason: string): Result<void, { readonly reason: string }> => err({ reason });
    if (!hostHistoryOn(core)) return refuse("Showing Claude's conversations from this computer is turned off.");
    if (!isConversationId(input.id) || !new RegExp(`^projects/[^/]+/${input.id}\\.jsonl$`, 'u').test(input.source))
      return refuse('That is not a Claude Code conversation file of this id.');
    try {
      const historyHome = await core.deps.historyHome();
      if (!historyHome.startsWith('/')) return refuse("Claude Code's history folder is not known on this machine.");
      const history = core.deps.roots.root('harness-history', { subfolder: historyHome });
      const from = history.resolve(input.source);
      const pool = core.deps.roots.historyPool();
      const to = pool.resolve(input.source);
      if (!from.ok || !to.ok) return refuse('That conversation file is outside the folders Ferretry may use.');
      if ((await pool.lstat(to.value)) !== undefined) return ok(undefined);
      const found = await history.stat(from.value);
      if (found?.kind !== 'file') return refuse('That conversation file is not there any more.');
      if (found.size > MAX_IMPORT_BYTES) return refuse('That conversation file is too large to copy (over 256 MB).');
      const folder = pool.resolve(input.source.slice(0, input.source.lastIndexOf('/')));
      if (!folder.ok) return refuse('That conversation file is outside the folders Ferretry may use.');
      await pool.makeDirectory(folder.value, { mode: 0o700 });
      const bytes = await history.readBytes(from.value, MAX_IMPORT_BYTES);
      await pool.writeBytes(to.value, bytes, { exclusive: true });
      return ok(undefined);
    } catch {
      return refuse('The conversation could not be copied.');
    }
  },

  /** Claude's own conversations on this machine, read from its documented history folder only. */
  conversations: {
    list: async folder => {
      if (!hostHistoryOn(core)) return [];
      const historyHome = await core.deps.historyHome();
      if (!historyHome.startsWith('/')) return [];
      const history = core.deps.roots.root('harness-history', { subfolder: historyHome });
      const projects = history.resolve('projects');
      if (!projects.ok) return [];
      const found: FoundConversation[] = [];
      for (const directory of await history.list(projects.value).catch(() => [])) {
        const dir = history.resolve(`projects/${directory}`);
        if (!dir.ok) continue;
        for (const name of await history.list(dir.value).catch(() => [])) {
          if (!name.endsWith('.jsonl') || !isConversationId(name.slice(0, -'.jsonl'.length))) continue;
          const file = history.resolve(`projects/${directory}/${name}`);
          if (!file.ok) continue;
          const stat = await history.stat(file.value);
          if (stat === undefined) continue;
          const head = await history.readText(file.value, FIRST_RECORDS_BYTES).catch(() => '');
          const cwd = firstCwd(head);
          if (cwd === undefined || (folder !== undefined && cwd !== folder)) continue;
          found.push({ id: name.slice(0, -'.jsonl'.length), folder: cwd, updatedAt: stat.modified });
        }
      }
      return found.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },
  } satisfies ConversationFinder,

  /**
   * The past conversations Claude holds, as read-only trees for Conversation's index: the owner's own home (read in place
   * through the `harness-history` root) and each ferret's home under this plugin's `agent-homes`. A link is never followed,
   * so a pooled home lists nothing itself; the pool source lists its transcripts once. Nothing is written.
   */
  async historySources(): Promise<readonly HarnessHistorySource[]> {
    const sources: HarnessHistorySource[] = [];
    const historyHome = hostHistoryOn(core) ? await core.deps.historyHome().catch(() => '') : '';
    if (historyHome.startsWith('/'))
      sources.push({
        kind: 'computer',
        label: 'owner',
        files: guardedHostFiles(
          core,
          historyFilesOver(core.deps.roots.root('harness-history', { subfolder: historyHome })),
        ),
      });
    try {
      sources.push({ kind: 'pool', label: 'pool', files: historyFilesOver(core.deps.roots.historyPool()) });
    } catch {
      // A composition without pooling still offers the owner's and individual homes' history.
    }
    const homes = core.deps.roots.root('agent-homes');
    const top = homes.resolve('');
    if (!top.ok) return sources;
    for (const entry of await homes.entries(top.value).catch(() => [])) {
      if (entry.kind !== 'directory') continue;
      sources.push({ kind: 'ferret-home', label: entry.name, files: historyFilesOver(homes, entry.name) });
    }
    return sources;
  },
});

/** The folder Claude recorded on the first record that names one. */
function firstCwd(head: string): string | undefined {
  for (const line of head.split('\n')) {
    try {
      const record: unknown = JSON.parse(line);
      const cwd = typeof record === 'object' && record !== null ? (record as { cwd?: unknown }).cwd : undefined;
      if (typeof cwd === 'string' && cwd !== '') return cwd;
    } catch {
      // A line cut off by the read limit, or a record that is not JSON: no folder from it.
    }
  }
  return undefined;
}
