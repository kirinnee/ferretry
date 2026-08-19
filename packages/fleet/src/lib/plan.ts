/**
 * The plan builder — the whole of `fy fleet apply`'s decision-making, as one pure function.
 *
 * Given a parsed configuration and the directories the fleet owns, it produces every write that
 * apply will perform plus the manifest those writes publish. Nothing here touches a filesystem, a
 * clock, or an environment: `generatedAt` is supplied, paths are expanded against a supplied home,
 * and a referenced settings file is emitted as a *reference* for the adapter to read.
 *
 * Two properties are worth stating because they are the reason this unit exists:
 *
 * - **Every join is by account id.** A command finds its target by id, a default home names an
 *   account by id, and the manifest publishes the wrapper path as an attribute. No step recovers a
 *   harness, a lane, or an account from a filename.
 * - **The plan is total.** Anything the configuration asks for that cannot be materialized — an
 *   asset the harness has no destination for, a duplicate wrapper name — throws while planning,
 *   before a single byte is written, rather than being dropped silently.
 */
import {
  ASSET_FIELDS,
  type AssetField,
  HARNESS_ASSETS,
  type HarnessAssetTable,
  harnessAsset,
  isUsableSkillItemName,
  skillItemName,
  unsupportedAssetFields,
} from './assets.ts';
import { UnimplementedFleetCapabilityError } from './capabilities.ts';
import { type FleetConfig, FleetConfigCapabilities } from './config.ts';
import { buildFleetManifest, type FleetManifest, type HarnessKind } from './manifest.ts';
import { canonicalAssetReference, expandAssetPath, expandHomePath, joinPath } from './paths.ts';
import { type ResolvedAccount, resolveAccounts, resolveCommands, toManifestAccounts } from './profiles.ts';
import type {
  FleetApplyPlan,
  FleetLayout,
  FleetPlanBuilder,
  FleetWriteOperation,
  SettingsLayerSource,
} from './provisioning.ts';
import { unimplementedCapabilities } from './unimplemented.ts';
import { MANAGED_MARKER, renderCommandScript, renderWrapperScript, resolveCommandTargets } from './wrappers.ts';

/** Directories the fleet owns are private: they hold credentials and generated executables. */
const DIRECTORY_MODE = 0o700;
const EXECUTABLE_MODE = 0o755;
const SETTINGS_MODE = 0o600;
const CODEX_SQLITE_MARKER = '.ferretry-sqlite-home.json';

/** Home aliases stay portable in wrappers; every other form uses the exact expanded destination. */
function wrapperHome(declared: string, resolved: string): string {
  return declared === '~' || declared.startsWith('~/') || declared === '$HOME' || declared.startsWith('$HOME/')
    ? declared
    : resolved;
}

/** Raised when a profile declares an asset the account's harness cannot accept. */
export class UnsupportedAssetError extends Error {
  constructor(
    readonly accountId: string,
    readonly kind: HarnessKind,
    readonly field: AssetField,
  ) {
    super(`account "${accountId}" declares "${field}", which the ${kind} harness has no destination for`);
    this.name = 'UnsupportedAssetError';
  }
}

/** Raised when `defaultHomes` names an account id the configuration does not declare. */
export class UnknownDefaultHomeError extends Error {
  constructor(
    readonly kind: HarnessKind,
    readonly accountId: string,
  ) {
    super(`defaultHomes.${kind} names unknown account "${accountId}"`);
    this.name = 'UnknownDefaultHomeError';
  }
}

/** Raised when two selected skill items would claim one destination inside the skills directory. */
export class SkillItemCollisionError extends Error {
  constructor(
    readonly accountId: string,
    readonly item: string,
    readonly sources: readonly string[],
  ) {
    // Both source paths are named rather than only the colliding item name. From a store browser two
    // items that differ solely in their parent directory look identical, so a refusal saying only
    // "review collides" would send somebody to correct the wrong one.
    super(
      `account "${accountId}" selects ${sources.length} skill items that would all be materialized as "${item}": ${sources.join(', ')}; select one of them, or give each item its own name`,
    );
    this.name = 'SkillItemCollisionError';
  }
}

