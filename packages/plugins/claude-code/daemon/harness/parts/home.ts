import type { FencedPath, FerretId, RootHandle } from '@ferretry/kernel/contract';
import type { HomePlan, LaunchSpec } from '@ferretry/core-ferrets/contract';
import { LaunchRefusal, materializeSkills, poolHomeHistory } from '@ferretry/core-ferrets/contract';
import { CLAUDE_CODE_HISTORY_ENTRIES } from '../../../contract/index.ts';
import { MAX_HOME_DOCUMENT_BYTES as MAX_CLAUDE_JSON_BYTES, mergeClaudeJson } from '../../lib/harness/claude-json.ts';
import { channelsOn, HOME_FILES, homeText } from '../../lib/harness/launch.ts';
import type { LaunchSettingsInputs } from '../../lib/harness/launch-settings.ts';
import { type ClaudeCore, claudeHome, fenced, type Serves } from './core.ts';
import { launchInputs } from './launch-settings.ts';

/** Links the home's history entries to the pool (idempotent), logs what was kept aside and the one sentence if any stayed unpooled. */
async function poolHistory(core: ClaudeCore, ferret: FerretId): Promise<void> {
  const pooled = await poolHomeHistory({
    roots: core.deps.roots,
    ferret,
    entries: CLAUDE_CODE_HISTORY_ENTRIES,
  });
  if (pooled.conflicts.length > 0)
    core.deps.warn?.(
      `Ferret ${ferret}: ${pooled.conflicts.length} file(s) it already had were kept in the pool's .conflicts folder because the shared pool already held a file of that name.`,
    );
  if (pooled.sentence !== undefined) core.deps.warn?.(pooled.sentence);
}

/**
 * The ferret's home, made before anything is written through it (today's `directory` operation, 0700): created or
 * narrowed by the kernel through the checked `agent-homes` folder, refused when a link or a file is at its name. The
 * scoped handle then re-proves on every read and write that no link from FY_HOME down rebases it (S42).
 */
async function ensureHome(core: ClaudeCore, spec: LaunchSpec): Promise<RootHandle> {
  const home = claudeHome(core, spec.ferret);
  if (fenced(home.resolve('')) !== spec.home)
    throw new Error('the launch home does not match the ferret agent-homes subfolder');
  const homes = core.deps.roots.root('agent-homes');
  await homes.ensurePrivateDirectory(fenced(homes.resolve(spec.ferret)));
  return home;
}

/**
 * Refuses the launch, with the kernel's sentence, when any folder from FY_HOME down to the ferret's home is a link, is
 * owned by someone else or is writable by its group or everyone. Nothing is changed or narrowed: a check, not a lock
 * (docs/secrets.md names what that leaves).
 */
export async function requirePrivateChain(home: RootHandle): Promise<void> {
  const verdict = await home.checkPrivateChain(fenced(home.resolve('.')));
  if (!verdict.ok) throw new LaunchRefusal(`the ferret was not started: ${verdict.error.reason}`);
}

/**
 * The `.claude.json` to write, or `undefined` to leave it as it is (already seeded, or a document that cannot be
 * merged — see `mergeClaudeJson`). Read through the ferret's own home, so a link or a file the root refuses fails
 * the launch exactly as the write would; one too large to read is left as it is, like one that is not JSON.
 */
async function claudeJsonText(
  home: RootHandle,
  fresh: string,
  version: string | undefined,
): Promise<string | undefined> {
  const path = fenced(home.resolve(HOME_FILES.claudeJson));
  const info = await home.stat(path);
  if (info === undefined || info.kind !== 'file') return mergeClaudeJson(undefined, fresh, version);
  if (info.size > MAX_CLAUDE_JSON_BYTES) return undefined;
  return mergeClaudeJson(await home.readText(path, MAX_CLAUDE_JSON_BYTES), fresh, version);
}

/** The home written from ONE read of this plugin's configuration, the same read the argv and the record are built from. */
export async function prepareHomeFrom(
  core: ClaudeCore,
  spec: LaunchSpec,
  inputs: LaunchSettingsInputs & { readonly channels?: boolean },
  version?: string | undefined,
): Promise<HomePlan> {
  const home = await ensureHome(core, spec);
  // Nothing is written into a home under a folder chain another user could rewrite (v4's checked directory chain, now the
  // kernel's rule).
  await requirePrivateChain(home);
  // An entry refused before any move stays this ferret's own. A merge interrupted after a move refuses this launch
  // until a retry completes it, so a missing local transcript cannot silently become a new conversation.
  await poolHistory(core, spec.ferret);
  // The selected skills: Skills' shared folders linked into `skills/`, the rest of that folder swept (one link rule).
  await materializeSkills(home, spec.parts, []);
  const text = homeText({
    folder: spec.folder,
    permissionMode: inputs.permissionMode,
    instructions: spec.instructions,
    parts: spec.parts,
    settings: inputs.settings as never,
    hooks: inputs.hooks as never,
    effort: spec.effort,
    fast: spec.options?.fast,
    channels: channelsOn(inputs.channels, spec.parts),
    fyCommand: core.deps.fyCommand ?? 'fy',
  });
  const files: FencedPath[] = [];
  const write = async (name: string, content: string): Promise<void> => {
    const path = fenced(home.resolve(name));
    await home.writeText(path, content);
    files.push(path);
  };
  await write(HOME_FILES.memory, text.memory);
  await write(HOME_FILES.settings, text.settings);
  await write(HOME_FILES.overlay, text.overlay);
  // MERGED into the document already there, never replaced: Claude keeps its own decisions in it (a project
  // server the person disabled among them), and a launch must not undo them (today's wrapper seed).
  const claudeJson = await claudeJsonText(home, text.claudeJson, version);
  if (claudeJson !== undefined) await write(HOME_FILES.claudeJson, claudeJson);
  if (text.mcp !== undefined) await write(HOME_FILES.mcp, text.mcp);
  return { files, args: [] };
}

export const homePart = (core: ClaudeCore): Serves<'homeFor' | 'prepareHome'> => ({
  /** `state/claude-code/agent-homes/<ferret>`, resolved through this plugin's own `agent-homes` root (S42). */
  async homeFor(ferret: FerretId): Promise<FencedPath> {
    return fenced(claudeHome(core, ferret).resolve(''));
  },

  async prepareHome(spec: LaunchSpec): Promise<HomePlan> {
    return await prepareHomeFrom(core, spec, await launchInputs(core, spec.runtime));
  },
});
