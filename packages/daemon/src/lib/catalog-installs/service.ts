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
  type CatalogChanges,
  type CatalogMcpSetup,
  type CatalogInstallPreview,
  type CatalogInstallPreviewRequest,
  type CatalogInstallPrefsRequest,
  type CatalogInstallRemoved,
  type CatalogInstallRequest,
  type CatalogInstallScope,
  type CatalogInstallTarget,
  type CatalogInstallWarning,
  type CatalogProvenance,
  type CatalogSecretBindings,
  catalogItemChanges,
  catalogItemReview,
  catalogItemWarnings,
  catalogSecretPlaceholders,
  newDiffBudget,
  type FleetComponentInput,
  mcpServerRefusal,
  type SessionMcpServer,
  type SharedCatalogItem,
  type SharedCatalogManifest,
} from '@ferretry/protocol';
import {
  verifyCatalogItem,
  verifyCatalogItemAgainstVersions,
  verifySignedCatalogManifest,
  type RelayCrypto,
} from '@ferretry/relay';
import type { CallerGovernance } from '../api/capability.ts';
import { type McpComponentRecord, mcpSetupOf } from '../shared-catalogs/mcp-source.ts';
import type { FleetCatalogService, FreshStepUpContext } from '../fleet/catalog-service.ts';
import { type McpProjectFiles, McpProjectFileChanged, projectRootFor } from '../session-mcp/service.ts';
import {
  McpProjectFileError,
  parseMcpProjectFile,
  projectEntry,
  renderMcpProjectFile,
} from '../session-mcp/project-file.ts';
import { type EditedHashes, editedView, editedWords, hasEdits, NO_EDITS, sameEdits } from './edited.ts';
import {
  mcpAsInstalled,
  setupOfProjectEntry,
  skillAsInstalled,
  withPlaceholders,
  withUnreadableFiles,
} from './on-disk-item.ts';
import { type CatalogInstallPrefsStore, mergedPref, withPref } from './prefs.ts';
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
  /** Stay and skip: what the person chose about future versions. Apart from the store, which stays at version 1. */
  readonly prefs: CatalogInstallPrefsStore;
  /** Every folder a project write may land in: registered projects and live managed worktrees. */
  projectRoots(): Promise<readonly string[]>;
  readonly mcpFiles: McpProjectFiles;
  readonly skillFiles: ProjectSkillFiles;
  readonly runtimeSkills: RuntimeSkillAssets;
  readonly fleet: Pick<
    FleetCatalogService,
    'runtimes' | 'profiles' | 'storedComponent' | 'propose' | 'apply' | 'installCatalogItem'
  >;
  /** The NAMES of the secrets this machine holds. Never a value. */
  secretNames(): Promise<ReadonlySet<string>>;
  now(): number;
  /** A fresh id: `cip_…` for a preview, `cin_…` for an install. */
  mint(prefix: 'cip' | 'cin'): string;
}

const SECRET_PLACEHOLDER = /^\$\{secret:([A-Za-z0-9_.-]+)\}$/u;
const ENV_VARIABLE = /^[A-Z_][A-Z0-9_]*$/u;
const PROJECT_MCP_FILE = '.mcp.json';

/** The caller of a preview or an apply, as the mount identified it. */
export interface CatalogCaller {
  /** Who asked: a preview can only be applied by the same one. */
  readonly id: string;
  /** Whether this caller may list secret names (`secrets.use`); only then does a review say which are held. */
  readonly mayListSecrets: boolean;
}

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
  /** A project target's normalised root. */
  readonly root?: string;
}

/**
 * What is at the destination now: the install this replaces, the folder reading that VERIFIED it, and what of
 * that install's own work was edited here since (see `edited.ts`).
 */
interface DestinationState {
  readonly replaces: CatalogInstallRecord | undefined;
  readonly reading: SkillFolderReading | undefined;
  readonly edited: EditedHashes;
}

/** The item as it is on disk now, for the diff, and the files that could not be read into it. */
interface InstalledItem {
  readonly item: SharedCatalogItem;
  readonly unreadable: readonly string[];
}

/** What a write landed: the files it recorded, what to tell the person, and the runtime component's hash. */
interface Written {
  readonly files: CatalogInstalledFile[];
  readonly notes: string[];
  readonly componentSha256?: string;
}

