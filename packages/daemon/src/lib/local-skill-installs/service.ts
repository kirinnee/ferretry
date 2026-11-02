/**
 * Copying ONE skill from somewhere else on this machine (docs/catalogs.md § Copying a skill from this
 * machine). The catalog installer's twin: {@link LocalSkillInstallService.preview} reads the source and
 * answers the full review, WRITING NOTHING; {@link LocalSkillInstallService.apply} writes exactly the files
 * that were reviewed, and records them with the SHA-256 of each.
 *
 * THE SOURCE IS THE INVENTORY'S. The caller names a SKILL.md path; this service looks it up in the machine
 * skills inventory and opens nothing the inventory does not list. The folder is then read the way a catalog
 * share reads one (`readSkillFolder`): links never followed, credential-named files, hard links, binaries and
 * oversized files skipped and SAID, and the same file/size caps. A folder that cannot be carried whole is
 * refused, not trimmed quietly.
 *
 * A COPY, NEVER A LINK, and ONLY THROUGH THE EXISTING WRITE PATHS: a project folder through the folder port
 * (no link followed, compare-and-swap, temp + rename), a runtime through one fleet `catalog.install` change,
 * which the fleet stages and applies like every other. Nothing here opens a path of its own.
 *
 * WHAT THIS SERVICE WROTE IS WHAT IT MAY CHANGE. Something at the destination that no record of ours put
 * there is a conflict — a catalog install's files included, which is how the two stores keep apart without
 * knowing about each other — and so is a file we wrote that has been changed since.
 *
 * THE FLEET WANTS A PROVENANCE for a runtime install. This machine is not a publisher, so the one given is
 * SYNTHETIC and says so: a fixed publisher id of all zeros named "This machine", a fixed catalog, and an
 * item id derived from the skill's name (so an update lands on the same component). A person reads `origin`.
 */
import { posix } from 'node:path';
import {
  type CatalogInstallScope,
  type CatalogInstallTarget,
  type CatalogProvenance,
  type CatalogSourceProblem,
  catalogItemReview,
  catalogItemWarnings,
  CatalogItemNameSchema,
  type FleetComponentInput,
  LOCAL_SKILL_PREVIEW_TTL_SECONDS,
  type LocalSkillInstall,
  type LocalSkillInstalled,
  type LocalSkillInstallList,
  type LocalSkillOrigin,
  type LocalSkillPreview,
  type LocalSkillPreviewRequest,
  type LocalSkillRemoved,
  type SharedCatalogItem,
  SHARED_CATALOG_ITEM_FORMAT,
  type SkillEntry,
} from '@ferretry/protocol';
import type { RelayCrypto } from '@ferretry/relay';
import type { CallerGovernance } from '../api/capability.ts';
import {
  type ProjectSkillFiles,
  type RuntimeSkillAssets,
  SkillFolderChanged,
  SkillFolderRefused,
  type SkillFolderReading,
} from '../catalog-installs/ports.ts';
import type { FleetCatalogService, FreshStepUpContext } from '../fleet/catalog-service.ts';
import { projectRootFor } from '../session-mcp/service.ts';
import { skillOf } from '../shared-catalogs/freeze.ts';
import { readSkillFolder, type SkillTreePort } from '../shared-catalogs/skill-source.ts';
import { LocalSkillRefusalError } from './ports.ts';
import { type HeldLocalSkill, LocalSkillPreviews } from './previews.ts';
import { type LocalSkillInstalledFile, type LocalSkillInstallRecord, type LocalSkillInstallStore } from './store.ts';

export interface LocalSkillInstallServiceDeps {
  readonly crypto: Pick<RelayCrypto, 'sha256'>;
  readonly store: LocalSkillInstallStore;
  /** Every skill the machine inventory lists: the only sources there are. */
  readonly skills: { list(): Promise<readonly SkillEntry[]> };
  readonly skillTree: SkillTreePort;
  /** Every folder a project write may land in: registered projects and live managed worktrees. */
  projectRoots(): Promise<readonly string[]>;
  readonly skillFiles: ProjectSkillFiles;
  readonly runtimeSkills: RuntimeSkillAssets;
  readonly fleet: Pick<
    FleetCatalogService,
    'runtimes' | 'profiles' | 'storedComponent' | 'propose' | 'apply' | 'installCatalogItem'
  >;
  now(): number;
  /** A fresh id: `lsp_…` for a preview, `lsi_…` for a copy. */
  mint(prefix: 'lsp' | 'lsi'): string;
}