/** Raised when a selected skills reference names no item that could become a destination. */
export class UnnamedSkillItemError extends Error {
  constructor(
    readonly accountId: string,
    readonly reference: string,
  ) {
    super(
      `account "${accountId}" selects the skills reference "${reference}", which names no item to materialize; name the item inside the store rather than the store itself`,
    );
    this.name = 'UnnamedSkillItemError';
  }
}

/** The asset fields that name exactly one path each, in the order they are materialized. */
const PATH_ASSET_FIELDS = ['memory', 'hooks', 'hooksDir', 'mcp'] as const satisfies readonly AssetField[];

/**
 * Asset fields this account actually asks for, in the fields' own declaration order.
 *
 * Three shapes, so three questions. `settings` is a layer stack, so "declared" means a non-empty
 * stack. `skills` is a per-item selection, and an EMPTY selection still counts as declared: an account
 * that selected nothing has said something about its skills, and a harness with no destination for
 * them must be refused for saying it rather than quietly accepted because the list was short. Every
 * other field is declared when it names a path.
 */
export function declaredAssetFields(account: ResolvedAccount): readonly AssetField[] {
  const declared = new Set<AssetField>();
  if (account.settings.length > 0) declared.add('settings');
  if (account.skills !== undefined) declared.add('skills');
  for (const field of PATH_ASSET_FIELDS) {
    if (account[field] !== undefined) declared.add(field);
  }
  return ASSET_FIELDS.filter(field => declared.has(field));
}

/** One selected skill item: the document it comes from, and the name it takes inside the home. */
interface PlannedSkillItem {
  readonly name: string;
  readonly reference: string;
}

/**
 * One account's selection as distinct items, refusing rather than dropping.
 *
 * Two entries naming ONE document are one item, not a collision: a selection assembled by adding to a
 * list can legitimately repeat a reference, and materializing it twice would be the same tree written
 * over itself. Two entries naming DIFFERENT documents that want one destination is the collision, and
 * it throws while planning like every other thing this plan cannot honour.
 */
function plannedSkillItems(account: ResolvedAccount): readonly PlannedSkillItem[] {
  const byName = new Map<string, PlannedSkillItem[]>();
  for (const reference of account.skills ?? []) {
    const name = skillItemName(reference);
    if (!isUsableSkillItemName(name)) throw new UnnamedSkillItemError(account.id, reference);
    const claimed = byName.get(name) ?? [];
    const already = claimed.some(
      item => canonicalAssetReference(item.reference) === canonicalAssetReference(reference),
    );
    if (!already) byName.set(name, [...claimed, { name, reference }]);
  }
  for (const [name, items] of byName) {
    if (items.length > 1) {
      throw new SkillItemCollisionError(
        account.id,
        name,
        items.map(item => item.reference),
      );
    }
  }
  return [...byName.values()].flatMap(items => items.slice(0, 1));
}

export class FleetPlan implements FleetPlanBuilder {
  /** The destination table is a policy, so it is injected rather than reached for. */
  constructor(private readonly assets: HarnessAssetTable = HARNESS_ASSETS) {}

