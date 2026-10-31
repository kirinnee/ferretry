/**
 * Installing one catalog item on THIS machine (docs/catalogs.md § The installer). The installer is daemon B:
 * it never talks to the publisher and never takes a caller's word for what the publisher said. It checks
 * the signature and the digest itself, in the contract's order, and refuses with the contract's code.
 *
 * TWO STEPS. {@link CatalogInstallService.preview} verifies and answers the full review; it WRITES NOTHING
 * and changes no state, so a ferret may call it. {@link CatalogInstallService.apply} installs exactly the
 * item that was reviewed, with the installer's explicit choice of which of THEIR OWN secrets fills each
 * placeholder, and records what it wrote with the SHA-256 of each file.
 *
 * ONLY THROUGH THE EXISTING WRITE PATHS. A project `.mcp.json` goes through the session-MCP file port
 * (compare-and-swap, no link followed). A project skill goes through a folder port with the same rules. A
 * runtime install is ONE fleet change (`catalog.install`) that the fleet service stages and applies like
 * every other change, so the component, the skill's files and the profile layer succeed or roll back
 * together. Nothing here opens a path of its own.
 *
 * WHAT B WROTE IS WHAT B MAY CHANGE. Something at the destination that no install record of ours put there
 * is a conflict, and so is a file we wrote that has been changed since: replacing or removing never
 * overwrites a local edit ("keep my edits" is a later phase).
 */
import { posix } from 'node:path';
import {
  CATALOG_INSTALL_PREVIEW_TTL_SECONDS,
  type CatalogInstall,
  type CatalogInstalled,
  type CatalogInstallList,
  type CatalogInstallPreview,
  type CatalogInstallPreviewRequest,
  type CatalogInstallRemoved,
  type CatalogInstallRequest,
  type CatalogInstallScope,
  type CatalogInstallTarget,
  type CatalogInstallWarning,
  type CatalogProvenance,
  type CatalogSecretBindings,
  catalogItemReview,
  catalogItemWarnings,
  catalogSecretPlaceholders,
  type FleetComponentInput,
  mcpServerRefusal,
  type SessionMcpServer,
  type SharedCatalogItem,
} from '@ferretry/protocol';
import { verifyCatalogItem, verifySignedCatalogManifest, type RelayCrypto } from '@ferretry/relay';
import type { CallerGovernance } from '../api/capability.ts';
import type { FleetCatalogService, FreshStepUpContext } from '../fleet/catalog-service.ts';
import { type McpProjectFiles, McpProjectFileChanged, projectRootFor } from '../session-mcp/service.ts';
import {
  McpProjectFileError,
  parseMcpProjectFile,
  projectEntry,
  renderMcpProjectFile,
} from '../session-mcp/project-file.ts';
import { CatalogPreviews, type HeldPreview } from './previews.ts';
import {
  CatalogInstallRefusalError,
  type ProjectSkillFiles,
  type RuntimeSkillAssets,
  SkillFolderChanged,
  SkillFolderRefused,
  type SkillFolderReading,
} from './ports.ts';
import {
  type CatalogInstalledFile,
  type CatalogInstallRecord,
  type CatalogInstallState,
  type CatalogInstallStore,
} from './store.ts';

export interface CatalogInstallServiceDeps {
  readonly crypto: RelayCrypto;
  readonly store: CatalogInstallStore;
  /** Every folder a project write may land in: registered projects and live managed worktrees. */
  projectRoots(): Promise<readonly string[]>;
  readonly mcpFiles: McpProjectFiles;
  readonly skillFiles: ProjectSkillFiles;
  readonly runtimeSkills: RuntimeSkillAssets;
  readonly fleet: Pick<FleetCatalogService, 'runtimes' | 'profiles' | 'components' | 'propose' | 'apply'>;
  /** The NAMES of the secrets this machine holds. Never a value. */
  secretNames(): Promise<ReadonlySet<string>>;
  now(): number;
  /** A fresh id: `cip_…` for a preview, `cin_…` for an install. */
  mint(prefix: 'cip' | 'cin'): string;
}

const SECRET_PLACEHOLDER = /^\$\{secret:([A-Za-z0-9_.-]+)\}$/u;
const ENV_VARIABLE = /^[A-Z_][A-Z0-9_]*$/u;
const PROJECT_MCP_FILE = '.mcp.json';

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

const refuse = (code: CatalogInstallRefusalError['code'], message: string): never => {
  throw new CatalogInstallRefusalError(code, message);
};