const UNBOUND_NOTE = (placeholder: string): string =>
  `${placeholder} is not set by this install. The program runs without it unless its own environment already has a variable of that name.`;

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
    const prefs = await this.deps.prefs.read();
    return { installs: state.installs.map(record => this.#view(record, prefs.installs[record.installId])) };
  }

  /** `PATCH /v1/catalog-installs/<scope>/:installId`: stay on this version, or skip one. Writes no file but the choice. */
  async setPrefs(
    scope: CatalogInstallScope,
    installId: string,
    request: CatalogInstallPrefsRequest,
  ): Promise<CatalogInstall> {
    return await this.#inTurn(async () => {
      const state = await this.deps.store.read();
      const record = state.installs.find(install => install.installId === installId && install.target.scope === scope);
      if (record === undefined)
        return refuse('catalog_install_unknown', `There is no ${scope} install ${installId} on this machine.`);
      const prefs = await this.deps.prefs.read();
      const pref = mergedPref(prefs.installs[installId], request);
      await this.deps.prefs.write(withPref(prefs, installId, pref));
      return this.#view(record, pref);
    });
  }

  #view(record: CatalogInstallRecord, pref: { hold?: true; skippedVersion?: number } | undefined): CatalogInstall {
    return {
      installId: record.installId,
      installedAt: record.installedAt,
      provenance: record.provenance,
      target: record.target,
      destination: record.destination,
      secretBindings: record.secretBindings,
      ...(pref?.hold === undefined ? {} : { hold: pref.hold }),
      ...(pref?.skippedVersion === undefined ? {} : { skippedVersion: pref.skippedVersion }),
    };
  }

  /** An install that is gone has no choices left. Best effort: the install itself is already settled. */
  async #dropPrefs(installId: string | undefined): Promise<void> {
    if (installId === undefined) return;
    try {
      const prefs = await this.deps.prefs.read();
      if (Object.hasOwn(prefs.installs, installId)) await this.deps.prefs.write(withPref(prefs, installId, {}));
    } catch {
      // A damaged preferences file is reported where it is read; it must not undo an install or a removal.
    }
  }

  /** Verify in the contract's order and answer the review. Writes nothing, changes no state. */
  async preview(
    scope: CatalogInstallScope,
    request: CatalogInstallPreviewRequest,
    caller: CatalogCaller,
  ): Promise<CatalogInstallPreview> {
    const { item } = request;
    if (request.target.scope !== scope)
      refuse('catalog_target_unknown', `this asks for a ${scope} install but names a ${request.target.scope} target`);
    // 1. The signature: the manifest was signed by the machine it names.
    const manifest = await verifySignedCatalogManifest(this.deps.crypto, request.signedManifest);
    if (!manifest.ok) return refuse('catalog_signature_invalid', manifest.reason);
    // 2. The item is exactly the version, kind, name and bytes the manifest lists, or one the signed list offers.
    const digest = await this.#verifiedDigest(request, manifest.value);
    const provenance: CatalogProvenance = {
      publisher: manifest.value.publisher,
      publisherName: manifest.value.publisherName,
      catalogId: manifest.value.catalogId,
      catalogName: manifest.value.name,
      itemId: item.itemId,
      kind: item.kind,
      name: item.name,
      version: item.itemVersion,
      digest,
    };
    const target = await this.#canonicalTarget(request.target);
    const state = await this.deps.store.read();
    const allowOlder = request.allowOlder === true;
    // 3–5. The publisher pin, the revision, the version.
    const judged = this.#judge(state, provenance, manifest.value.revision, target, allowOlder);
    // 6. The bundle's own rules for this kind and this target.
    await this.#bundleRules(item, target);
    // 7. The target is one this machine knows.
    const resolved = await this.#resolveTarget(item, target);
    // 8. Nothing sits at the destination that we did not put there, and what we did put there is untouched.
    const { replaces, reading, edited } = await this.#destinationState(item, target, resolved, state, judged.replaces);
    const editedNow = hasEdits(edited) ? editedView(edited, this.#editedPrefix(item, resolved), item.name) : undefined;
    if (editedNow !== undefined && request.replaceEdited !== true)
      refuse(
        'catalog_install_edited',
        `Edited on this machine since it was installed: ${editedWords(editedNow)}. Nothing was replaced. Look at what changes, then replace your edits or keep them.`,
      );
    const changes = replaces === undefined ? undefined : await this.#changes(replaces, item, resolved, reading);
    const placeholders = catalogSecretPlaceholders(item);
    const held = caller.mayListSecrets ? await this.deps.secretNames() : undefined;
    const now = this.deps.now();
    const previewId = this.deps.mint('cip') as HeldPreview['previewId'];
    const expiresAt = now + CATALOG_INSTALL_PREVIEW_TTL_SECONDS * 1000;
    this.#previews.put(
      {
        previewId,
        caller: caller.id,
        createdAt: now,
        expiresAt,
        item,
        provenance,
        revision: manifest.value.revision,
        target,
        allowOlder,
        placeholders,
        ...(editedNow === undefined ? {} : { edited }),
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
      secrets: placeholders.map(placeholder =>
        held === undefined ? { placeholder } : { placeholder, held: held.has(placeholder) },
      ),
      warnings: [
        ...judged.warnings,
        ...(editedNow === undefined
          ? []
          : [
              {
                code: 'edited-locally' as const,
                text: `You changed ${editedWords(editedNow)} here since it was installed. Installing replaces your changes with this version.`,
              },
            ]),
        ...catalogItemWarnings(item),
      ],
      ...(replaces === undefined
        ? {}
        : { replaces: { installId: replaces.installId, version: replaces.provenance.version } }),
      ...(changes === undefined ? {} : { changes }),
      ...(editedNow === undefined ? {} : { edited: editedNow }),
    };
  }

  /**
   * Install exactly the reviewed item, for the caller that reviewed it. The mount has already claimed the
   * passkey proof where one is due.
   */
  async apply(
    scope: CatalogInstallScope,
    request: CatalogInstallRequest,
    caller: CatalogCaller,
    governance: CallerGovernance | undefined,
  ): Promise<CatalogInstalled> {
    return await this.#inTurn(async () => {
      const lookup = this.#previews.get(request.previewId, caller.id, this.deps.now());
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
      const { replaces, reading, edited } = await this.#destinationState(
        held.item,
        held.target,
        resolved,
        state,
        judged.replaces,
      );
      if (!sameEdits(edited, held.edited))
        refuse(
          'catalog_install_edited',
          `Edited on this machine after the changes were reviewed: ${editedWords(editedView(edited, this.#editedPrefix(held.item, resolved), held.item.name))}. Nothing was replaced. Preview it again to see what is there now.`,
        );
      const written =
        held.target.scope === 'project'
          ? await this.#writeProject(held, resolved, request.secretBindings, replaces, reading)
          : await this.#writeRuntime(held, held.target, request.secretBindings, replaces, reading, governance);
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
        ...(resolved.root === undefined ? {} : { root: resolved.root }),
        ...(resolved.destination.folder === undefined ? {} : { folder: resolved.destination.folder }),
        ...(written.componentSha256 === undefined ? {} : { componentSha256: written.componentSha256 }),
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
      await this.#dropPrefs(replaces?.installId);
      return { install: this.#view(record, undefined), notes: written.notes };
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
      if (record.target.scope === 'project') await this.#removeProject(record);
      else await this.#removeRuntime(record, governance, freshStepUp);
      await this.deps.store.write({ ...state, installs: state.installs.filter(install => install !== record) });
      await this.#dropPrefs(record.installId);
      return { installId: record.installId, provenance: record.provenance, destination: record.destination };
    });
  }

  // ── The contract's checks ───────────────────────────────────────────────────────────────────────

  /**
   * Step 2, and the digest the provenance records. The current version is checked against the manifest's own
   * line. Any other version must come with the publisher's signed list of versions: the same key signed both,
   * the list is for this catalog at this revision, and the item is exactly a version it offers — a retired
   * version is not on the list, so it is refused here.
   */
  async #verifiedDigest(request: CatalogInstallPreviewRequest, manifest: SharedCatalogManifest): Promise<string> {
    const { item } = request;
    const current = manifest.items.find(candidate => candidate.itemId === item.itemId);
    if (current === undefined || current.version === item.itemVersion) {
      const line = await verifyCatalogItem(this.deps.crypto, manifest, item);
      return line.ok ? line.value.digest : refuse('catalog_item_mismatch', line.reason);
    }
    if (request.signedVersions === undefined)
      return refuse(
        'catalog_item_mismatch',
        `${item.name} version ${item.itemVersion} is not the version ${manifest.name} lists now. Another version needs the publisher's signed list of versions.`,
      );
    const offered = await verifyCatalogItemAgainstVersions(
      this.deps.crypto,
      manifest,
      request.signedManifest.spki,
      request.signedVersions,
      item,
    );
    if (offered.ok) return offered.value.digest;
    return refuse(
      offered.refusal === 'signature_invalid' ? 'catalog_signature_invalid' : 'catalog_item_mismatch',
      offered.reason,
    );
  }

  /** The recorded path every file of a skill at this destination starts with. */
  #editedPrefix(item: SharedCatalogItem, resolved: ResolvedTarget): string {
    return resolved.destination.folder === undefined ? `skills/${item.name}/` : `${resolved.destination.folder}/`;
  }

  /**
   * "See changes", on THIS machine's own bytes: the installed copy rebuilt from what is on disk (and in the
   * stored setup), compared with the offered item. Bounded by the diff's step budget. If the rebuild fails for
   * any reason the answer simply has no `changes`; the full review still shows the item whole.
   */
  async #changes(
    replaces: CatalogInstallRecord,
    item: SharedCatalogItem,
    resolved: ResolvedTarget,
    reading: SkillFolderReading | undefined,
  ): Promise<CatalogChanges | undefined> {
    try {
      const installed = await this.#installedItem(replaces, item, resolved, reading);
      if (installed === undefined) return undefined;
      const changes = catalogItemChanges(installed.item, item, newDiffBudget());
      return item.kind === 'skill' && installed.unreadable.length > 0
        ? withUnreadableFiles(changes, installed.unreadable, item)
        : changes;
    } catch {
      return undefined;
    }
  }

  async #installedItem(
    replaces: CatalogInstallRecord,
    item: SharedCatalogItem,
    resolved: ResolvedTarget,
    reading: SkillFolderReading | undefined,
  ): Promise<InstalledItem | undefined> {
    const version = replaces.provenance.version;
    const scope = replaces.target.scope;
    if (item.kind === 'skill') {
      const prefix = this.#editedPrefix(item, resolved);
      const paths = [...this.#recorded(replaces, prefix).keys()].filter(path => reading?.files.has(path) === true);
      const read =
        scope === 'project'
          ? await this.deps.skillFiles.read(replaces.root as string, resolved.destination.folder as string, paths)
          : await this.deps.runtimeSkills.read(item.name, paths);
      return { item: skillAsInstalled(item, version, read.files), unreadable: read.tooLarge };
    }
    if (item.kind !== 'mcp') return undefined;
    let setup: CatalogMcpSetup | undefined;
    if (scope === 'project') {
      const { document } = await this.#readProjectMcp(replaces.root as string);
      const servers = document.mcpServers as Record<string, unknown> | undefined;
      setup =
        servers !== undefined && Object.hasOwn(servers, item.name)
          ? setupOfProjectEntry(servers[item.name])
          : undefined;
    } else {
      const component = await this.deps.fleet.storedComponent('mcp', item.name);
      const converted = mcpSetupOf({
        id: item.name,
        name: item.name,
        scope: 'component',
        harness: 'claude',
        declaration: null,
        component: component as McpComponentRecord | undefined,
      });
      setup = converted.ok ? converted.setup : undefined;
    }
    if (setup === undefined) return undefined;
    return {
      item: mcpAsInstalled(item, version, withPlaceholders(setup, item.mcp, replaces.secretBindings)),
      unreadable: [],
    };
  }

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
          root: wanted,
          destination: {
            key: `project:${wanted}/${PROJECT_MCP_FILE}#${item.name}`,
            words: `the server ${item.name} in ${wanted}/${PROJECT_MCP_FILE}`,
          },
        };
      const folder = `${target.harness === 'claude' ? '.claude' : '.agents'}/skills/${item.name}`;
      const count = item.kind === 'skill' ? item.skill.files.length : 0;
      return {
        root: wanted,
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
  ): Promise<DestinationState> {
    const holder = state.installs.find(install => install.key === resolved.destination.key);
    if (holder !== undefined && holder !== replaces)
      refuse(
        'catalog_install_conflict',
        `${resolved.destination.words} already holds ${holder.provenance.name} from ${holder.provenance.publisherName}'s ${holder.provenance.catalogName}. Remove that first (install ${holder.installId}).`,
      );
    const root = resolved.root as string;
    if (target.scope === 'project') {
      if (item.kind === 'mcp') {
        const entry = await this.#checkProjectMcp(root, item.name, replaces);
        return { replaces, reading: undefined, edited: entry === undefined ? NO_EDITS : { files: new Map(), entry } };
      }
      const folder = resolved.destination.folder as string;
      const reading = await this.#inspectProjectSkill(root, folder);
      return { replaces, reading, edited: { files: this.#checkFolder(reading, replaces, `${folder}/`, `${folder}/`) } };
    }
    return await this.#checkRuntime(item, replaces);
  }

  /** Answers the entry's hash when it is the one of ours that was edited here since, else nothing. */
  async #checkProjectMcp(
    root: string,
    name: string,
    replaces: CatalogInstallRecord | undefined,
  ): Promise<string | undefined> {
    const { document } = await this.#readProjectMcp(root);
    const servers = document.mcpServers as Record<string, unknown> | undefined;
    const present = servers !== undefined && Object.hasOwn(servers, name);
    if (!present) return undefined;
    const recorded = replaces?.files[0]?.sha256;
    if (recorded === undefined)
      refuse(
        'catalog_install_conflict',
        `${PROJECT_MCP_FILE} already has a server called ${name} that no install of ours put there.`,
      );
    const now = await this.#hash(JSON.stringify(servers[name]));
    return now === recorded ? undefined : now;
  }

  /** The runtime side of step 8. Answers the skill folder as it was READ, so the write is guarded by that very reading. */
  async #checkRuntime(item: SharedCatalogItem, replaces: CatalogInstallRecord | undefined): Promise<DestinationState> {
    const kind = item.kind === 'mcp' ? 'mcp' : 'skills';
    const component = await this.deps.fleet.storedComponent(kind, item.name);
    let edited: string | undefined;
    if (component !== undefined) {
      if (replaces === undefined)
        refuse(
          'catalog_install_conflict',
          `${item.name} is already a ${kind === 'mcp' ? 'server' : 'skill'} on this machine, and no install of ours put it there.`,
        );
      const now = await this.#componentHash(component);
      if (now !== replaces?.componentSha256) edited = now;
    }
    if (item.kind !== 'skill')
      return {
        replaces,
        reading: undefined,
        edited: edited === undefined ? NO_EDITS : { files: new Map(), component: edited },
      };
    const reading = await this.deps.runtimeSkills.inspect(item.name);
    const files = this.#checkFolder(reading, replaces, `skills/${item.name}/`, `${item.name}/`);
    return { replaces, reading, edited: { files, ...(edited === undefined ? {} : { component: edited }) } };
  }

  /**
   * What an install recorded under `prefix` (a folder's path in the record), by the file's path inside
   * that folder. Exact: a file is only ever the one the record names, never one that merely ends the same.
   */
  #recorded(record: CatalogInstallRecord | undefined, prefix: string): Map<string, string> {
    const recorded = new Map<string, string>();
    for (const file of record?.files ?? [])
      if (file.path.startsWith(prefix)) recorded.set(file.path.slice(prefix.length), file.sha256);
    return recorded;
  }

  /**
   * A folder holds only files an earlier install of ours wrote and recorded a hash for (a missing one is not an
   * edit). A file we have no hash for is a conflict, always. A file we wrote whose hash changed is an EDIT: answered
   * by path with the hash it has now, for the caller to refuse or the person to replace.
   */
  #checkFolder(
    reading: SkillFolderReading,
    replaces: CatalogInstallRecord | undefined,
    prefix: string,
    where: string,
  ): Map<string, string> {
    const edited = new Map<string, string>();
    if (!reading.exists || reading.files.size === 0) return edited;
    if (replaces === undefined)
      refuse('catalog_install_conflict', `${where} already holds files that no install of ours put there.`);
    const recorded = this.#recorded(replaces, prefix);
    for (const [path, hash] of reading.files) {
      const expected = recorded.get(path);
      if (expected === undefined)
        refuse('catalog_install_conflict', `${where}${path} is here but no install of ours wrote it.`);
      if (expected !== hash) edited.set(path, hash);
    }
    return edited;
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
      if (secret === null) continue;
      if (!own.has(secret))
        refuse('catalog_bindings_invalid', `You have no secret called ${secret}, so ${placeholder} cannot use it.`);
    }
    if (held.target.scope !== 'project') return;
    for (const secret of Object.values(bindings))
      if (secret !== null && !ENV_VARIABLE.test(secret))
        refuse(
          'catalog_bindings_invalid',
          `A project's ${PROJECT_MCP_FILE} can only read an environment variable, and ${secret} is not a name one can have (upper-case letters, digits and _). Install it into a runtime, or pick a secret with such a name.`,
        );
  }

  // ── Project writes ──────────────────────────────────────────────────────────────────────────────

  async #writeProject(
    held: HeldPreview,
    resolved: ResolvedTarget,
    bindings: CatalogSecretBindings,
    replaces: CatalogInstallRecord | undefined,
    verified: SkillFolderReading | undefined,
  ): Promise<Written> {
    const { item } = held;
    const root = resolved.root as string;
    if (item.kind === 'mcp') return await this.#writeProjectMcp(item, root, bindings);
    if (item.kind !== 'skill') return refuse('catalog_not_installable', `${item.name} cannot be installed.`);
    const folder = resolved.destination.folder as string;
    const reading = verified as SkillFolderReading;
    const next = new Set(item.skill.files.map(file => file.path));
    const stale = this.#staleFiles(replaces, `${folder}/`, next, reading);
    const expected = new Map<string, string | null>();
    for (const path of [...next, ...stale])
      expected.set(path, held.edited?.files.get(path) ?? reading.files.get(path) ?? null);
    try {
      await this.deps.skillFiles.apply(root, folder, {
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

  /** Files a replaced install wrote that the new item no longer has, and that are still on disk as read. */
  #staleFiles(
    replaces: CatalogInstallRecord | undefined,
    prefix: string,
    next: ReadonlySet<string>,
    reading: SkillFolderReading,
  ): string[] {
    return [...this.#recorded(replaces, prefix).keys()].filter(path => !next.has(path) && reading.files.has(path));
  }

  async #writeProjectMcp(
    item: Extract<SharedCatalogItem, { kind: 'mcp' }>,
    root: string,
    bindings: CatalogSecretBindings,
  ): Promise<Written> {
    const notes: string[] = [];
    const server = this.#server(item, value => {
      const placeholder = SECRET_PLACEHOLDER.exec(value)?.[1];
      if (placeholder === undefined) return value;
      const variable = bindings[placeholder];
      if (!variable) {
        notes.push(UNBOUND_NOTE(placeholder));
        return undefined;
      }
      notes.push(
        `${item.name} reads \${${variable}} from its environment. A project's ${PROJECT_MCP_FILE} cannot use Ferretry's secrets, so give the ferret a variable called ${variable}.`,
      );
      return `\${${variable}}`;
    });
    const refusal = mcpServerRefusal('project', server);
    if (refusal !== null) refuse('catalog_not_installable', refusal);
    const { path, reading, document } = await this.#readProjectMcp(root);
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

  async #removeProject(record: CatalogInstallRecord): Promise<void> {
    const root = record.root as string;
    const first = record.files[0];
    if (first?.entry !== undefined) {
      const { path, reading, document } = await this.#readProjectMcp(root);
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
    const folder = record.folder as string;
    const reading = await this.#inspectProjectSkill(root, folder);
    const { remove, expected } = this.#removal(record, reading, `${folder}/`, `${folder}/`);
    try {
      await this.deps.skillFiles.apply(root, folder, { write: [], remove, expected });
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
  #removal(record: CatalogInstallRecord, reading: SkillFolderReading, prefix: string, where: string) {
    const remove: string[] = [];
    const expected = new Map<string, string | null>();
    for (const [relative, sha256] of this.#recorded(record, prefix)) {
      const now = reading.files.get(relative);
      if (now === undefined) continue;
      if (now !== sha256)
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
    verified: SkillFolderReading | undefined,
    governance: CallerGovernance | undefined,
  ): Promise<Written> {
    const { item } = held;
    let component: FleetComponentInput;
    let files: { path: string; content: string }[] = [];
    const notes: string[] = [];
    if (item.kind === 'artifact') return refuse('catalog_not_installable', `${item.name} cannot be installed.`);
    if (item.kind === 'mcp') {
      const server = this.#server(item, value => {
        const placeholder = SECRET_PLACEHOLDER.exec(value)?.[1];
        if (placeholder === undefined) return value;
        const secret = bindings[placeholder];
        if (!secret) {
          notes.push(UNBOUND_NOTE(placeholder));
          return undefined;
        }
        return `\${secret:${secret}}`;
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
    // Everything the record needs that does not depend on the write is made BEFORE it, so once the
    // component is written nothing below can throw and leave it without a record of ours.
    const recorded =
      item.kind === 'skill'
        ? await Promise.all(
            item.skill.files.map(async file => ({
              path: `skills/${item.name}/${file.path}`,
              sha256: await this.#hash(file.content),
            })),
          )
        : [];
    const { component: stored } = await this.deps.fleet.installCatalogItem(
      {
        kind: 'catalog.install',
        name: item.name,
        component,
        files,
        profile: target.profile,
        installedFrom: held.provenance,
        replace: replaces !== undefined,
      },
      governance,
    );
    if (item.kind === 'skill') {
      const next = new Set(item.skill.files.map(file => file.path));
      const reading = verified as SkillFolderReading;
      const stale = this.#staleFiles(replaces, `skills/${item.name}/`, next, reading);
      if (stale.length > 0)
        try {
          await this.deps.runtimeSkills.remove(
            item.name,
            new Map(stale.map(path => [path, reading.files.get(path) as string])),
          );
        } catch {
          // The new version is already written, so refusing now would leave it without a record.
          notes.push(
            `${stale.length === 1 ? 'A file' : 'Files'} from the earlier version could not be removed from skills/${item.name}/ and ${stale.length === 1 ? 'is' : 'are'} still there: ${stale.join(', ')}.`,
          );
        }
    }
    return {
      componentSha256: await this.#componentHash(stored),
      files: recorded,
      notes: [
        ...notes,
        `It is a layer of profile ${target.profile}, so ${target.runtime} gets it the next time it starts.`,
      ],
    };
  }

  async #removeRuntime(
    record: CatalogInstallRecord,
    governance: CallerGovernance | undefined,
    freshStepUp: FreshStepUpContext,
  ): Promise<void> {
    const kind = record.provenance.kind === 'mcp' ? 'mcp' : 'skills';
    const name = record.provenance.name;
    const component = await this.deps.fleet.storedComponent(kind, name);
    if (component !== undefined && (await this.#componentHash(component)) !== record.componentSha256)
      refuse(
        'catalog_install_conflict',
        `${name} was edited on this machine since it was installed, so it was not removed.`,
      );
    let removal: { remove: string[]; expected: Map<string, string | null> } | undefined;
    if (kind === 'skills') {
      const reading = await this.deps.runtimeSkills.inspect(name);
      removal = this.#removal(record, reading, `skills/${name}/`, `${name}/`);
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
    if (removal !== undefined && removal.remove.length > 0)
      await this.deps.runtimeSkills.remove(name, removal.expected);
  }

  // ── Small things ────────────────────────────────────────────────────────────────────────────────

  /** The item's server with every environment value passed through `value`; one that answers `undefined` is left out. */
  #server(
    item: Extract<SharedCatalogItem, { kind: 'mcp' }>,
    value: (text: string) => string | undefined,
  ): SessionMcpServer {
    const setup = item.mcp;
    if (setup.transport === 'url') return { transport: 'url', url: setup.url, oauth: setup.auth === 'oauth' };
    return {
      transport: 'command',
      command: setup.command,
      args: [...setup.args],
      env: Object.fromEntries(
        Object.entries(setup.env).flatMap(([name, text]) => {
          const written = value(text);
          return written === undefined ? [] : [[name, written]];
        }),
      ),
    };
  }

  /**
   * A stored component's hash in its canonical form: ALL of what the daemon holds, however it is spelled
   * on disk — hidden environment values as their real stored text, the harness, the oauth flag and the
   * recorded provenance. It is never the redacted view a route serves, which could not see a hand edit
   * of a hidden value. The hash is internal and leaves no route.
   */
  async #componentHash(component: unknown): Promise<string> {
    return await this.#hash(canonical(component));
  }

  /** The target as this machine spells it, so two spellings of one place are one place (`sameTarget`, the key). */
  async #canonicalTarget(target: CatalogInstallTarget): Promise<CatalogInstallTarget> {
    if (target.scope === 'project') return { ...target, projectRoot: withoutTrailingSlash(target.projectRoot) };
    const runtime = (await this.deps.fleet.runtimes()).runtimes.find(
      candidate => candidate.name === target.runtime || candidate.id === target.runtime,
    );
    return runtime === undefined ? target : { ...target, runtime: runtime.name };
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
