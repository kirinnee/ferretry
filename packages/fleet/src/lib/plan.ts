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
  type AssetField,
  HARNESS_ASSETS,
  harnessAsset,
  type HarnessAssetTable,
  unsupportedAssetFields,
} from './assets.ts';
import { UnimplementedFleetCapabilityError, unimplementedCapabilities } from './capabilities.ts';
import type { FleetConfig } from './config.ts';
import { buildFleetManifest, type FleetManifest, type HarnessKind } from './manifest.ts';
import { expandAssetPath, expandHomePath, joinPath } from './paths.ts';
import { type ResolvedAccount, resolveAccounts, resolveCommands, toManifestAccounts } from './profiles.ts';
import type {
  FleetApplyPlan,
  FleetLayout,
  FleetPlanBuilder,
  FleetWriteOperation,
  SettingsLayerSource,
} from './provisioning.ts';
import { MANAGED_MARKER, renderCommandScript, renderWrapperScript, resolveCommandTargets } from './wrappers.ts';

/** Directories the fleet owns are private: they hold credentials and generated executables. */
const DIRECTORY_MODE = 0o700;
const EXECUTABLE_MODE = 0o755;
const SETTINGS_MODE = 0o600;

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

/** The path-valued asset fields, in the order they are materialized. */
const PATH_ASSET_FIELDS = ['memory', 'skills', 'hooks', 'hooksDir', 'mcp'] as const satisfies readonly AssetField[];

/**
 * Asset fields this account actually asks for. `settings` is a layer stack rather than a path, so
 * "declared" means a non-empty stack; every other field is declared when it names something.
 */
export function declaredAssetFields(account: ResolvedAccount): readonly AssetField[] {
  const declared: AssetField[] = [];
  if (account.settings.length > 0) declared.push('settings');
  for (const field of PATH_ASSET_FIELDS) {
    if (account[field] !== undefined) declared.push(field);
  }
  return declared;
}

export class FleetPlan implements FleetPlanBuilder {
  /** The destination table is a policy, so it is injected rather than reached for. */
  constructor(private readonly assets: HarnessAssetTable = HARNESS_ASSETS) {}

  build(config: FleetConfig, layout: FleetLayout, generatedAt: string): FleetApplyPlan {
    // Before anything is planned: a configuration asking for something this build does not do is
    // refused here rather than applied and quietly not done. It is a planning-time check because
    // `--dry-run` must refuse it too — a dry run that printed a clean plan for a configuration a
    // real apply could not honour would be the misleading half of the same bug.
    const unimplemented = unimplementedCapabilities(config);
    if (unimplemented.length > 0) throw new UnimplementedFleetCapabilityError(unimplemented);

    const accounts = resolveAccounts(config).map(account => ({
      ...account,
      // The wrapper script keeps the *declared* home so `~/x` stays portable across machines; the
      // filesystem and the manifest need the expanded one. Both name the same directory.
      resolvedHome: expandHomePath(account.home, layout.userHome, layout.homesDirectory),
    }));
    // resolveCommands throws on a name two generators would claim, before anything is planned.
    const commands = resolveCommands(config, accounts);
    const targets = resolveCommandTargets(commands, accounts, layout.binDirectory);

    const operations: FleetWriteOperation[] = [
      { kind: 'directory', path: layout.fleetDirectory, mode: DIRECTORY_MODE },
      { kind: 'directory', path: layout.binDirectory, mode: DIRECTORY_MODE },
      { kind: 'directory', path: layout.homesDirectory, mode: DIRECTORY_MODE },
    ];

    for (const account of accounts) {
      operations.push({ kind: 'directory', path: account.resolvedHome, mode: DIRECTORY_MODE });
      operations.push(...this.assetOperations(account, account.resolvedHome, layout));
      operations.push({
        kind: 'file',
        path: joinPath(layout.binDirectory, account.wrapper),
        content: renderWrapperScript(account, { secretsFile: config.secretsFile }),
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
      operations.push(...this.assetOperations(account, directory, layout));
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

    return { manifest, manifestPath: layout.manifestPath, operations };
  }

  /** Materialize one account's profile assets into `directory`. */
  private assetOperations(
    account: ResolvedAccount,
    directory: string,
    layout: FleetLayout,
  ): readonly FleetWriteOperation[] {
    const unsupported = new Set(unsupportedAssetFields(this.assets, account.kind));
    for (const field of declaredAssetFields(account)) {
      if (unsupported.has(field)) throw new UnsupportedAssetError(account.id, account.kind, field);
    }

    const operations: FleetWriteOperation[] = [];
    const settings = harnessAsset(this.assets, account.kind, 'settings');
    if (settings?.format !== undefined && account.settings.length > 0) {
      const layers: readonly SettingsLayerSource[] = account.settings.map(layer =>
        typeof layer === 'string'
          ? { from: 'file', path: expandAssetPath(layer, layout.userHome, layout.assetsDirectory) }
          : { from: 'inline', settings: layer },
      );
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

    return operations;
  }
}
