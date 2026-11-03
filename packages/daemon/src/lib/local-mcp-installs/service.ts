/**
 * Copying ONE MCP server from somewhere else on this machine (docs/catalogs.md § Copying an MCP server from this
 * machine). The local skill installer's twin, with the catalog installer's rules for secrets:
 * {@link LocalMcpInstallService.preview} finds the server in the machine's MCP inventory and answers the full
 * review, WRITING NOTHING; {@link LocalMcpInstallService.apply} writes exactly the setup that was reviewed.
 *
 * THE SOURCE IS THE INVENTORY'S. The caller names an inventory id; this service looks it up there and opens
 * nothing the inventory does not list (`source.ts` turns what it lists into a setup).
 *
 * NO SECRET VALUE IS COPIED OR SHOWN. Every environment value becomes a placeholder, an address's credentials are
 * left out and said, and the person binds each placeholder to one of THEIR OWN secrets at apply — the way a catalog
 * install does it, through the same helpers (`catalog-installs/mcp-writes.ts`). Nothing held here, in a record or in
 * a note, is a value; a record holds the NAMES of the secrets a copy was bound to.
 *
 * A COPY, NEVER A LINK, and ONLY THROUGH THE EXISTING WRITE PATHS: a project's `.mcp.json` through the
 * session-MCP file port (compare-and-swap, no link followed), a runtime through one fleet `catalog.install` change,
 * which the fleet stages and applies like every other. Nothing here opens a path of its own.
 *
 * WHAT THIS SERVICE WROTE IS WHAT IT MAY CHANGE. An entry at the destination that no record of ours put there is a
 * conflict — a catalog install's included, which is how the two stores keep apart without knowing about each other —
 * and so is an entry we wrote that has been changed since. A record is a file on disk, so the place it names is
 * not taken on trust when it is removed or replaced.
 *
 * THE FLEET WANTS A PROVENANCE for a runtime install. The one given is the synthetic one `local-copies/synthetic.ts`
 * defines, with an item id derived from the server's name (so an update lands on the same component).
 */
import {
  type CatalogInstallScope,
  type CatalogInstallTarget,
  type CatalogProvenance,
  type CatalogSecretBindings,
  catalogItemReview,
  catalogItemWarnings,
  type FleetComponentInput,
  LOCAL_MCP_PREVIEW_TTL_SECONDS,
  type LocalMcpInstall,
  type LocalMcpInstalled,
  type LocalMcpInstallList,
  type LocalMcpPreview,
  type LocalMcpPreviewRequest,
  type LocalMcpRemoved,
  mcpServerRefusal,
  type SharedCatalogItem,
  SHARED_CATALOG_ITEM_FORMAT,
} from '@ferretry/protocol';
import type { RelayCrypto } from '@ferretry/relay';
import type { CallerGovernance } from '../api/capability.ts';
import {
  bindingsRefusal,
  checkProjectMcp,
  type McpWriteContext,
  PROJECT_MCP_FILE,
  projectServerOf,
  removeProjectMcp,
  runtimeComponentOf,
  withoutTrailingSlash,
  writeProjectMcp,
} from '../catalog-installs/mcp-writes.ts';
import type { FleetCatalogService, FreshStepUpContext } from '../fleet/catalog-service.ts';
import {
  base64Url,
  canonical,
  hexOf,
  LOCAL_CATALOG_ID,
  LOCAL_PUBLISHER,
  LOCAL_PUBLISHER_NAME,
} from '../local-copies/synthetic.ts';
import { type McpProjectFiles, projectRootFor } from '../session-mcp/service.ts';
import { LocalMcpRefusalError } from './ports.ts';
import { type HeldLocalMcp, LocalMcpPreviews } from './previews.ts';
import { copiableMcp, type LocalMcpInventoryServer } from './source.ts';
import { type LocalMcpInstallRecord, type LocalMcpInstallStore } from './store.ts';

export interface LocalMcpInstallServiceDeps {
  readonly crypto: Pick<RelayCrypto, 'sha256'>;
  readonly store: LocalMcpInstallStore;
  /** Every server the machine's MCP inventory lists: the only sources there are. */
  servers(): Promise<readonly LocalMcpInventoryServer[]>;
  /** Every folder a project write may land in: registered projects and live managed worktrees. */
  projectRoots(): Promise<readonly string[]>;
  readonly mcpFiles: McpProjectFiles;
  readonly fleet: Pick<
    FleetCatalogService,
    'runtimes' | 'profiles' | 'storedComponent' | 'propose' | 'apply' | 'installCatalogItem'
  >;
  /** The NAMES of the secrets this machine holds. Never a value. */
  secretNames(): Promise<ReadonlySet<string>>;
  now(): number;
  /** A fresh id: `lmp_…` for a preview, `lmi_…` for a copy. */
  mint(prefix: 'lmp' | 'lmi'): string;
}

