/**
 * Shared fleet assets at the daemon boundary: what a caller may see, and what a link derives.
 *
 * The domain lives in `@ferretry/fleet` — which documents are declared, who uses one, and why the
 * history pool is the wrong home for an asset. This module is the two things that belong to the
 * daemon: projecting that report onto the shared wire shapes, and deciding the exact writes a link or
 * unlink asks for **before** anything is written, so the change can be reviewed like any other.
 *
 * Both derivations are refusals-first. A caller names an account, a field and at most a shared name;
 * everything else — which document that name is, whether the field can hold one on this harness,
 * where a private copy goes — is decided here from the configuration the host holds. That is what
 * keeps an unlink a named intent rather than an arbitrary file write wearing one's summary.
 *
 * Pure: no filesystem. The mount reads the shared document's text through the pinned asset store,
 * using the source this module names.
 */
import {
  accountAssetPath,
  canonicalAssetReference,
  accountSharing,
  type AssetSharing,
  type FleetConfig,
  type FleetSharing,
  type LinkableField,
  resolveFleetSharing,
  sharedAssetNameOf,
  sharedAssetNames,
  sharedAssetPath,
  unlinkableReason,
  unreadableSourceReason,
} from '@ferretry/fleet';
import type { FleetAccountSharing, FleetAssetSharing, FleetSharing as FleetWireSharing } from '@ferretry/protocol';
import { FleetMutationRefusal } from './mutations.ts';

const sharingSummaryOf = (sharing: AssetSharing): FleetAssetSharing => {
  if (sharing.state === 'absent') return { state: 'absent' };
  if (sharing.state === 'selection') {
    return {
      state: 'selection',
      origin: sharing.origin,
      items: sharing.items.map(item => ({
        name: item.name,
        path: item.path,
        // Omitted rather than sent as null, because the wire schema states absence by absence — an
        // item with no shared name is account-local, and there is no name to render for it.
        ...(item.sharedName === undefined ? {} : { sharedName: item.sharedName }),
        referrers: item.referrers,
      })),
    };
  }
  if (sharing.state === 'shared') {
    return {
      state: 'shared',
      name: sharing.name,
      path: sharing.path,
      origin: sharing.origin,
      referrers: sharing.referrers,
    };
  }
  return { state: 'local', path: sharing.path, origin: sharing.origin, referrers: sharing.referrers };
};

const accountSummary = (account: FleetSharing['accounts'][number]): FleetAccountSharing => ({
  accountId: account.accountId,
  kind: account.kind,
  wrapper: account.wrapper,
  displayName: account.displayName,
  fields: {
    memory: sharingSummaryOf(account.fields.memory),
    skills: sharingSummaryOf(account.fields.skills),
    hooks: sharingSummaryOf(account.fields.hooks),
    hooksDir: sharingSummaryOf(account.fields.hooksDir),
    mcp: sharingSummaryOf(account.fields.mcp),
  },
  settings: account.settings.map(layer =>
    layer.kind === 'inline'
      ? { position: layer.position, kind: 'inline' as const, origin: layer.origin }
      : {
          position: layer.position,
          kind: 'document' as const,
          path: layer.path,
          ...(layer.name === undefined ? {} : { name: layer.name }),
          origin: layer.origin,
          referrers: layer.referrers,
        },
  ),
  linkable: [...account.linkable],
});

/** The sharing report as the wire states it. */
export function sharingSummary(sharing: FleetSharing): FleetWireSharing {
  return {
    documents: sharing.documents.map(document => ({
      field: document.field,
      name: document.name,
      path: document.path,
      accounts: [...document.accounts],
    })),
    accounts: sharing.accounts.map(accountSummary),
  };
}

/** One account's report, refusing rather than answering for an account this fleet does not declare. */
function requireAccount(config: FleetConfig, accountId: string): FleetSharing['accounts'][number] {
  const account = accountSharing(resolveFleetSharing(config), accountId);
  if (account === undefined) throw new FleetMutationRefusal(`this fleet declares no account with id "${accountId}"`);
  return account;
}

/**
 * Refuse a field this account's harness has no destination for.
 *
 * Checked here rather than left to the plan builder, which would also refuse it — but only after a
 * proposal had been stored and previewed, with the refusal naming an unsupported asset rather than the
 * control the person clicked.
 */