  build(config: FleetConfig, layout: FleetLayout, generatedAt: string): FleetApplyPlan {
    // Before anything is planned: a configuration asking for something this build does not do is
    // refused here rather than applied and quietly not done. It is a planning-time check because
    // `--dry-run` must refuse it too — a dry run that printed a clean plan for a configuration a
    // real apply could not honour would be the misleading half of the same bug.
    const unimplemented = unimplementedCapabilities(config, FleetConfigCapabilities);
    if (unimplemented.length > 0) throw new UnimplementedFleetCapabilityError(unimplemented);

    const accounts = resolveAccounts(config).map(account => ({
      ...account,
      // The filesystem and manifest always need the expanded destination. Wrapper rendering keeps
      // only explicit home aliases portable; a bare name belongs under Ferretry's homes directory.
      resolvedHome: expandHomePath(account.home, layout.userHome, layout.homesDirectory),
    }));
    // resolveCommands throws on a name two generators would claim, before anything is planned.
    const commands = resolveCommands(config, accounts);
    const targets = resolveCommandTargets(commands, accounts, layout.binDirectory);
    const sharedRoot = joinPath(layout.fleetDirectory, 'shared');
    const codexSqliteHome = joinPath(joinPath(sharedRoot, 'codex'), 'sqlite');
    const sharedHomes: Record<HarnessKind, { account: string; path: string }[]> = {
      claude: accounts
        .filter(account => account.kind === 'claude')
        .map(account => ({ account: account.id, path: account.resolvedHome })),
      codex: accounts
        .filter(account => account.kind === 'codex')
        .map(account => ({ account: account.id, path: account.resolvedHome })),
    };

    const operations: FleetWriteOperation[] = [
      { kind: 'directory', path: layout.fleetDirectory, mode: DIRECTORY_MODE },
      { kind: 'directory', path: layout.binDirectory, mode: DIRECTORY_MODE },
      { kind: 'directory', path: layout.homesDirectory, mode: DIRECTORY_MODE },
    ];
    if (config.sharedHistory.codex) {
      // Codex's legacy per-home databases are deliberately never inspected or migrated. Sharing
      // starts with one fresh Ferretry-owned runtime directory beside the rollout pool.
      operations.push({ kind: 'directory', path: codexSqliteHome, mode: DIRECTORY_MODE });
    }

    for (const account of accounts) {
      operations.push({ kind: 'directory', path: account.resolvedHome, mode: DIRECTORY_MODE });
      operations.push(
        ...this.assetOperations(account, account.resolvedHome, layout, {
          enabled: config.sharedHistory.codex,
          sqliteHome: codexSqliteHome,
        }),
      );
      const wrapperAccount = {
        ...account,
        home: wrapperHome(account.home, account.resolvedHome),
        ...(account.kind === 'codex' && config.sharedHistory.codex
          ? { env: { ...account.env, CODEX_SQLITE_HOME: codexSqliteHome } }
          : {}),
      };
      operations.push({
        kind: 'file',
        path: joinPath(layout.binDirectory, account.wrapper),
        // Preserve explicit portable aliases, but bind a bare relative declaration to the same
        // resolved home this plan provisions. The Codex shared-history environment stays attached.
        content: renderWrapperScript(wrapperAccount, { secretsFile: config.secretsFile }),
        mode: EXECUTABLE_MODE,
      });
    }

    // The bare upstream CLI's home receives one account's assets, so `claude` with no wrapper
    // behaves like the account the operator nominated. It is named by id, so renaming that
    // account's wrapper never silently repoints it.
    const accountsById = new Map(accounts.map(account => [account.id, account]));
    for (const [kind, accountId] of Object.entries(config.defaultHomes) as [HarnessKind, string | undefined][]) {
      if (accountId === undefined) continue;
      const account = accountsById.get(accountId);
      if (account === undefined) throw new UnknownDefaultHomeError(kind, accountId);
      const directory = layout.defaultHomeDirectories[kind];
      operations.push({ kind: 'directory', path: directory, mode: DIRECTORY_MODE });
      operations.push(
        ...this.assetOperations(account, directory, layout, {
          enabled: config.sharedHistory.codex,
          sqliteHome: codexSqliteHome,
        }),
      );
      if (!sharedHomes[kind].some(home => home.path === directory)) {
        sharedHomes[kind].push({ account: `${account.id}.default`, path: directory });
      }
    }

    for (const target of targets) {
      operations.push({
        kind: 'file',
        path: joinPath(layout.binDirectory, target.command.wrapper),
        content: renderCommandScript(target),
        mode: EXECUTABLE_MODE,
      });
    }

    operations.push({
      kind: 'prune',
      path: layout.binDirectory,
      marker: MANAGED_MARKER,
      keep: [...accounts.map(account => account.wrapper), ...commands.map(command => command.wrapper)],
    });

    const manifest: FleetManifest = buildFleetManifest({
      generatedAt,
      accounts: toManifestAccounts(
        accounts.map(account => ({ ...account, home: account.resolvedHome })),
        layout.binDirectory,
      ),
    });

    const sharedHistoryRequests = (['claude', 'codex'] as const)
      .filter(kind => config.sharedHistory[kind])
      .map(kind => ({ kind, poolRoot: sharedRoot, homes: sharedHomes[kind] }));

    return { manifest, manifestPath: layout.manifestPath, operations, sharedHistoryRequests };
  }

