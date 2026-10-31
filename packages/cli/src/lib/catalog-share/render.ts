import type {
  CatalogMemberCatalogRemoved,
  CatalogMemberKeyRemoved,
  CatalogMemberList,
  CatalogMemberRevoked,
  CatalogMemberView,
  CatalogShareList,
  CatalogShareMintResponse,
  CatalogShareView,
  OwnedCatalog,
} from '@ferretry/protocol';
import { QR_INDENT, qrColumns, qrFitsTerminal } from '../pair/qr.ts';

const INDENT = '  ';
const QR_PAD = ' '.repeat(QR_INDENT);

const plural = (count: number, singular: string): string => `${count} ${count === 1 ? singular : `${singular}s`}`;

/** The name a catalog goes by in this list, or its id when this machine no longer has it. */
function catalogNames(ids: readonly string[], catalogs: readonly OwnedCatalog[]): string {
  if (ids.length === 0) return 'no catalogs';
  return ids.map(id => catalogs.find(catalog => catalog.id === id)?.name ?? id).join(', ');
}

function usesText(share: CatalogShareView): string {
  return share.uses.kind === 'single' ? 'single use' : `${share.usedBy.length} of ${share.uses.cap} uses taken`;
}

/** The sentence for a share that may still be used, or how it ended. */
function stateText(share: CatalogShareView): string {
  return share.state === 'live' ? `live until ${share.expiresAt}` : share.state;
}

/** `fy catalog shares`: every share and how it stands. It has no field for a code and never shows one. */
export function renderShareList(list: CatalogShareList, catalogs: readonly OwnedCatalog[]): string {
  if (list.shares.length === 0)
    return 'No shares yet. Make one with: fy catalog share <catalog> --member <name> --expires 1h';
  return list.shares
    .map(share =>
      [
        `${share.shareId} · ${share.memberLabel} (${share.memberId}) · ${stateText(share)}`,
        `${INDENT}${catalogNames(share.catalogIds, catalogs)} · ${usesText(share)}`,
        ...share.usedBy.map(use => `${INDENT}used by ${use.clientName} (${use.keyId}) at ${use.at}`),
      ].join('\n'),
    )
    .join('\n\n');
}

function renderMember(member: CatalogMemberView, catalogs: readonly OwnedCatalog[]): string {
  const keys =
    member.keys.length === 0
      ? [`${INDENT}no browsers`]
      : member.keys.map(key => {
          const seen = key.lastSeenAt === undefined ? 'never seen' : `last seen ${key.lastSeenAt}`;
          const window =
            key.passkeyWindowEndsAt === undefined ? '' : ` · may register a passkey until ${key.passkeyWindowEndsAt}`;
          return `${INDENT}${key.clientName} (${key.keyId}) · joined ${key.joinedAt} · ${seen} · ${plural(key.passkeys, 'passkey')}${window}`;
        });
  return [
    `${member.label} (${member.memberId}) · since ${member.createdAt}`,
    `${INDENT}reads: ${catalogNames(member.catalogIds, catalogs)}`,
    ...keys,
  ].join('\n');
}

/** `fy member ls`. */
export function renderMemberList(list: CatalogMemberList, catalogs: readonly OwnedCatalog[]): string {
  if (list.members.length === 0)
    return 'Nobody has joined yet. Share a catalog with: fy catalog share <catalog> --member <name> --expires 1h';
  return list.members.map(member => renderMember(member, catalogs)).join('\n\n');
}

export function renderShareEnded(share: CatalogShareView): string {
  return `Ended share ${share.shareId} for ${share.memberLabel}. Its code no longer works.`;
}

export function renderMemberRenamed(member: CatalogMemberView): string {
  return `${member.memberId} is now called ${member.label}.`;
}

export function renderMemberRevoked(label: string, revoked: CatalogMemberRevoked): string {
  return (
    `Removed ${label} (${revoked.memberId}): ${plural(revoked.keysRemoved, 'browser')} signed out, ` +
    `${plural(revoked.sharesEnded, 'share')} ended.`
  );
}

export function renderKeyRemoved(label: string, removed: CatalogMemberKeyRemoved): string {
  return `Removed browser ${removed.keyId} of ${label}. Their other browsers still work.`;
}

export function renderCatalogTaken(label: string, catalogName: string, removed: CatalogMemberCatalogRemoved): string {
  return `${label} (${removed.memberId}) can no longer read ${catalogName} (${removed.catalogId}).`;
}

/** What opening a link lets the opener do, said when the owner shares to someone who already has access. */
export function existingMemberWarning(label: string): string {
  return `Whoever opens this link can read everything ${label} can read, on top of what you are sharing now.`;
}

export interface MintScreen {
  readonly mint: CatalogShareMintResponse;
  readonly catalogs: readonly OwnedCatalog[];
  /** The QR for the link, or nothing when it was not drawn. */
  readonly qr: string | undefined;
  readonly columns: number | undefined;
  readonly warning: string | undefined;
  readonly binaryName: string;
}

function qrBlock(qr: string, columns: number | undefined): string {
  if (columns !== undefined && !qrFitsTerminal(qr, columns)) {
    return `${QR_PAD}The QR needs ${qrColumns(qr) + QR_INDENT} columns and this window has ${columns}, so it is not drawn — a QR that wraps cannot be scanned. Widen the window, or send the link below.`;
  }
  return qr
    .split('\n')
    .map(line => `${QR_PAD}${line}`)
    .join('\n');
}

/**
 * The one screen that shows a share's link. The daemon keeps only the code's hash, so this is the only time it is
 * shown: nothing else here, and no later command, can print it again.
 */
export function renderMint(screen: MintScreen): string {
  const { mint } = screen;
  const share = mint.share;
  return [
    `Share link for ${share.memberLabel}: ${catalogNames(share.catalogIds, screen.catalogs)}`,
    `${stateText(share)} · ${usesText(share)}`,
    ...(screen.warning === undefined ? [] : ['', `WARNING: ${screen.warning}`]),
    ...(screen.qr === undefined ? [] : ['', qrBlock(screen.qr, screen.columns)]),
    '',
    mint.link,
    '',
    `This is the only time the link is shown. Lost it? End the share with \`${screen.binaryName} catalog unshare ${share.shareId}\` and make a new one.`,
  ].join('\n');
}