const sameTarget = (left: CatalogInstallTarget, right: CatalogInstallTarget): boolean =>
  left.scope === 'project'
    ? right.scope === 'project' && left.projectRoot === right.projectRoot && left.harness === right.harness
    : right.scope === 'runtime' && left.runtime === right.runtime && left.profile === right.profile;

const withoutTrailingSlash = (path: string): string => posix.normalize(path).replace(/(?<=.)\/+$/u, '');

/** Where an item lands: a stable key (two installs sharing it would overwrite each other) and the words for it. */
interface Destination {
  readonly key: string;
  readonly words: string;
  /** A project skill's folder, relative to the root; the runtime skill store is addressed by name. */
  readonly folder?: string;
}

interface ResolvedTarget {
  readonly destination: Destination;
}

interface Judged {
  readonly replaces: CatalogInstallRecord | undefined;
  readonly warnings: readonly CatalogInstallWarning[];
  readonly firstSeen: boolean;
}

export class CatalogInstallService {
  readonly #previews: CatalogPreviews;
  /** Applies and removes take turns: each reads the state, writes files, and writes the state back. */
  #turn: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: CatalogInstallServiceDeps,
    previews: CatalogPreviews = new CatalogPreviews(CATALOG_INSTALL_PREVIEW_TTL_SECONDS * 1000),
  ) {
    this.#previews = previews;
  }

  /** `GET /v1/catalog-installs`. */
  async list(): Promise<CatalogInstallList> {
    const state = await this.deps.store.read();
    return {
      installs: state.installs.map(
        (record): CatalogInstall => ({
          installId: record.installId,
          installedAt: record.installedAt,
          provenance: record.provenance,
          target: record.target,
          destination: record.destination,
          secretBindings: record.secretBindings,
        }),
      ),
    };
  }

  /** Verify in the contract's order and answer the review. Writes nothing, changes no state. */
  async preview(scope: CatalogInstallScope, request: CatalogInstallPreviewRequest): Promise<CatalogInstallPreview> {
    const { item, target } = request;
    if (target.scope !== scope)
      refuse('catalog_target_unknown', `this asks for a ${scope} install but names a ${target.scope} target`);
    // 1. The signature: the manifest was signed by the machine it names.
    const manifest = await verifySignedCatalogManifest(this.deps.crypto, request.signedManifest);
    if (!manifest.ok) return refuse('catalog_signature_invalid', manifest.reason);
    // 2. The item is exactly the version, kind, name and bytes the manifest lists.
    const line = await verifyCatalogItem(this.deps.crypto, manifest.value, item);
    if (!line.ok) return refuse('catalog_item_mismatch', line.reason);
    const provenance: CatalogProvenance = {
      publisher: manifest.value.publisher,
      publisherName: manifest.value.publisherName,
      catalogId: manifest.value.catalogId,
      catalogName: manifest.value.name,
      itemId: item.itemId,
      kind: item.kind,
      name: item.name,
      version: item.itemVersion,
      digest: line.value.digest,
    };
    const state = await this.deps.store.read();
    const allowOlder = request.allowOlder === true;
    // 3–5. The publisher pin, the revision, the version.
    const judged = this.#judge(state, provenance, manifest.value.revision, target, allowOlder);
    // 6. The bundle's own rules for this kind and this target.
    await this.#bundleRules(item, target);
    // 7. The target is one this machine knows.
    const resolved = await this.#resolveTarget(item, target);
    // 8. Nothing sits at the destination that we did not put there, and what we did put there is untouched.
    const replaces = await this.#destinationState(item, target, resolved, state, judged.replaces);
    const placeholders = catalogSecretPlaceholders(item);
    const held = await this.deps.secretNames();
    const now = this.deps.now();
    const previewId = this.deps.mint('cip') as HeldPreview['previewId'];
    const expiresAt = now + CATALOG_INSTALL_PREVIEW_TTL_SECONDS * 1000;
    this.#previews.put(
      {
        previewId,
        createdAt: now,
        expiresAt,
        item,
        provenance,
        revision: manifest.value.revision,
        target,
        allowOlder,
        placeholders,
      },
      now,
    );
    return {
      previewId,
      expiresAt: new Date(expiresAt).toISOString(),
      provenance,
      publisher: { daemonId: provenance.publisher, name: provenance.publisherName, firstSeen: judged.firstSeen },
      target,
      destination: resolved.destination.words,
      review: [...catalogItemReview(item)],
      secrets: placeholders.map(placeholder => ({ placeholder, held: held.has(placeholder) })),
      warnings: [...judged.warnings, ...catalogItemWarnings(item)],
      ...(replaces === undefined
        ? {}
        : { replaces: { installId: replaces.installId, version: replaces.provenance.version } }),
    };
  }

  /** Install exactly the reviewed item. The caller has already proved the passkey step-up where one is due. */
  async apply(
    scope: CatalogInstallScope,
    request: CatalogInstallRequest,
    governance: CallerGovernance | undefined,
    freshStepUp: FreshStepUpContext,
  ): Promise<CatalogInstalled> {
    return await this.#inTurn(async () => {
      const lookup = this.#previews.get(request.previewId, this.deps.now());
      if (lookup.kind === 'unknown')
        return refuse(
          'catalog_preview_unknown',
          'There is no such preview, or it was already used. Preview the item again.',
        );
      if (lookup.kind === 'expired')
        return refuse(
          'catalog_preview_expired',
          'That preview ran out of time. Preview the item again and look it over.',
        );
      const held = lookup.preview;
      if (held.target.scope !== scope)
        return refuse(
          'catalog_preview_unknown',
          `That preview is for a ${held.target.scope} install, not a ${scope} one.`,
        );
      const names = await this.deps.secretNames();
      this.#bindingsAreValid(held, request.secretBindings, names);
      // The machine may have moved on since the review: judge again against what is true now.
      const state = await this.deps.store.read();
      const judged = this.#judge(state, held.provenance, held.revision, held.target, held.allowOlder);
      const resolved = await this.#resolveTarget(held.item, held.target);
      const replaces = await this.#destinationState(held.item, held.target, resolved, state, judged.replaces);
      const written =
        held.target.scope === 'project'
          ? await this.#writeProject(held, held.target, resolved, request.secretBindings)
          : await this.#writeRuntime(held, held.target, request.secretBindings, replaces, governance, freshStepUp);
      const installedAt = new Date(this.deps.now()).toISOString();
      const record: CatalogInstallRecord = {
        installId: this.deps.mint('cin') as CatalogInstallRecord['installId'],
        installedAt,
        provenance: held.provenance,
        target: held.target,
        destination: resolved.destination.words,
        key: resolved.destination.key,
        files: written.files,
        secretBindings: request.secretBindings,
      };
      await this.deps.store.write({
        schemaVersion: state.schemaVersion,
        installs: [...state.installs.filter(install => install.installId !== replaces?.installId), record],
        publishers: {
          ...state.publishers,
          [held.provenance.publisher]: state.publishers[held.provenance.publisher] ?? installedAt,
        },
        pins: {
          ...state.pins,
          [held.provenance.catalogId]: state.pins[held.provenance.catalogId] ?? held.provenance.publisher,
        },
        revisions: {
          ...state.revisions,
          [held.provenance.catalogId]: Math.max(state.revisions[held.provenance.catalogId] ?? 0, held.revision),
        },
      });
      this.#previews.consume(held.previewId);
      return {
        install: {
          installId: record.installId,
          installedAt,
          provenance: record.provenance,
          target: record.target,
          destination: record.destination,
          secretBindings: record.secretBindings,
        },
        notes: written.notes,
      };
    });
  }

  /** Remove exactly what an install wrote, refusing if any of it was edited here since. Never asks for a passkey. */
  async remove(
    scope: CatalogInstallScope,
    installId: string,
    governance: CallerGovernance | undefined,
    freshStepUp: FreshStepUpContext,
  ): Promise<CatalogInstallRemoved> {
    return await this.#inTurn(async () => {
      const state = await this.deps.store.read();
      const record = state.installs.find(install => install.installId === installId && install.target.scope === scope);
      if (record === undefined)
        return refuse('catalog_install_unknown', `There is no ${scope} install ${installId} on this machine.`);
      if (record.target.scope === 'project') await this.#removeProject(record, record.target);
      else await this.#removeRuntime(record, governance, freshStepUp);
      await this.deps.store.write({ ...state, installs: state.installs.filter(install => install !== record) });
      return { installId: record.installId, provenance: record.provenance, destination: record.destination };
    });
  }

  // ── The contract's checks ───────────────────────────────────────────────────────────────────────

  /** Steps 3, 4 and 5: the publisher pin, the revision, the version. */
  #judge(
    state: CatalogInstallState,
    provenance: CatalogProvenance,
    revision: number,
    target: CatalogInstallTarget,
    allowOlder: boolean,
  ): Judged {
    const pinned =
      state.pins[provenance.catalogId] ??
      state.installs.find(install => install.provenance.catalogId === provenance.catalogId)?.provenance.publisher;
    if (pinned !== undefined && pinned !== provenance.publisher)
      refuse(
        'catalog_publisher_changed',
        `${provenance.catalogName} was installed from a different machine than the one that signed this file. A catalog stays with the machine it first came from, so nothing was installed.`,
      );
    const seen = state.revisions[provenance.catalogId];
    if (seen !== undefined && revision < seen)
      refuse(
        'catalog_revision_older',
        `This is revision ${revision} of ${provenance.catalogName}, and this machine has already installed from revision ${seen}. An older copy of a catalog is not accepted.`,
      );
    // Matched on publisher + catalog + item at the same target, never on the name.
    const replaces = state.installs.find(
      install =>
        install.provenance.publisher === provenance.publisher &&
        install.provenance.catalogId === provenance.catalogId &&
        install.provenance.itemId === provenance.itemId &&
        sameTarget(install.target, target),
    );
    const warnings: CatalogInstallWarning[] = [];
    if (replaces !== undefined && provenance.version < replaces.provenance.version) {
      if (!allowOlder)
        refuse(
          'catalog_downgrade',
          `${provenance.name} version ${replaces.provenance.version} is installed here, and this file has version ${provenance.version}. Installing an older version has to be chosen.`,
        );
      warnings.push({
        code: 'older-version',
        text: `This is version ${provenance.version}; version ${replaces.provenance.version} is installed here now.`,
      });
    }
    const firstSeen = state.publishers[provenance.publisher] === undefined;
    if (firstSeen)
      warnings.push({
        code: 'first-publisher',
        text: `This is the first thing installed from ${provenance.publisherName}. From now on ${provenance.catalogName} can only come from this same machine.`,
      });
    return { replaces, warnings, firstSeen };
  }

  /** Step 6: an artifact is opened, not installed; a server needs somewhere it can run; a harness-specific item needs its harness. */
  async #bundleRules(item: SharedCatalogItem, target: CatalogInstallTarget): Promise<void> {
    if (item.kind === 'artifact')
      refuse(
        'catalog_not_installable',
        `${item.name} is an artifact. An artifact is opened from the catalog, not installed.`,
      );
    if (item.kind === 'mcp' && target.scope === 'project') {
      if (target.harness === 'codex')
        refuse(
          'catalog_not_installable',
          'Codex does not read .mcp.json, so a project server would never reach it. Install it into a runtime instead.',
        );
      const probe: SessionMcpServer =
        item.mcp.transport === 'url'
          ? { transport: 'url', url: item.mcp.url, oauth: item.mcp.auth === 'oauth' }
          : { transport: 'command', command: item.mcp.command, args: [...item.mcp.args], env: {} };
      const refusal = mcpServerRefusal('project', probe);
      if (refusal !== null) refuse('catalog_not_installable', refusal);
    }
    if (
      item.kind === 'mcp' &&
      target.scope === 'runtime' &&
      item.mcp.transport === 'url' &&
      item.mcp.oauth !== undefined
    )
      refuse(
        'catalog_not_installable',
        `${item.name} needs an OAuth client registered by hand, and an install from a catalog cannot set one yet.`,
      );
    if (
      target.scope === 'project' &&
      item.harness !== undefined &&
      item.harness !== 'generic' &&
      item.harness !== target.harness
    )
      refuse(
        'catalog_not_installable',
        `${item.name} is written for ${item.harness === 'claude' ? 'Claude Code' : 'Codex'}, not for ${target.harness}.`,
      );
  }

  /** Step 7: a project is one this machine registered or made; a runtime and profile already exist. */
  async #resolveTarget(item: SharedCatalogItem, target: CatalogInstallTarget): Promise<ResolvedTarget> {
    if (target.scope === 'project') {
      const wanted = withoutTrailingSlash(target.projectRoot);
      const roots = (await this.deps.projectRoots()).map(withoutTrailingSlash);
      if (projectRootFor(wanted, roots) !== wanted || !roots.includes(wanted))
        return refuse(
          'catalog_target_unknown',
          `${target.projectRoot} is not a project this machine knows. Register the project, or name the folder of one it has.`,
        );
      if (item.kind === 'mcp')
        return {
          destination: {
            key: `project:${wanted}/${PROJECT_MCP_FILE}#${item.name}`,
            words: `the server ${item.name} in ${wanted}/${PROJECT_MCP_FILE}`,
          },
        };
      const folder = `${target.harness === 'claude' ? '.claude' : '.agents'}/skills/${item.name}`;
      const count = item.kind === 'skill' ? item.skill.files.length : 0;
      return {
        destination: {
          key: `project:${wanted}/${folder}`,
          words: `${wanted}/${folder}/ (${count} file${count === 1 ? '' : 's'})`,
          folder,
        },
      };
    }
    const runtime = (await this.deps.fleet.runtimes()).runtimes.find(
      candidate => candidate.name === target.runtime || candidate.id === target.runtime,
    );
    if (runtime === undefined)
      return refuse('catalog_target_unknown', `${target.runtime} is not a runtime on this machine.`);
    const profile = (await this.deps.fleet.profiles()).profiles.find(candidate => candidate.name === target.profile);
    if (profile === undefined)
      return refuse('catalog_target_unknown', `${target.profile} is not a profile on this machine.`);
    if (runtime.profile !== profile.name)
      return refuse(
        'catalog_target_unknown',
        `${runtime.name} launches with the profile ${runtime.profile}, not ${profile.name}, so installing there would not reach it.`,
      );
    if (item.harness !== undefined && item.harness !== 'generic' && item.harness !== runtime.harness)
      return refuse(
        'catalog_not_installable',
        `${item.name} is written for ${item.harness === 'claude' ? 'Claude Code' : 'Codex'}, and ${runtime.name} runs ${runtime.harness}.`,
      );
    const word = item.kind === 'mcp' ? 'the MCP server' : 'the skill';
    return {
      destination: {
        key: `fleet:${item.kind === 'mcp' ? 'mcp' : 'skills'}/${item.name}`,
        words: `${word} ${item.name} in runtime ${runtime.name}, profile ${profile.name}`,
      },
    };
  }

  /**
   * Step 8, and again at apply: what is at the destination right now. Answers the install this would
   * replace, or refuses when something we did not write is there or what we wrote was changed.
   */
  async #destinationState(
    item: SharedCatalogItem,
    target: CatalogInstallTarget,
    resolved: ResolvedTarget,
    state: CatalogInstallState,
    replaces: CatalogInstallRecord | undefined,
  ): Promise<CatalogInstallRecord | undefined> {
    const holder = state.installs.find(install => install.key === resolved.destination.key);
    if (holder !== undefined && holder !== replaces)
      refuse(
        'catalog_install_conflict',
        `${resolved.destination.words} already holds ${holder.provenance.name} from ${holder.provenance.publisherName}'s ${holder.provenance.catalogName}. Remove that first (install ${holder.installId}).`,
      );
    if (target.scope === 'project') {
      if (item.kind === 'mcp') await this.#checkProjectMcp(target.projectRoot, item.name, replaces);
      else await this.#checkProjectSkill(target.projectRoot, resolved.destination.folder as string, replaces);
    } else await this.#checkRuntime(item, replaces);
    return replaces;
  }

  async #checkProjectMcp(root: string, name: string, replaces: CatalogInstallRecord | undefined): Promise<void> {
    const { document } = await this.#readProjectMcp(root);
    const servers = document.mcpServers as Record<string, unknown> | undefined;
    const present = servers !== undefined && Object.hasOwn(servers, name);
    if (!present) return;
    const recorded = replaces?.files[0]?.sha256;
    if (recorded === undefined)
      refuse(
        'catalog_install_conflict',
        `${PROJECT_MCP_FILE} already has a server called ${name} that no install of ours put there.`,
      );
    if ((await this.#hash(JSON.stringify(servers[name]))) !== recorded)
      refuse(
        'catalog_install_conflict',
        `The server ${name} in ${PROJECT_MCP_FILE} was edited on this machine since it was installed, so it was not replaced.`,
      );
  }

  async #checkProjectSkill(root: string, folder: string, replaces: CatalogInstallRecord | undefined): Promise<void> {
    const reading = await this.#inspectProjectSkill(root, folder);
    this.#checkFolder(reading, replaces, `${folder}/`);
  }

  async #checkRuntime(item: SharedCatalogItem, replaces: CatalogInstallRecord | undefined): Promise<void> {
    const kind = item.kind === 'mcp' ? 'mcp' : 'skills';
    const group = (await this.deps.fleet.components()).kinds.find(candidate => candidate.kind === kind);
    const component = group?.components.find(candidate => candidate.name === item.name);
    if (component !== undefined) {
      if (replaces === undefined)
        refuse(
          'catalog_install_conflict',
          `${item.name} is already a ${kind === 'mcp' ? 'server' : 'skill'} on this machine, and no install of ours put it there.`,
        );
      if (component.installedFrom?.digest !== replaces?.provenance.digest)
        refuse(
          'catalog_install_conflict',
          `${item.name} was edited on this machine since it was installed, so it was not replaced.`,
        );
    }
    if (item.kind === 'skill')
      this.#checkFolder(await this.deps.runtimeSkills.inspect(item.name), replaces, `${item.name}/`);
  }

  /** A folder holds only files an earlier install of ours wrote, each unchanged (a missing one is not an edit). */
  #checkFolder(reading: SkillFolderReading, replaces: CatalogInstallRecord | undefined, where: string): void {
    if (!reading.exists || reading.files.size === 0) return;
    if (replaces === undefined)
      refuse('catalog_install_conflict', `${where} already holds files that no install of ours put there.`);
    const recorded = new Map(replaces?.files.map(file => [file.path, file.sha256]));
    for (const [path, hash] of reading.files) {
      const expected = [...recorded].find(([name]) => name.endsWith(`/${path}`))?.[1];
      if (expected === undefined)
        refuse('catalog_install_conflict', `${where}${path} is here but no install of ours wrote it.`);
      if (expected !== hash)
        refuse('catalog_install_conflict', `${where}${path} was edited on this machine since it was installed.`);
    }
  }

  #bindingsAreValid(held: HeldPreview, bindings: CatalogSecretBindings, own: ReadonlySet<string>): void {
    const given = Object.keys(bindings);
    const missing = held.placeholders.filter(name => !given.includes(name));
    if (missing.length > 0)
      refuse(
        'catalog_bindings_invalid',
        `Say what to do with ${missing.join(', ')}: bind each one to a secret of yours, or leave it unbound.`,
      );
    const extra = given.filter(name => !held.placeholders.includes(name));
    if (extra.length > 0)
      refuse(
        'catalog_bindings_invalid',
        `${extra.join(', ')} ${extra.length === 1 ? 'is' : 'are'} not something this item asks for.`,
      );
    for (const [placeholder, secret] of Object.entries(bindings)) {
      if (secret === null) {
        if (own.has(placeholder))
          refuse(
            'catalog_bindings_invalid',
            `You hold a secret called ${placeholder}, and leaving ${placeholder} unbound would still use it. Bind it on purpose (${placeholder} to ${placeholder}), or choose another of yours.`,
          );
        continue;
      }
      if (!own.has(secret))
        refuse('catalog_bindings_invalid', `You have no secret called ${secret}, so ${placeholder} cannot use it.`);
    }
    if (held.target.scope !== 'project') return;
    for (const [placeholder, secret] of Object.entries(bindings)) {
      const variable = secret ?? placeholder;
      if (!ENV_VARIABLE.test(variable))
        refuse(
          'catalog_bindings_invalid',
          `A project's ${PROJECT_MCP_FILE} can only read an environment variable, and ${variable} is not a name one can have (upper-case letters, digits and _). Install it into a runtime, or pick a secret with such a name.`,
        );
    }
  }

  // ── Project writes ──────────────────────────────────────────────────────────────────────────────

  async #writeProject(
    held: HeldPreview,
    target: Extract<CatalogInstallTarget, { scope: 'project' }>,
    resolved: ResolvedTarget,
    bindings: CatalogSecretBindings,
  ): Promise<{ files: CatalogInstalledFile[]; notes: string[] }> {
    const { item } = held;
    if (item.kind === 'mcp') return await this.#writeProjectMcp(item, target, bindings);
    if (item.kind !== 'skill') return refuse('catalog_not_installable', `${item.name} cannot be installed.`);
    const folder = resolved.destination.folder as string;
    const reading = await this.#inspectProjectSkill(target.projectRoot, folder);
    const next = new Set(item.skill.files.map(file => file.path));
    const stale = [...reading.files.keys()].filter(path => !next.has(path));
    const expected = new Map<string, string | null>();
    for (const path of [...next, ...stale]) expected.set(path, reading.files.get(path) ?? null);
    try {
      await this.deps.skillFiles.apply(target.projectRoot, folder, {
        write: item.skill.files,
        remove: stale,
        expected,
      });
    } catch (error) {
      throw this.#folderRefusal(error);
    }
    return {
      files: await Promise.all(
        item.skill.files.map(async file => ({
          path: `${folder}/${file.path}`,
          sha256: await this.#hash(file.content),
        })),
      ),
      notes: [],
    };
  }

  async #writeProjectMcp(
    item: Extract<SharedCatalogItem, { kind: 'mcp' }>,
    target: Extract<CatalogInstallTarget, { scope: 'project' }>,
    bindings: CatalogSecretBindings,
  ): Promise<{ files: CatalogInstalledFile[]; notes: string[] }> {
    const notes: string[] = [];
    const server = this.#server(item, value => {
      const placeholder = SECRET_PLACEHOLDER.exec(value)?.[1];
      if (placeholder === undefined) return value;
      const variable = bindings[placeholder] ?? placeholder;
      notes.push(
        `${item.name} reads \${${variable}} from its environment. A project's ${PROJECT_MCP_FILE} cannot use Ferretry's secrets, so give the ferret a variable called ${variable}.`,
      );
      return `\${${variable}}`;
    });
    const refusal = mcpServerRefusal('project', server);
    if (refusal !== null) refuse('catalog_not_installable', refusal);
    const { path, reading, document } = await this.#readProjectMcp(target.projectRoot);
    const entry = projectEntry(server);
    const servers = (document.mcpServers ?? {}) as Record<string, unknown>;
    const text = renderMcpProjectFile({ ...document, mcpServers: { ...servers, [item.name]: entry } });
    try {
      await this.deps.mcpFiles.replace(path, text, reading.etag);
    } catch (error) {
      if (error instanceof McpProjectFileChanged) refuse('catalog_install_conflict', error.message);
      throw error;
    }
    return {
      files: [{ path: PROJECT_MCP_FILE, sha256: await this.#hash(JSON.stringify(entry)), entry: item.name }],
      notes: [...new Set(notes)],
    };
  }

  async #removeProject(
    record: CatalogInstallRecord,
    target: Extract<CatalogInstallTarget, { scope: 'project' }>,
  ): Promise<void> {
    const first = record.files[0];
    if (first?.entry !== undefined) {
      const { path, reading, document } = await this.#readProjectMcp(target.projectRoot);
      const servers = (document.mcpServers ?? {}) as Record<string, unknown>;
      if (!Object.hasOwn(servers, first.entry)) return;
      if ((await this.#hash(JSON.stringify(servers[first.entry]))) !== first.sha256)
        refuse(
          'catalog_install_conflict',
          `The server ${first.entry} in ${PROJECT_MCP_FILE} was edited on this machine since it was installed, so it was not removed.`,
        );
      const { [first.entry]: _removed, ...rest } = servers;
      try {
        await this.deps.mcpFiles.replace(path, renderMcpProjectFile({ ...document, mcpServers: rest }), reading.etag);
      } catch (error) {
        if (error instanceof McpProjectFileChanged) refuse('catalog_install_conflict', error.message);
        throw error;
      }
      return;
    }
    const folder = record.destination.slice(target.projectRoot.length + 1).split('/ (')[0] as string;
    const reading = await this.#inspectProjectSkill(target.projectRoot, folder);
    const { remove, expected } = this.#removal(record, reading, `${folder}/`);
    try {
      await this.deps.skillFiles.apply(target.projectRoot, folder, { write: [], remove, expected });
    } catch (error) {
      throw this.#folderRefusal(error);
    }
  }

  async #readProjectMcp(root: string) {
    const path = posix.join(withoutTrailingSlash(root), PROJECT_MCP_FILE);
    try {
      const reading = await this.deps.mcpFiles.read(path);
      return { path, reading, document: parseMcpProjectFile(reading.text) };
    } catch (error) {
      if (error instanceof McpProjectFileError) return refuse('catalog_install_conflict', error.message);
      throw error;
    }
  }

  async #inspectProjectSkill(root: string, folder: string): Promise<SkillFolderReading> {
    try {
      return await this.deps.skillFiles.inspect(withoutTrailingSlash(root), folder);
    } catch (error) {
      throw this.#folderRefusal(error);
    }
  }

  /** The folder files of `record` still on disk, each unchanged (else a conflict), as a delete list with its guards. */
  #removal(record: CatalogInstallRecord, reading: SkillFolderReading, where: string) {
    const remove: string[] = [];
    const expected = new Map<string, string | null>();
    for (const file of record.files) {
      const relative = file.path.slice(file.path.indexOf('/', file.path.indexOf('skills/') + 7) + 1);
      const now = reading.files.get(relative);
      if (now === undefined) continue;
      if (now !== file.sha256)
        refuse(
          'catalog_install_conflict',
          `${where}${relative} was edited on this machine since it was installed, so nothing was removed.`,
        );
      remove.push(relative);
      expected.set(relative, now);
    }
    for (const path of reading.files.keys())
      if (!remove.includes(path))
        refuse(
          'catalog_install_conflict',
          `${where}${path} is here but no install of ours wrote it, so the folder was left alone.`,
        );
    return { remove, expected };
  }

  #folderRefusal(error: unknown): unknown {
    if (error instanceof SkillFolderRefused || error instanceof SkillFolderChanged)
      return new CatalogInstallRefusalError('catalog_install_conflict', error.message);
    return error;
  }

  // ── Runtime writes ──────────────────────────────────────────────────────────────────────────────

  async #writeRuntime(
    held: HeldPreview,
    target: Extract<CatalogInstallTarget, { scope: 'runtime' }>,
    bindings: CatalogSecretBindings,
    replaces: CatalogInstallRecord | undefined,
    governance: CallerGovernance | undefined,
    freshStepUp: FreshStepUpContext,
  ): Promise<{ files: CatalogInstalledFile[]; notes: string[] }> {
    const { item } = held;
    let component: FleetComponentInput;
    let files: { path: string; content: string }[] = [];
    if (item.kind === 'artifact') return refuse('catalog_not_installable', `${item.name} cannot be installed.`);
    if (item.kind === 'mcp') {
      const server = this.#server(item, value => {
        const placeholder = SECRET_PLACEHOLDER.exec(value)?.[1];
        return placeholder === undefined ? value : `\${secret:${bindings[placeholder] ?? placeholder}}`;
      });
      const refusal = mcpServerRefusal('login', server);
      if (refusal !== null) refuse('catalog_not_installable', refusal);
      component =
        server.transport === 'url'
          ? { kind: 'mcp', url: server.url, ...(server.oauth ? { auth: 'oauth' as const } : {}) }
          : {
              kind: 'mcp',
              command: server.command,
              args: [...server.args],
              ...(Object.keys(server.env).length === 0 ? {} : { env: { ...server.env } }),
            };
    } else {
      component = { kind: 'skills', items: [item.name] };
      files = item.skill.files.map(file => ({ path: file.path, content: file.content }));
    }
    const change = await this.deps.fleet.propose({
      kind: 'catalog.install',
      name: item.name,
      component,
      files,
      profile: target.profile,
      installedFrom: held.provenance,
      replace: replaces !== undefined,
    });
    await this.deps.fleet.apply(change.id, governance, freshStepUp);
    if (item.kind === 'skill' && replaces !== undefined) {
      const next = new Set(item.skill.files.map(file => file.path));
      const stale = replaces.files
        .map(file => file.path.slice(`skills/${item.name}/`.length))
        .filter(path => !next.has(path));
      if (stale.length > 0) await this.deps.runtimeSkills.remove(item.name, stale);
    }
    return {
      files:
        item.kind === 'skill'
          ? await Promise.all(
              item.skill.files.map(async file => ({
                path: `skills/${item.name}/${file.path}`,
                sha256: await this.#hash(file.content),
              })),
            )
          : [],
      notes: [`It is a layer of profile ${target.profile}, so ${target.runtime} gets it the next time it starts.`],
    };
  }

  async #removeRuntime(
    record: CatalogInstallRecord,
    governance: CallerGovernance | undefined,
    freshStepUp: FreshStepUpContext,
  ): Promise<void> {
    const kind = record.provenance.kind === 'mcp' ? 'mcp' : 'skills';
    const name = record.provenance.name;
    const group = (await this.deps.fleet.components()).kinds.find(candidate => candidate.kind === kind);
    const component = group?.components.find(candidate => candidate.name === name);
    if (component !== undefined && component.installedFrom?.digest !== record.provenance.digest)
      refuse(
        'catalog_install_conflict',
        `${name} was edited on this machine since it was installed, so it was not removed.`,
      );
    let paths: string[] = [];
    if (kind === 'skills') {
      const reading = await this.deps.runtimeSkills.inspect(name);
      paths = this.#removal(record, reading, `${name}/`).remove;
    }
    if (component !== undefined) {
      const change = await this.deps.fleet.propose({
        kind: 'component.remove',
        componentKind: kind,
        name,
        removeFromProfiles: true,
      });
      await this.deps.fleet.apply(change.id, governance, freshStepUp);
    }
    if (paths.length > 0) await this.deps.runtimeSkills.remove(name, paths);
  }

  // ── Small things ────────────────────────────────────────────────────────────────────────────────

  /** The item's server with every environment value passed through `value`. */
  #server(item: Extract<SharedCatalogItem, { kind: 'mcp' }>, value: (text: string) => string): SessionMcpServer {
    const setup = item.mcp;
    if (setup.transport === 'url') return { transport: 'url', url: setup.url, oauth: setup.auth === 'oauth' };
    return {
      transport: 'command',
      command: setup.command,
      args: [...setup.args],
      env: Object.fromEntries(Object.entries(setup.env).map(([name, text]) => [name, value(text)])),
    };
  }

  async #hash(text: string): Promise<string> {
    return hexOf(await this.deps.crypto.sha256(new TextEncoder().encode(text)));
  }

  async #inTurn<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#turn.then(work, work);
    this.#turn = run.catch(() => undefined);
    return await run;
  }
}