  /** Materialize one account's profile assets into `directory`. */
  private assetOperations(
    account: ResolvedAccount,
    directory: string,
    layout: FleetLayout,
    codexSqlite: { readonly enabled: boolean; readonly sqliteHome: string },
  ): readonly FleetWriteOperation[] {
    const unsupported = new Set(unsupportedAssetFields(this.assets, account.kind));
    for (const field of declaredAssetFields(account)) {
      if (unsupported.has(field)) throw new UnsupportedAssetError(account.id, account.kind, field);
    }

    const operations: FleetWriteOperation[] = [];
    const settings = harnessAsset(this.assets, account.kind, 'settings');
    const configuredLayers: readonly SettingsLayerSource[] = account.settings.map(layer =>
      typeof layer === 'string'
        ? { from: 'file', path: expandAssetPath(layer, layout.userHome, layout.assetsDirectory) }
        : { from: 'inline', settings: layer },
    );
    if (account.kind === 'codex' && settings?.format !== undefined) {
      const configPath = joinPath(directory, settings.dest);
      operations.push({
        kind: 'codex-sqlite-ownership',
        path: configPath,
        markerPath: joinPath(directory, CODEX_SQLITE_MARKER),
        sqliteHome: codexSqlite.sqliteHome,
        enabled: codexSqlite.enabled,
      });
    }
    if (
      settings?.format !== undefined &&
      (configuredLayers.length > 0 || (account.kind === 'codex' && codexSqlite.enabled))
    ) {
      const layers: readonly SettingsLayerSource[] = [
        ...configuredLayers,
        ...(account.kind === 'codex' && codexSqlite.enabled
          ? [{ from: 'inline' as const, settings: { sqlite_home: codexSqlite.sqliteHome } }]
          : []),
      ];
      operations.push({
        kind: 'settings',
        path: joinPath(directory, settings.dest),
        format: settings.format,
        layers,
        mode: SETTINGS_MODE,
        preserveExisting: settings.mode === 'copy',
      });
    }

    for (const field of PATH_ASSET_FIELDS) {
      const reference = account[field];
      if (reference === undefined) continue;
      const asset = harnessAsset(this.assets, account.kind, field);
      // unsupportedAssetFields already refused a field with no destination for this harness.
      if (asset === undefined) continue;
      const source = expandAssetPath(reference, layout.userHome, layout.assetsDirectory);
      const path = joinPath(directory, asset.dest);
      operations.push(asset.mode === 'link' ? { kind: 'symlink', source, path } : { kind: 'copy', source, path });
    }

    operations.push(...this.skillOperations(account, directory, layout));
    return operations;
  }

  /**
   * Materialize one account's skills selection: the container, one entry per selected item, and a
   * sweep of everything else.
   *
   * One operation per item rather than one per field, which is the whole of per-item selection at the
   * write layer: two accounts selecting the same item read the same document, so an edit to it reaches
   * both on the next apply, and neither can see what the other also selected. The sweep comes last so
   * its keep list is exactly what the operations above materialized — an item dropped from the
   * selection is removed rather than left behind for the harness to keep running.
   */
  private skillOperations(
    account: ResolvedAccount,
    directory: string,
    layout: FleetLayout,
  ): readonly FleetWriteOperation[] {
    const asset = harnessAsset(this.assets, account.kind, 'skills');
    // A selection this harness has no destination for was already refused by assetOperations.
    if (account.skills === undefined || asset === undefined) return [];

    const container = joinPath(directory, asset.dest);
    const items = plannedSkillItems(account);
    const operations: FleetWriteOperation[] = [
      // Created explicitly rather than left to each item's own write, so the container keeps the
      // account-private mode every other fleet-owned directory has instead of whatever the umask gives
      // it — and so an empty selection still has a directory for the sweep to empty.
      { kind: 'directory', path: container, mode: DIRECTORY_MODE },
    ];
    for (const item of items) {
      const source = expandAssetPath(item.reference, layout.userHome, layout.assetsDirectory);
      const path = joinPath(container, item.name);
      operations.push(asset.mode === 'link' ? { kind: 'symlink', source, path } : { kind: 'copy', source, path });
    }
    operations.push({ kind: 'prune-directory', path: container, keep: items.map(item => item.name) });
    return operations;
  }
}