/** The caller of a preview or an apply, as the mount identified it. */
export interface LocalSkillCaller {
  /** Who asked: a preview can only be applied by the same one. */
  readonly id: string;
}

/** The synthetic publisher of a local copy: not a daemon, and not shaped like a real one's key. */
const LOCAL_SKILL_PUBLISHER = `fy_daemon_${'0'.repeat(43)}`;
const LOCAL_SKILL_PUBLISHER_NAME = 'This machine';
const LOCAL_SKILL_CATALOG_ID = `cat_${'0'.repeat(22)}`;
const LOCAL_SKILL_CATALOG_NAME = 'Skills on this machine';

/** JSON with every object's keys sorted, so the same value always has the same text. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

const refuse = (code: LocalSkillRefusalError['code'], message: string): never => {
  throw new LocalSkillRefusalError(code, message);
};

/** 16 bytes as 22 base64url characters. */
const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');

const withoutTrailingSlash = (path: string): string => posix.normalize(path).replace(/(?<=.)\/+$/u, '');

interface ResolvedTarget {
  /** A stable key: two copies sharing it would overwrite each other. */
  readonly key: string;
  readonly words: string;
  /** A project target's normalised root, and the skill folder relative to it. */
  readonly root?: string;
  readonly folder?: string;
}

/** A source, found in the inventory and read whole. */
interface ReadSource {
  readonly name: string;
  readonly origin: LocalSkillOrigin;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly skipped: readonly CatalogSourceProblem[];
}

