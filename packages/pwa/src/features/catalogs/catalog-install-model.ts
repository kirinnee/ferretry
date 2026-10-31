/**
 * Installing from a catalog file: what the person picks, what must be true before Install lights up,
 * and what each refusal says. Pure functions over what the file and the installing machine answered.
 *
 * THE MACHINE ANSWERS THE REVIEW AND THE APP SHOWS IT. The signature check here runs before anything
 * is shown, and this machine's daemon runs it again before it writes anything.
 */

import {
  type CatalogInstall,
  type CatalogInstallPreview,
  type CatalogInstallPreviewRequest,
  type CatalogInstallRequest,
  type CatalogSecretBindings,
  isSignInSecretName,
  readSharedCatalogFile,
  SHARED_CATALOG_FILE_MAX_BYTES,
  type SecretList,
  type SharedCatalogFile,
  type SharedCatalogManifest,
  type SharedCatalogManifestEntry,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { type CatalogVerificationRefusal, type RelayCrypto, verifySharedCatalogFile } from '@ferretry/relay';
import { changeRefusalSentence } from '../fleet/shell/apply-change.ts';
import { plural } from './catalog-review-model.ts';

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

export const INSTALL_BUTTON = 'Install · confirm with passkey';
export const NO_AUTO_UPDATE = 'It will not update by itself. You will be asked, with a diff.';
export const FIRST_INSTALL_NOTE = 'First install from this publisher. Check the fingerprint with them if this matters.';
export const LEAVE_UNBOUND = 'Leave unbound';
export const CHOOSE_PLACEHOLDER = 'Choose…';
export const EXPIRY_NOTE = 'This preview lasts 10 minutes. After that, preview it again.';

// ── Opening a file ───────────────────────────────────────────────────────────────────────────────

/** The sentence for a file over the size bound, or `null`. Checked on `File.size`, before reading a byte. */
export function fileSizeProblem(size: number): string | null {
  return size > SHARED_CATALOG_FILE_MAX_BYTES ? 'This file is larger than 32 MiB, so it was not read.' : null;
}

const VERIFICATION_SENTENCES: Readonly<Record<CatalogVerificationRefusal, string>> = {
  signature_invalid: 'This file was not signed by the machine it names, so it was not opened. Nothing was installed.',
  item_mismatch:
    'An item in this file is not the one its signed list describes, so it was not opened. Nothing was installed.',
  not_canonical: 'An item in this file cannot be checked, so it was not opened. Nothing was installed.',
  manifest_invalid: 'The signed list in this file is not valid, so it was not opened. Nothing was installed.',
};

export interface OpenedCatalogFile {
  readonly file: SharedCatalogFile;
  readonly manifest: SharedCatalogManifest;
}

export type OpenResult =
  | { readonly ok: true; readonly opened: OpenedCatalogFile }
  | { readonly ok: false; readonly sentence: string };

/** Reads the text, then checks the signature and every item it carries. Nothing is shown before both pass. */
export async function openCatalogFile(text: string, crypto: RelayCrypto): Promise<OpenResult> {
  const read = readSharedCatalogFile(text);
  if (!read.ok) return { ok: false, sentence: read.reason };
  const verified = await verifySharedCatalogFile(crypto, read.file);
  if (!verified.ok) return { ok: false, sentence: VERIFICATION_SENTENCES[verified.refusal] };
  return { ok: true, opened: { file: read.file, manifest: verified.value } };
}

// ── Items in the file ────────────────────────────────────────────────────────────────────────────

export interface FileItemRow {
  readonly entry: SharedCatalogManifestEntry;
  /** Why it cannot be picked, or `null`. */
  readonly unavailable: string | null;
}

/** Every item the signed list names. One the file does not carry is listed but cannot be picked. */
export function fileItemRows(opened: OpenedCatalogFile): readonly FileItemRow[] {
  const carried = new Set(opened.file.items.map(item => item.itemId));
  return opened.manifest.items.map(entry => ({
    entry,
    unavailable: carried.has(entry.itemId) ? null : 'This file does not carry this item.',
  }));
}

/** How many items the publisher took out, or `null` when none. They are not listed: they cannot be installed. */
export function withdrawnNote(opened: OpenedCatalogFile): string | null {
  const count = opened.manifest.withdrawn.length;
  return count === 0 ? null : `${plural(count, 'item')} withdrawn by the publisher, so not listed.`;
}

export function fileSummary(opened: OpenedCatalogFile): string {
  const { manifest } = opened;
  return `${manifest.name} · ${plural(manifest.items.length, 'item')}`;
}

// ── Where it lands ───────────────────────────────────────────────────────────────────────────────

export interface TargetOptions {
  readonly projects: readonly { readonly root: string; readonly label: string }[];
  readonly runtimes: readonly { readonly runtime: string; readonly profiles: readonly string[] }[];
}

export type TargetPick =
  | { readonly scope: 'project'; readonly projectRoot: string; readonly harness: 'claude' | 'codex' }
  | { readonly scope: 'runtime'; readonly runtime: string; readonly profile: string };

/** What the person has chosen so far. Every field may still be missing. */
export interface TargetDraft {
  readonly scope?: 'project' | 'runtime';
  readonly projectRoot?: string;
  readonly harness?: 'claude' | 'codex';
  readonly runtime?: string;
  readonly profile?: string;
}

export function targetProblem(draft: TargetDraft | null, options: TargetOptions): string | null {
  if (draft === null || draft.scope === undefined) return 'Pick where to install it.';
  if (draft.scope === 'project') {
    if (!options.projects.some(project => project.root === draft.projectRoot)) return 'Pick a project.';
    return draft.harness === undefined ? 'Pick Claude or Codex for this project.' : null;
  }
  const runtime = options.runtimes.find(candidate => candidate.runtime === draft.runtime);
  if (runtime === undefined) return 'Pick a runtime.';
  return draft.profile !== undefined && runtime.profiles.includes(draft.profile) ? null : 'Pick a profile.';
}

/** The wire target for a draft that passed {@link targetProblem}, else `null`. */
export function toTarget(draft: TargetDraft): TargetPick | null {
  if (draft.scope === 'project')
    return draft.projectRoot === undefined || draft.harness === undefined
      ? null
      : { scope: 'project', projectRoot: draft.projectRoot, harness: draft.harness };
  if (draft.scope === 'runtime')
    return draft.runtime === undefined || draft.profile === undefined
      ? null
      : { scope: 'runtime', runtime: draft.runtime, profile: draft.profile };
  return null;
}

/** The request the preview route takes, or `null` when the file does not carry that item. */
export function previewRequest(
  opened: OpenedCatalogFile,
  itemId: string,
  target: TargetPick,
  allowOlder: boolean,
): CatalogInstallPreviewRequest | null {
  const item = opened.file.items.find(candidate => candidate.itemId === itemId);
  if (item === undefined) return null;
  return {
    signedManifest: opened.file.signedManifest,
    item,
    target,
    ...(allowOlder ? { allowOlder: true as const } : {}),
  };
}

// ── The secrets ──────────────────────────────────────────────────────────────────────────────────

/** `undefined`: nothing chosen yet. `null`: "Leave unbound", chosen. A string: one of this machine's own secrets. */
export type BindingPicks = Readonly<Record<string, string | null | undefined>>;

/** The names this machine can offer: its own secrets, never a sign-in token. Empty when its list could not be read. */
export function bindableSecretNames(list: SecretList | null): readonly string[] {
  if (list === null || list.health !== 'ready') return [];
  return list.secrets
    .map(secret => secret.name)
    .filter(name => !isSignInSecretName(name))
    .toSorted((left, right) => left.localeCompare(right));
}

/** The placeholders still waiting for an explicit choice. */
export function unchosenPlaceholders(preview: CatalogInstallPreview, picks: BindingPicks): readonly string[] {
  return preview.secrets.map(secret => secret.placeholder).filter(placeholder => picks[placeholder] === undefined);
}

export function pickBinding(picks: BindingPicks, placeholder: string, choice: string | null): BindingPicks {
  return { ...picks, [placeholder]: choice };
}

export function unpickBinding(picks: BindingPicks, placeholder: string): BindingPicks {
  const { [placeholder]: _dropped, ...rest } = picks;
  return rest;
}

/** What shows under a pick. Nothing before a choice: no default is ever assumed. */
export function bindingNote(choice: string | null | undefined): string | null {
  if (choice === undefined) return null;
  return choice === null
    ? 'Left unbound. The program runs without it unless its own environment already has it.'
    : `This program will receive your secret ${choice}.`;
}

/** The hint beside a placeholder, only when the daemon said whether this machine holds a secret by that name. */
export function heldHint(held: boolean | undefined): string | null {
  if (held === undefined) return null;
  return held ? 'You have a secret with this name. It is not used unless you pick it.' : null;
}

export interface InstallState {
  readonly enabled: boolean;
  /** Why it is disabled, in words next to the button. */
  readonly reason: string | null;
}

export function installState(preview: CatalogInstallPreview | null, picks: BindingPicks, busy: boolean): InstallState {
  if (preview === null) return { enabled: false, reason: 'Read the review first.' };
  const waiting = unchosenPlaceholders(preview, picks);
  if (waiting.length > 0)
    return {
      enabled: false,
      reason: `Choose a secret, or Leave unbound, for ${waiting.join(', ')}.`,
    };
  return { enabled: !busy, reason: null };
}

/** The apply request, or `null` while any placeholder lacks a choice. */
export function installRequest(preview: CatalogInstallPreview, picks: BindingPicks): CatalogInstallRequest | null {
  if (unchosenPlaceholders(preview, picks).length > 0) return null;
  const secretBindings: CatalogSecretBindings = Object.fromEntries(
    preview.secrets.map(secret => [secret.placeholder, picks[secret.placeholder] ?? null]),
  );
  return { previewId: preview.previewId, secretBindings };
}

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────────

export interface InstallRefusal {
  readonly sentence: string;
  /** The preview is gone or stale: offer "Preview again". */
  readonly previewAgain: boolean;
  /** The version is older than the one installed: offer "Install the older version anyway". */
  readonly olderOffered: boolean;
}

const INSTALL_REFUSALS: Readonly<Record<string, string>> = {
  catalog_signature_invalid: 'This catalog was not signed by the machine it names. Nothing was installed.',
  catalog_item_mismatch: 'This item is not the version the signed list describes. Nothing was installed.',
  catalog_publisher_changed:
    'You installed from this catalog before, from a different machine. This file says it is the same catalog. Nothing was installed. Ask the publisher which machine is right.',
  catalog_revision_older:
    'You have already seen a newer copy of this catalog. This file is older. Nothing was installed.',
  catalog_downgrade: 'This is an older version than the one you have. Nothing was installed.',
  catalog_item_invalid: 'This item breaks a safety rule, so it cannot be installed.',
  catalog_not_installable: 'This item cannot be installed here.',
  catalog_target_unknown: 'This machine does not know that project, runtime or profile. Pick another place.',
  catalog_preview_unknown: 'That preview is gone. Nothing was installed. Preview it again.',
  catalog_preview_expired: 'That preview ran out after 10 minutes. Nothing was installed. Preview it again.',
  catalog_bindings_invalid: 'The secrets you chose do not fit this item. Nothing was installed.',
  catalog_install_conflict:
    'Something is already where this would go, and this install did not put it there. Or it was edited here since. Nothing was changed.',
  catalog_install_unknown: 'That install is already gone.',
  grant_step_up_required:
    'Nothing was installed: the passkey wasn’t confirmed. Press Install and confirm again. Each install needs its own passkey.',
};

/** Codes whose own message names the specific reason, so it follows the general sentence. */
const WITH_REASON = new Set([
  'catalog_item_invalid',
  'catalog_not_installable',
  'catalog_target_unknown',
  'catalog_bindings_invalid',
  'catalog_install_conflict',
]);

export function installRefusal(error: unknown): InstallRefusal {
  const code = error instanceof FyHttpError ? error.code : undefined;
  const known = code === undefined ? undefined : INSTALL_REFUSALS[code];
  const reason =
    error instanceof FyHttpError && code !== undefined && WITH_REASON.has(code) ? error.message.trim() : '';
  return {
    sentence: known === undefined ? changeRefusalSentence(error) : reason === '' ? known : `${known} ${reason}`,
    previewAgain: code === 'catalog_preview_unknown' || code === 'catalog_preview_expired',
    olderOffered: code === 'catalog_downgrade',
  };
}

// ── What is installed ────────────────────────────────────────────────────────────────────────────

/** "From Team skills (kirin-box)" */
export function installedFromLine(install: Pick<CatalogInstall, 'provenance'>): string {
  return `From ${install.provenance.catalogName} (${install.provenance.publisherName})`;
}

/** The installs that wrote this skill or server by name. A row shows each one it matches. */
export function installsFor(
  installs: readonly CatalogInstall[],
  kind: 'skill' | 'mcp',
  name: string,
): readonly CatalogInstall[] {
  return installs.filter(install => install.provenance.kind === kind && install.provenance.name === name);
}

export const REMOVE_NOTE = 'This takes out what the install wrote. Your other files are not touched.';