function assertLinkable(account: FleetSharing['accounts'][number], field: LinkableField): void {
  if (account.linkable.includes(field)) return;
  throw new FleetMutationRefusal(
    `the ${account.kind} harness has no destination for "${field}", so ${account.wrapper} cannot link one`,
  );
}

/** The path a link will point an account at, refusing a name this fleet does not declare. */
export function sharedAssetLinkPath(
  config: FleetConfig,
  accountId: string,
  field: LinkableField,
  name: string,
): string {
  const account = requireAccount(config, accountId);
  assertLinkable(account, field);
  const path = sharedAssetPath(config, field, name);
  if (path !== undefined) return path;
  const declared = sharedAssetNames(config, field);
  throw new FleetMutationRefusal(
    declared.length === 0
      ? `this fleet declares no shared "${field}" document; declare one under shared.${field} first`
      : `this fleet declares no shared "${field}" document named "${name}"; it has ${declared.map(entry => `"${entry}"`).join(', ')}`,
  );
}

/** Everything an unlink writes, decided from the configuration before anything is read. */
export interface SharedAssetUnlink {
  readonly field: LinkableField;
  /** The shared document being left, as declared. Read for its text, never modified. */
  readonly source: string;
  /** Where this account's own copy goes, asset-relative. */
  readonly destination: string;
  /** The shared name being left, for the summary a person approves. */
  readonly name: string;
  readonly wrapper: string;
}

/**
 * What an unlink would write, or a refusal naming exactly why it cannot.
 *
 * Five refusals, each about a different thing being absent or impossible: the field holds nothing to
 * unlink, it already holds this account's own path, it names a directory the reviewed asset editor
 * cannot copy, the shared document sits outside the asset tree and cannot be read here, or the copy's
 * destination is itself a declared shared document. Every one is decided before a proposal exists.
 */
export function planSharedAssetUnlink(config: FleetConfig, accountId: string, field: LinkableField): SharedAssetUnlink {
  const account = requireAccount(config, accountId);
  assertLinkable(account, field);
  const current = account.fields[field];
  if (current.state === 'absent') {
    throw new FleetMutationRefusal(
      `${account.wrapper} declares no "${field}", so there is nothing to unlink; link a shared document first`,
    );
  }
  if (current.state === 'local') {
    throw new FleetMutationRefusal(
      `${account.wrapper} already uses its own "${field}" at "${current.path}" rather than a shared document`,
    );
  }
  if (current.state === 'selection') {
    // Refused ahead of the directory refusal below, which would also refuse it but for the shallower
    // reason. "Give this account its own copy" has no referent for a selection: there is no one
    // document being left, and each item is separately shared or not. Dropping an item is a list edit.
    throw new FleetMutationRefusal(
      `"${field}" holds a per-item selection rather than one document, so there is nothing for ${account.wrapper} to take a private copy of; add or drop items in this account's own layer instead`,
    );
  }
  const directory = unlinkableReason(field);
  if (directory !== undefined) throw new FleetMutationRefusal(directory);
  const unreadable = unreadableSourceReason(current.path);
  if (unreadable !== undefined) throw new FleetMutationRefusal(unreadable);
  const destination = accountAssetPath(account.wrapper, current.path);
  // A destination the registry has already promised to everybody is the one path this must not write.
  // The file may not exist yet — a declared document nobody has created — so nothing later would catch
  // it, and seeding it here would turn one account's private copy into what every account linking that
  // name receives. That is the exact inversion of what "give this account its own copy" asked for.
  const promised = sharedAssetNameOf(config, field, destination);
  if (promised !== undefined) {
    throw new FleetMutationRefusal(
      `the private copy would be written to "${destination}", which this fleet declares as the shared "${promised}" ${field} document; give that shared document a path of its own first`,
    );
  }
  return {
    field,
    // Canonical, because a configuration and the asset editor spell the same document differently. The
    // starter writes `./CLAUDE.md`; the editor's grammar refuses a `.` segment outright, so reading the
    // source as declared would fail on every host the starter created — with a refusal about a path
    // traversal, for a document sitting in the middle of the asset tree.
    source: canonicalAssetReference(current.path),
    destination,
    name: current.name,
    wrapper: account.wrapper,
  };
}