export class LocalSkillInstallService {
  readonly #previews: LocalSkillPreviews;
  /** Applies and removes take turns: each reads the state, writes files, and writes the state back. */
  #turn: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: LocalSkillInstallServiceDeps,
    previews: LocalSkillPreviews = new LocalSkillPreviews(LOCAL_SKILL_PREVIEW_TTL_SECONDS * 1000),
  ) {
    this.#previews = previews;
  }

  /** `GET /v1/skill-installs/local`. */
  async list(): Promise<LocalSkillInstallList> {
    const state = await this.deps.store.read();
    return { installs: state.installs.map(installOf) };
  }

  /** Read the source, judge the target, answer the review. Writes nothing and changes no state. */
  async preview(
    scope: CatalogInstallScope,
    request: LocalSkillPreviewRequest,
    caller: LocalSkillCaller,
  ): Promise<LocalSkillPreview> {
    if (request.target.scope !== scope)
      refuse('local_skill_target_unknown', `this asks for a ${scope} copy but names a ${request.target.scope} target`);
    const source = await this.#readSource(request.source.path);
    const target = await this.#canonicalTarget(request.target);
    const state = await this.deps.store.read();
    const resolved = await this.#resolveTarget(source.name, source.files.length, target);
    const replaces = state.installs.find(install => install.key === resolved.key);
    await this.#destinationState(source.name, target, resolved, replaces);
    const provenance = await this.#provenance(source.name, source.files);
    const now = this.deps.now();
    const previewId = this.deps.mint('lsp') as HeldLocalSkill['previewId'];
    const expiresAt = now + LOCAL_SKILL_PREVIEW_TTL_SECONDS * 1000;
    this.#previews.put(
      {
        previewId,
        caller: caller.id,
        expiresAt,
        name: source.name,
        origin: source.origin,
        provenance,
        target,
        files: source.files,
      },
      now,
    );
    const item = itemOf(source.name, source.files, provenance);
    return {
      previewId,
      expiresAt: new Date(expiresAt).toISOString(),
      name: source.name,
      origin: source.origin,
      provenance,
      target,
      destination: resolved.words,
      review: [...catalogItemReview(item)],
      skipped: [...source.skipped],
      warnings: [...catalogItemWarnings(item)],
      ...(replaces === undefined ? {} : { replaces: { installId: replaces.installId } }),
    };
  }

  /**
   * Copy exactly the previewed files, for the caller that reviewed them. The mount has already claimed the
   * passkey proof where one is due.
   */
  async apply(
    scope: CatalogInstallScope,
    previewId: string,
    caller: LocalSkillCaller,
    governance: CallerGovernance | undefined,
  ): Promise<LocalSkillInstalled> {
    return await this.#inTurn(async () => {
      const lookup = this.#previews.get(previewId, caller.id, this.deps.now());
      if (lookup.kind === 'unknown')
        return refuse(
          'local_skill_preview_unknown',
          'There is no such preview, or it was already used. Preview the skill again.',
        );
      if (lookup.kind === 'expired')
        return refuse(
          'local_skill_preview_expired',
          'That preview ran out of time. Preview the skill again and look it over.',
        );
      const held = lookup.preview;
      if (held.target.scope !== scope)
        return refuse(
          'local_skill_preview_unknown',
          `That preview is for a ${held.target.scope} copy, not a ${scope} one.`,
        );
      // The machine may have moved on since the review: judge again against what is true now.
      const state = await this.deps.store.read();
      const resolved = await this.#resolveTarget(held.name, held.files.length, held.target);
      const replaces = state.installs.find(install => install.key === resolved.key);
      const reading = await this.#destinationState(held.name, held.target, resolved, replaces);
      const written =
        held.target.scope === 'project'
          ? await this.#writeProject(held, resolved, replaces, reading)
          : await this.#writeRuntime(held, held.target, replaces, reading, governance);
      const record: LocalSkillInstallRecord = {
        installId: this.deps.mint('lsi') as LocalSkillInstallRecord['installId'],
        installedAt: new Date(this.deps.now()).toISOString(),
        name: held.name,
        origin: held.origin,
        provenance: held.provenance,
        target: held.target,
        destination: resolved.words,
        key: resolved.key,
        files: written.files,
        ...(resolved.root === undefined ? {} : { root: resolved.root }),
        ...(resolved.folder === undefined ? {} : { folder: resolved.folder }),
        ...(written.componentSha256 === undefined ? {} : { componentSha256: written.componentSha256 }),
      };
      await this.deps.store.write({
        schemaVersion: state.schemaVersion,
        installs: [...state.installs.filter(install => install.installId !== replaces?.installId), record],
      });
      this.#previews.consume(held.previewId);
      return { install: installOf(record), notes: written.notes };
    });
  }

  /** Remove exactly what a copy wrote, refusing if any of it was edited here since. Never asks for a passkey. */
  async remove(
    scope: CatalogInstallScope,
    installId: string,
    governance: CallerGovernance | undefined,
    freshStepUp: FreshStepUpContext,
  ): Promise<LocalSkillRemoved> {
    return await this.#inTurn(async () => {
      const state = await this.deps.store.read();
      const record = state.installs.find(install => install.installId === installId && install.target.scope === scope);
      if (record === undefined)
        return refuse('local_skill_install_unknown', `There is no ${scope} copy ${installId} on this machine.`);
      if (record.target.scope === 'project') await this.#removeProject(record);
      else await this.#removeRuntime(record, governance, freshStepUp);
      await this.deps.store.write({ ...state, installs: state.installs.filter(install => install !== record) });
      return { installId: record.installId, name: record.name, destination: record.destination };
    });
  }

  // ── The source ──────────────────────────────────────────────────────────────────────────────────

  /** Found again in the inventory by its SKILL.md path, then read whole. Refuses what cannot be carried. */
  async #readSource(path: string): Promise<ReadSource> {
    const entry = (await this.deps.skills.list()).find(skill => skill.path === path);
    if (entry === undefined)
      return refuse(
        'local_skill_source_unknown',
        `This machine's skills inventory lists no skill at ${path}. Name a SKILL.md path it lists.`,
      );
    const name = posix.basename(posix.dirname(entry.path));
    if (!CatalogItemNameSchema.safeParse(name).success)
      return refuse(
        'local_skill_source_invalid',
        `${JSON.stringify(name)} is not a name a skill can be copied under: use letters, digits, - and _.`,
      );
    const folder = await readSkillFolder(this.deps.skillTree, entry.path);
    if (folder.refusal !== undefined) return refuse('local_skill_source_invalid', folder.refusal);
    const skill = skillOf(folder.files);
    if (typeof skill === 'string') return refuse('local_skill_source_invalid', `${name} cannot be copied: ${skill}.`);
    const origin: LocalSkillOrigin =
      entry.scope === 'project' && entry.project !== undefined
        ? { kind: 'project', owner: entry.project.root, harness: entry.harness, path: entry.path }
        : { kind: 'account', owner: entry.runtimes[0] ?? 'this machine', harness: entry.harness, path: entry.path };
    return { name, origin, files: skill.files, skipped: folder.problems };
  }

  /** What a runtime install hands the fleet, and what a record keeps: synthetic, and honest about it. */
  async #provenance(
    name: string,
    files: readonly { readonly path: string; readonly content: string }[],
  ): Promise<CatalogProvenance> {
    const item = await this.#bytes(`local-skill-item:${name}`);
    const digest = await this.#hash(canonical({ name, files: files.toSorted((a, b) => (a.path < b.path ? -1 : 1)) }));
    return {
      publisher: LOCAL_SKILL_PUBLISHER,
      publisherName: LOCAL_SKILL_PUBLISHER_NAME,
      catalogId: LOCAL_SKILL_CATALOG_ID,
      catalogName: LOCAL_SKILL_CATALOG_NAME,
      itemId: `itm_${base64Url(item.subarray(0, 16))}`,
      kind: 'skill',
      name,
      version: 1,
      digest: `sha256:${digest}`,
    };
  }

  // ── The target ──────────────────────────────────────────────────────────────────────────────────

  /** A project is one this machine registered or made; a runtime and profile already exist. */
  async #resolveTarget(name: string, count: number, target: CatalogInstallTarget): Promise<ResolvedTarget> {
    if (target.scope === 'project') {
      const wanted = withoutTrailingSlash(target.projectRoot);
      const roots = (await this.deps.projectRoots()).map(withoutTrailingSlash);
      if (projectRootFor(wanted, roots) !== wanted || !roots.includes(wanted))
        return refuse(
          'local_skill_target_unknown',
          `${target.projectRoot} is not a project this machine knows. Register the project, or name the folder of one it has.`,
        );
      const folder = `${target.harness === 'claude' ? '.claude' : '.agents'}/skills/${name}`;
      return {
        root: wanted,
        folder,
        key: `project:${wanted}/${folder}`,
        words: `${wanted}/${folder}/ (${count} file${count === 1 ? '' : 's'})`,
      };
    }
    const runtime = (await this.deps.fleet.runtimes()).runtimes.find(
      candidate => candidate.name === target.runtime || candidate.id === target.runtime,
    );
    if (runtime === undefined)
      return refuse('local_skill_target_unknown', `${target.runtime} is not a runtime on this machine.`);
    const profile = (await this.deps.fleet.profiles()).profiles.find(candidate => candidate.name === target.profile);
    if (profile === undefined)
      return refuse('local_skill_target_unknown', `${target.profile} is not a profile on this machine.`);
    if (runtime.profile !== profile.name)
      return refuse(
        'local_skill_target_unknown',
        `${runtime.name} launches with the profile ${runtime.profile}, not ${profile.name}, so copying there would not reach it.`,
      );
    return {
      key: `fleet:skills/${name}`,
      words: `the skill ${name} in runtime ${runtime.name}, profile ${profile.name}`,
    };
  }

  /** The target as this machine spells it, so two spellings of one place are one place. */
  async #canonicalTarget(target: CatalogInstallTarget): Promise<CatalogInstallTarget> {
    if (target.scope === 'project') return { ...target, projectRoot: withoutTrailingSlash(target.projectRoot) };
    const runtime = (await this.deps.fleet.runtimes()).runtimes.find(
      candidate => candidate.name === target.runtime || candidate.id === target.runtime,
    );
    return runtime === undefined ? target : { ...target, runtime: runtime.name };
  }

  /**
   * What is at the destination right now, at preview and again at apply: refuses when something no record of
   * ours wrote is there, or what we wrote was changed. Answers the folder as it was READ, so the write is
   * guarded by that very reading.
   */
  async #destinationState(
    name: string,
    target: CatalogInstallTarget,
    resolved: ResolvedTarget,
    replaces: LocalSkillInstallRecord | undefined,
  ): Promise<SkillFolderReading> {
    if (target.scope === 'project') {
      const folder = resolved.folder as string;
      const reading = await this.#inspectProject(resolved.root as string, folder);
      this.#checkFolder(reading, replaces, `${folder}/`, `${folder}/`);
      return reading;
    }
    const component = await this.deps.fleet.storedComponent('skills', name);
    if (component !== undefined) {
      if (replaces === undefined)
        refuse('local_skill_conflict', `${name} is already a skill on this machine, and no copy of ours put it there.`);
      if ((await this.#hash(canonical(component))) !== replaces?.componentSha256)
        refuse(
          'local_skill_conflict',
          `${name} was edited on this machine since it was copied, so it was not replaced.`,
        );
    }
    const reading = await this.deps.runtimeSkills.inspect(name);
    this.#checkFolder(reading, replaces, `skills/${name}/`, `${name}/`);
    return reading;
  }

  /** What a copy recorded under `prefix`, by the file's path inside that folder. Exact, never a suffix match. */
  #recorded(record: LocalSkillInstallRecord | undefined, prefix: string): Map<string, string> {
    const recorded = new Map<string, string>();
    for (const file of record?.files ?? [])
      if (file.path.startsWith(prefix)) recorded.set(file.path.slice(prefix.length), file.sha256);
    return recorded;
  }

  /** A folder holds only files an earlier copy of ours wrote, each unchanged (a missing one is not an edit). */
  #checkFolder(
    reading: SkillFolderReading,
    replaces: LocalSkillInstallRecord | undefined,
    prefix: string,
    where: string,
  ): void {
    if (!reading.exists || reading.files.size === 0) return;
    if (replaces === undefined)
      refuse('local_skill_conflict', `${where} already holds files that no copy of ours put there.`);
    const recorded = this.#recorded(replaces, prefix);
    for (const [path, hash] of reading.files) {
      const expected = recorded.get(path);
      if (expected === undefined)
        refuse('local_skill_conflict', `${where}${path} is here but no copy of ours wrote it.`);
      if (expected !== hash)
        refuse('local_skill_conflict', `${where}${path} was edited on this machine since it was copied.`);
    }
  }

  // ── Project writes ──────────────────────────────────────────────────────────────────────────────

  async #writeProject(
    held: HeldLocalSkill,
    resolved: ResolvedTarget,
    replaces: LocalSkillInstallRecord | undefined,
    reading: SkillFolderReading,
  ): Promise<{ files: LocalSkillInstalledFile[]; notes: string[]; componentSha256?: string }> {
    const root = resolved.root as string;
    const folder = resolved.folder as string;
    const next = new Set(held.files.map(file => file.path));
    const stale = this.#staleFiles(replaces, `${folder}/`, next, reading);
    const expected = new Map<string, string | null>();
    for (const path of [...next, ...stale]) expected.set(path, reading.files.get(path) ?? null);
    try {
      await this.deps.skillFiles.apply(root, folder, { write: held.files, remove: stale, expected });
    } catch (error) {
      throw this.#folderRefusal(error);
    }
    return {
      files: await Promise.all(
        held.files.map(async file => ({ path: `${folder}/${file.path}`, sha256: await this.#hash(file.content) })),
      ),
      notes: [],
    };
  }

  /** Files a replaced copy wrote that the new one no longer has, and that are still on disk as read. */
  #staleFiles(
    replaces: LocalSkillInstallRecord | undefined,
    prefix: string,
    next: ReadonlySet<string>,
    reading: SkillFolderReading,
  ): string[] {
    return [...this.#recorded(replaces, prefix).keys()].filter(path => !next.has(path) && reading.files.has(path));
  }

  async #removeProject(record: LocalSkillInstallRecord): Promise<void> {
    const root = record.root as string;
    const folder = record.folder as string;
    const reading = await this.#inspectProject(root, folder);
    const { remove, expected } = this.#removal(record, reading, `${folder}/`, `${folder}/`);
    try {
      await this.deps.skillFiles.apply(root, folder, { write: [], remove, expected });
    } catch (error) {
      throw this.#folderRefusal(error);
    }
  }

  async #inspectProject(root: string, folder: string): Promise<SkillFolderReading> {
    try {
      return await this.deps.skillFiles.inspect(withoutTrailingSlash(root), folder);
    } catch (error) {
      throw this.#folderRefusal(error);
    }
  }

  /** The folder files of `record` still on disk, each unchanged (else a conflict), as a delete list with its guards. */
  #removal(record: LocalSkillInstallRecord, reading: SkillFolderReading, prefix: string, where: string) {
    const remove: string[] = [];
    const expected = new Map<string, string | null>();
    for (const [relative, sha256] of this.#recorded(record, prefix)) {
      const now = reading.files.get(relative);
      if (now === undefined) continue;
      if (now !== sha256)
        refuse(
          'local_skill_conflict',
          `${where}${relative} was edited on this machine since it was copied, so nothing was removed.`,
        );
      remove.push(relative);
      expected.set(relative, now);
    }
    for (const path of reading.files.keys())
      if (!remove.includes(path))
        refuse(
          'local_skill_conflict',
          `${where}${path} is here but no copy of ours wrote it, so the folder was left alone.`,
        );
    return { remove, expected };
  }

  #folderRefusal(error: unknown): unknown {
    if (error instanceof SkillFolderRefused || error instanceof SkillFolderChanged)
      return new LocalSkillRefusalError('local_skill_conflict', error.message);
    return error;
  }

  // ── Runtime writes ──────────────────────────────────────────────────────────────────────────────

  async #writeRuntime(
    held: HeldLocalSkill,
    target: Extract<CatalogInstallTarget, { scope: 'runtime' }>,
    replaces: LocalSkillInstallRecord | undefined,
    reading: SkillFolderReading,
    governance: CallerGovernance | undefined,
  ): Promise<{ files: LocalSkillInstalledFile[]; notes: string[]; componentSha256: string }> {
    const component: FleetComponentInput = { kind: 'skills', items: [held.name] };
    // Everything the record needs that does not depend on the write is made BEFORE it, so once the
    // component is written nothing below can throw and leave it without a record of ours.
    const recorded = await Promise.all(
      held.files.map(async file => ({
        path: `skills/${held.name}/${file.path}`,
        sha256: await this.#hash(file.content),
      })),
    );
    const { component: stored } = await this.deps.fleet.installCatalogItem(
      {
        kind: 'catalog.install',
        name: held.name,
        component,
        files: held.files.map(file => ({ path: file.path, content: file.content })),
        profile: target.profile,
        installedFrom: held.provenance,
        replace: replaces !== undefined,
      },
      governance,
    );
    const notes = [`It is a layer of profile ${target.profile}, so ${target.runtime} gets it the next time it starts.`];
    const stale = this.#staleFiles(
      replaces,
      `skills/${held.name}/`,
      new Set(held.files.map(file => file.path)),
      reading,
    );
    if (stale.length > 0)
      try {
        await this.deps.runtimeSkills.remove(
          held.name,
          new Map(stale.map(path => [path, reading.files.get(path) as string])),
        );
      } catch {
        // The new copy is already written, so refusing now would leave it without a record.
        notes.unshift(
          `${stale.length === 1 ? 'A file' : 'Files'} from the earlier copy could not be removed from skills/${held.name}/ and ${stale.length === 1 ? 'is' : 'are'} still there: ${stale.join(', ')}.`,
        );
      }
    return { componentSha256: await this.#hash(canonical(stored)), files: recorded, notes };
  }

  async #removeRuntime(
    record: LocalSkillInstallRecord,
    governance: CallerGovernance | undefined,
    freshStepUp: FreshStepUpContext,
  ): Promise<void> {
    const { name } = record;
    const component = await this.deps.fleet.storedComponent('skills', name);
    if (component !== undefined && (await this.#hash(canonical(component))) !== record.componentSha256)
      refuse('local_skill_conflict', `${name} was edited on this machine since it was copied, so it was not removed.`);
    const removal = this.#removal(record, await this.deps.runtimeSkills.inspect(name), `skills/${name}/`, `${name}/`);
    if (component !== undefined) {
      const change = await this.deps.fleet.propose({
        kind: 'component.remove',
        componentKind: 'skills',
        name,
        removeFromProfiles: true,
      });
      await this.deps.fleet.apply(change.id, governance, freshStepUp);
    }
    if (removal.remove.length > 0) await this.deps.runtimeSkills.remove(name, removal.expected);
  }

  // ── Small things ────────────────────────────────────────────────────────────────────────────────

  async #bytes(text: string): Promise<Uint8Array> {
    return await this.deps.crypto.sha256(new TextEncoder().encode(text));
  }

  async #hash(text: string): Promise<string> {
    return hexOf(await this.#bytes(text));
  }

  async #inTurn<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#turn.then(work, work);
    this.#turn = run.catch(() => undefined);
    return await run;
  }
}

function installOf(record: LocalSkillInstallRecord): LocalSkillInstall {
  return {
    installId: record.installId,
    installedAt: record.installedAt,
    name: record.name,
    origin: record.origin,
    target: record.target,
    destination: record.destination,
    files: record.files.map(file => ({ path: file.path, sha256: file.sha256 })),
  };
}

/** The same bytes as a catalog skill item, so the review and the warnings are the catalog installer's own, unchanged. */
function itemOf(
  name: string,
  files: readonly { readonly path: string; readonly content: string }[],
  provenance: CatalogProvenance,
): SharedCatalogItem {
  return {
    format: SHARED_CATALOG_ITEM_FORMAT,
    version: 1,
    publisher: provenance.publisher,
    catalogId: provenance.catalogId,
    itemId: provenance.itemId,
    itemVersion: provenance.version,
    name,
    summary: 'A skill copied from this machine',
    kind: 'skill',
    skill: { files: [...files] },
  };
}