/** The caller of a preview or an apply, as the mount identified it. */
export interface LocalMcpCaller {
  /** Who asked: a preview can only be applied by the same one. */
  readonly id: string;
  /** Whether this caller may list secret names (`secrets.use`); only then does a review say which are held. */
  readonly mayListSecrets: boolean;
}

const LOCAL_MCP_CATALOG_NAME = 'MCP servers on this machine';

const refuse = (code: LocalMcpRefusalError['code'], message: string): never => {
  throw new LocalMcpRefusalError(code, message);
};

interface ResolvedTarget {
  /** A stable key: two copies sharing it would overwrite each other. */
  readonly key: string;
  readonly words: string;
  /** A project target's normalised root. */
  readonly root?: string;
}

export class LocalMcpInstallService {
  readonly #previews: LocalMcpPreviews;
  /** Applies and removes take turns: each reads the state, writes files, and writes the state back. */
  #turn: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: LocalMcpInstallServiceDeps,
    previews: LocalMcpPreviews = new LocalMcpPreviews(LOCAL_MCP_PREVIEW_TTL_SECONDS * 1000),
  ) {
    this.#previews = previews;
  }

  /** `GET /v1/mcp-installs/local`. */
  async list(): Promise<LocalMcpInstallList> {
    const state = await this.deps.store.read();
    return { installs: state.installs.map(installOf) };
  }

  /** Read the source, judge the target, answer the review. Writes nothing and changes no state. */
  async preview(
    scope: CatalogInstallScope,
    request: LocalMcpPreviewRequest,
    caller: LocalMcpCaller,
  ): Promise<LocalMcpPreview> {
    if (request.target.scope !== scope)
      refuse('local_mcp_target_unknown', `this asks for a ${scope} copy but names a ${request.target.scope} target`);
    const source = await this.#readSource(request.source.id);
    const target = await this.#canonicalTarget(request.target);
    this.#shapeRules(source.name, source.setup, target);
    const state = await this.deps.store.read();
    const resolved = await this.#resolveTarget(source.name, target);
    const replaces = state.installs.find(install => install.key === resolved.key);
    await this.#destinationState(source.name, target, resolved, replaces);
    const provenance = await this.#provenance(source.name, source.setup);
    const now = this.deps.now();
    const previewId = this.deps.mint('lmp') as HeldLocalMcp['previewId'];
    const expiresAt = now + LOCAL_MCP_PREVIEW_TTL_SECONDS * 1000;
    this.#previews.put(
      {
        previewId,
        caller: caller.id,
        expiresAt,
        name: source.name,
        origin: source.origin,
        provenance,
        target,
        setup: source.setup,
        placeholders: source.placeholders,
      },
      now,
    );
    const held = caller.mayListSecrets ? await this.deps.secretNames() : undefined;
    const item = itemOf(source.name, source.setup, provenance);
    return {
      previewId,
      expiresAt: new Date(expiresAt).toISOString(),
      name: source.name,
      origin: source.origin,
      provenance,
      target,
      destination: resolved.words,
      review: [...catalogItemReview(item)],
      secrets: source.placeholders.map(placeholder =>
        held === undefined ? { placeholder } : { placeholder, held: held.has(placeholder) },
      ),
      skipped: [...source.skipped],
      warnings: [...catalogItemWarnings(item)],
      ...(replaces === undefined ? {} : { replaces: { installId: replaces.installId } }),
    };
  }

  /**
   * Copy exactly the previewed server, for the caller that reviewed it. The mount has already claimed the
   * passkey proof where one is due.
   */
  async apply(
    scope: CatalogInstallScope,
    previewId: string,
    bindings: CatalogSecretBindings,
    caller: LocalMcpCaller,
    governance: CallerGovernance | undefined,
  ): Promise<LocalMcpInstalled> {
    return await this.#inTurn(async () => {
      const lookup = this.#previews.get(previewId, caller.id, this.deps.now());
      if (lookup.kind === 'unknown')
        return refuse(
          'local_mcp_preview_unknown',
          'There is no such preview, or it was already used. Preview the server again.',
        );
      if (lookup.kind === 'expired')
        return refuse(
          'local_mcp_preview_expired',
          'That preview ran out of time. Preview the server again and look it over.',
        );
      const held = lookup.preview;
      if (held.target.scope !== scope)
        return refuse(
          'local_mcp_preview_unknown',
          `That preview is for a ${held.target.scope} copy, not a ${scope} one.`,
        );
      const refusal = bindingsRefusal(held.placeholders, bindings, await this.deps.secretNames(), scope, 'this server');
      if (refusal !== undefined) return refuse('local_mcp_bindings_invalid', refusal);
      // The machine may have moved on since the review: judge again against what is true now.
      const state = await this.deps.store.read();
      const resolved = await this.#resolveTarget(held.name, held.target);
      const replaces = state.installs.find(install => install.key === resolved.key);
      const seen = await this.#destinationState(held.name, held.target, resolved, replaces);
      const written =
        held.target.scope === 'project'
          ? await this.#writeProject(held, resolved, bindings, seen)
          : await this.#writeRuntime(held, held.target, bindings, replaces, governance);
      const record: LocalMcpInstallRecord = {
        installId: this.deps.mint('lmi') as LocalMcpInstallRecord['installId'],
        installedAt: new Date(this.deps.now()).toISOString(),
        name: held.name,
        origin: held.origin,
        provenance: held.provenance,
        target: held.target,
        destination: resolved.words,
        key: resolved.key,
        secretBindings: bindings,
        ...(resolved.root === undefined ? {} : { root: resolved.root }),
        ...('entrySha256' in written ? { entrySha256: written.entrySha256 } : {}),
        ...('componentSha256' in written ? { componentSha256: written.componentSha256 } : {}),
      };
      await this.deps.store.write({
        schemaVersion: state.schemaVersion,
        installs: [...state.installs.filter(install => install.installId !== replaces?.installId), record],
      });
      this.#previews.consume(held.previewId);
      return { install: installOf(record), notes: [...new Set(written.notes)] };
    });
  }

  /** Remove exactly what a copy wrote, refusing if it was edited here since. Never asks for a passkey. */
  async remove(
    scope: CatalogInstallScope,
    installId: string,
    governance: CallerGovernance | undefined,
    freshStepUp: FreshStepUpContext,
  ): Promise<LocalMcpRemoved> {
    return await this.#inTurn(async () => {
      const state = await this.deps.store.read();
      const record = state.installs.find(install => install.installId === installId && install.target.scope === scope);
      if (record === undefined)
        return refuse('local_mcp_install_unknown', `There is no ${scope} copy ${installId} on this machine.`);
      if (record.target.scope === 'project') await this.#removeProject(record);
      else await this.#removeRuntime(record, governance, freshStepUp);
      await this.deps.store.write({ ...state, installs: state.installs.filter(install => install !== record) });
      return { installId: record.installId, name: record.name, destination: record.destination };
    });
  }

  // ── The source ──────────────────────────────────────────────────────────────────────────────────

  /** Found again in the inventory by its id, then turned into a setup of placeholders. Refuses what cannot be copied. */
  async #readSource(id: string) {
    const server = (await this.deps.servers()).find(candidate => candidate.id === id);
    if (server === undefined)
      return refuse(
        'local_mcp_source_unknown',
        "This machine's MCP inventory lists no server with that id. Name one it lists.",
      );
    const copiable = copiableMcp(server);
    if (!copiable.ok) return refuse('local_mcp_source_invalid', copiable.reason);
    return copiable;
  }

  /** What a project or a runtime can hold of this server, by the rules a catalog install runs. */
  #shapeRules(name: string, setup: HeldLocalMcp['setup'], target: CatalogInstallTarget): void {
    if (target.scope === 'project') {
      if (target.harness === 'codex')
        refuse(
          'local_mcp_target_unknown',
          'Codex does not read .mcp.json, so a project server would never reach it. Copy it into a runtime instead.',
        );
      const refusal = mcpServerRefusal(
        'project',
        setup.transport === 'url'
          ? { transport: 'url', url: setup.url, oauth: setup.auth === 'oauth' }
          : { transport: 'command', command: setup.command, args: [...setup.args], env: {} },
      );
      if (refusal !== null) refuse('local_mcp_source_invalid', refusal);
      return;
    }
    if (setup.transport === 'url' && setup.oauth !== undefined)
      refuse(
        'local_mcp_source_invalid',
        `${name} needs an OAuth client registered by hand, and a copy cannot set one yet.`,
      );
  }

  /** What a runtime copy hands the fleet, and what a record keeps: synthetic, and honest about it. */
  async #provenance(name: string, setup: HeldLocalMcp['setup']): Promise<CatalogProvenance> {
    const item = await this.#bytes(`local-mcp-item:${name}`);
    const digest = await this.#hash(canonical({ name, setup }));
    return {
      publisher: LOCAL_PUBLISHER,
      publisherName: LOCAL_PUBLISHER_NAME,
      catalogId: LOCAL_CATALOG_ID,
      catalogName: LOCAL_MCP_CATALOG_NAME,
      itemId: `itm_${base64Url(item.subarray(0, 16))}`,
      kind: 'mcp',
      name,
      version: 1,
      digest: `sha256:${digest}`,
    };
  }

  // ── The target ──────────────────────────────────────────────────────────────────────────────────

  /** A project is one this machine registered or made; a runtime and profile already exist. */
  async #resolveTarget(name: string, target: CatalogInstallTarget): Promise<ResolvedTarget> {
    if (target.scope === 'project') {
      const wanted = withoutTrailingSlash(target.projectRoot);
      const roots = (await this.deps.projectRoots()).map(withoutTrailingSlash);
      if (projectRootFor(wanted, roots) !== wanted || !roots.includes(wanted))
        return refuse(
          'local_mcp_target_unknown',
          `${target.projectRoot} is not a project this machine knows. Register the project, or name the folder of one it has.`,
        );
      return {
        root: wanted,
        key: `project:${wanted}/${PROJECT_MCP_FILE}#${name}`,
        words: `the server ${name} in ${wanted}/${PROJECT_MCP_FILE}`,
      };
    }
    const runtime = (await this.deps.fleet.runtimes()).runtimes.find(
      candidate => candidate.name === target.runtime || candidate.id === target.runtime,
    );
    if (runtime === undefined)
      return refuse('local_mcp_target_unknown', `${target.runtime} is not a runtime on this machine.`);
    const profile = (await this.deps.fleet.profiles()).profiles.find(candidate => candidate.name === target.profile);
    if (profile === undefined)
      return refuse('local_mcp_target_unknown', `${target.profile} is not a profile on this machine.`);
    if (runtime.profile !== profile.name)
      return refuse(
        'local_mcp_target_unknown',
        `${runtime.name} launches with the profile ${runtime.profile}, not ${profile.name}, so copying there would not reach it.`,
      );
    return {
      key: `fleet:mcp/${name}`,
      words: `the server ${name} in profile ${profile.name} (every runtime on that profile gets it, not only ${runtime.name}, and it replaces an earlier copy)`,
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
   * ours wrote is there, or what we wrote was changed. Answers a project entry's hash as READ (`null` when there
   * is none), so the write is guarded by that very reading.
   */
  async #destinationState(
    name: string,
    target: CatalogInstallTarget,
    resolved: ResolvedTarget,
    replaces: LocalMcpInstallRecord | undefined,
  ): Promise<string | null> {
    if (target.scope === 'project') {
      if (replaces !== undefined) await this.#trustedPlace(replaces);
      const { seen, entry } = await checkProjectMcp(
        this.deps.mcpFiles,
        resolved.root as string,
        name,
        replaces?.entrySha256,
        this.#mcpContext(),
      );
      if (entry !== undefined)
        refuse('local_mcp_conflict', `${name} was edited on this machine since it was copied, so it was not replaced.`);
      return seen;
    }
    const component = await this.deps.fleet.storedComponent('mcp', name);
    if (component !== undefined) {
      if (replaces === undefined)
        refuse('local_mcp_conflict', `${name} is already a server on this machine, and no copy of ours put it there.`);
      if ((await this.#hash(canonical(component))) !== replaces?.componentSha256)
        refuse('local_mcp_conflict', `${name} was edited on this machine since it was copied, so it was not replaced.`);
    }
    return null;
  }

  /**
   * A record is a file on disk, so the place it names is not taken on trust: a project record's root must be a
   * project this machine knows, its key the one this name and root give, and it must hold the hash it wrote,
   * or nothing is removed or replaced.
   */
  async #trustedPlace(record: LocalMcpInstallRecord): Promise<string> {
    const root = withoutTrailingSlash(record.root ?? '');
    const known = (await this.deps.projectRoots()).map(withoutTrailingSlash).includes(root);
    if (
      !known ||
      record.entrySha256 === undefined ||
      record.key !== `project:${root}/${PROJECT_MCP_FILE}#${record.name}`
    )
      return refuse(
        'local_mcp_target_unknown',
        `The record of the copy ${record.installId} names a place that is not the .mcp.json of a project this machine knows, so nothing was changed there.`,
      );
    return root;
  }

  // ── Project writes ──────────────────────────────────────────────────────────────────────────────

  async #writeProject(
    held: HeldLocalMcp,
    resolved: ResolvedTarget,
    bindings: CatalogSecretBindings,
    seen: string | null,
  ): Promise<{ entrySha256: string; notes: string[] }> {
    const notes: string[] = [];
    const server = projectServerOf(held.name, held.setup, bindings, notes);
    const { sha256 } = await writeProjectMcp(
      this.deps.mcpFiles,
      resolved.root as string,
      held.name,
      server,
      seen,
      this.#mcpContext(),
    );
    return { entrySha256: sha256, notes };
  }

  async #removeProject(record: LocalMcpInstallRecord): Promise<void> {
    const root = await this.#trustedPlace(record);
    await removeProjectMcp(this.deps.mcpFiles, root, record.name, record.entrySha256 as string, this.#mcpContext());
  }

  // ── Runtime writes ──────────────────────────────────────────────────────────────────────────────

  async #writeRuntime(
    held: HeldLocalMcp,
    target: Extract<CatalogInstallTarget, { scope: 'runtime' }>,
    bindings: CatalogSecretBindings,
    replaces: LocalMcpInstallRecord | undefined,
    governance: CallerGovernance | undefined,
  ): Promise<{ componentSha256: string; notes: string[] }> {
    const notes: string[] = [];
    const made = runtimeComponentOf(held.setup, bindings, notes);
    if ('refusal' in made) return refuse('local_mcp_source_invalid', made.refusal);
    const component: FleetComponentInput = made.component;
    const { component: stored } = await this.deps.fleet.installCatalogItem(
      {
        kind: 'catalog.install',
        name: held.name,
        component,
        files: [],
        profile: target.profile,
        installedFrom: held.provenance,
        replace: replaces !== undefined,
      },
      governance,
    );
    return {
      componentSha256: await this.#hash(canonical(stored)),
      notes: [
        ...notes,
        `It is a layer of profile ${target.profile}, so ${target.runtime} gets it the next time it starts.`,
      ],
    };
  }

  async #removeRuntime(
    record: LocalMcpInstallRecord,
    governance: CallerGovernance | undefined,
    freshStepUp: FreshStepUpContext,
  ): Promise<void> {
    const { name } = record;
    if (record.key !== `fleet:mcp/${name}` || record.componentSha256 === undefined)
      return refuse(
        'local_mcp_target_unknown',
        `The record of the copy ${record.installId} names a place that is not a server of this machine's fleet, so nothing was changed there.`,
      );
    const component = await this.deps.fleet.storedComponent('mcp', name);
    if (component === undefined) return;
    if ((await this.#hash(canonical(component))) !== record.componentSha256)
      refuse('local_mcp_conflict', `${name} was edited on this machine since it was copied, so it was not removed.`);
    const change = await this.deps.fleet.propose({
      kind: 'component.remove',
      componentKind: 'mcp',
      name,
      removeFromProfiles: true,
    });
    await this.deps.fleet.apply(change.id, governance, freshStepUp);
  }

  // ── Small things ────────────────────────────────────────────────────────────────────────────────

  /** The words and the refusal this installer hands the shared MCP writes. */
  #mcpContext(): McpWriteContext {
    return {
      noun: 'copy',
      past: 'copied',
      conflict: message => refuse('local_mcp_conflict', message),
      hash: text => this.#hash(text),
    };
  }

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

function installOf(record: LocalMcpInstallRecord): LocalMcpInstall {
  return {
    installId: record.installId,
    installedAt: record.installedAt,
    name: record.name,
    origin: record.origin,
    target: record.target,
    destination: record.destination,
    secretBindings: record.secretBindings,
  };
}

/** The same shape as a catalog MCP item, so the review and the warnings are the catalog installer's own, unchanged. */
function itemOf(name: string, setup: HeldLocalMcp['setup'], provenance: CatalogProvenance): SharedCatalogItem {
  return {
    format: SHARED_CATALOG_ITEM_FORMAT,
    version: 1,
    publisher: provenance.publisher,
    catalogId: provenance.catalogId,
    itemId: provenance.itemId,
    itemVersion: provenance.version,
    name,
    summary: 'An MCP server copied from this machine',
    kind: 'mcp',
    mcp: setup,
  };
}
