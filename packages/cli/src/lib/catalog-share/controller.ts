import {
  CATALOG_SHARE_EXPIRIES,
  CATALOG_SHARE_MULTI_CAP_DEFAULT,
  CATALOG_SHARE_MULTI_CAP_MAX,
  type CatalogShareExpiry,
  type CatalogShareMintRequest,
  type OwnedCatalog,
} from '@ferretry/protocol';
import type { ICatalogGateway, ICatalogOutput, ICatalogPrompt } from '../catalog/ports.ts';
import { resolveCatalog } from '../catalog/resolve.ts';
import type { IQrEncoder, ITerminalSize } from '../pair/ports.ts';
import type { ISharingGateway, IShareScreen } from './ports.ts';
import {
  existingMemberWarning,
  renderCatalogTaken,
  renderKeyRemoved,
  renderMemberList,
  renderMemberRenamed,
  renderMemberRevoked,
  renderMint,
  renderShareEnded,
  renderShareList,
} from './render.ts';
import { resolveKey, resolveMember } from './resolve.ts';

export interface ShareCommandOptions {
  readonly json?: boolean;
}

export interface ConfirmedShareOptions extends ShareCommandOptions {
  readonly yes?: boolean;
}

export interface ShareMintOptions extends ConfirmedShareOptions {
  /** A new person's name. */
  readonly member?: string;
  /** A person who is already a member: their id or name. */
  readonly to?: string;
  readonly expires?: string;
  readonly multi?: boolean;
  readonly cap?: string;
  readonly large?: boolean;
}

export interface ShareDeps {
  readonly sharing: ISharingGateway;
  readonly catalogs: Pick<ICatalogGateway, 'list'>;
  readonly out: ICatalogOutput;
  readonly screen: IShareScreen;
  readonly qr: IQrEncoder;
  readonly terminal: ITerminalSize;
  readonly prompt: ICatalogPrompt;
  readonly interactive: boolean;
  readonly binaryName: string;
}

const AFFIRMATIVE = /^y(?:es)?$/iu;

function expiry(text: string | undefined): CatalogShareExpiry {
  const found = CATALOG_SHARE_EXPIRIES.find(candidate => candidate === text);
  if (found === undefined)
    throw new Error(`say how long the link lives: --expires ${CATALOG_SHARE_EXPIRIES.join('|')}`);
  return found;
}

function cap(options: ShareMintOptions): number {
  if (options.cap === undefined) return CATALOG_SHARE_MULTI_CAP_DEFAULT;
  const parsed = Number(options.cap);
  if (!Number.isInteger(parsed) || parsed < 2 || parsed > CATALOG_SHARE_MULTI_CAP_MAX)
    throw new Error(`--cap is a whole number from 2 to ${CATALOG_SHARE_MULTI_CAP_MAX}`);
  return parsed;
}

/**
 * Drives `fy catalog share|shares|unshare` and `fy member …`: who a catalog is shared with, and the codes that let
 * them in.
 *
 * THE LINK IS PRINTED ONCE. The daemon keeps only the code's SHA-256, so the mint's answer is the only place a code or
 * link exists; every other command here prints from views that have no field for one.
 */
export class ShareController {
  constructor(private readonly deps: ShareDeps) {}

  async share(catalogs: readonly string[], options: ShareMintOptions): Promise<void> {
    if (catalogs.length === 0) throw new Error('say which catalog to share');
    if ((options.member === undefined) === (options.to === undefined))
      throw new Error(
        'say who it is for: --member <new name> for a new person, or --to <id or name> for one who has joined',
      );
    if (options.multi !== true && options.cap !== undefined) throw new Error('--cap needs --multi');
    if (options.multi === true && options.member === undefined)
      throw new Error('a link for many people makes its own member: name it with --member');
    const expiresIn = expiry(options.expires);
    const owned = (await this.deps.catalogs.list()).catalogs;
    const ids = [...new Set(catalogs.map(wanted => resolveCatalog(owned, wanted).id))];
    const member = await this.#recipient(options);
    const request: CatalogShareMintRequest = {
      catalogIds: ids,
      member: member.target,
      expiresIn,
      uses: options.multi === true ? { kind: 'multi', cap: cap(options) } : { kind: 'single' },
    };
    // The warning comes BEFORE the link exists: once minted, the link is live and cannot be taken back unseen.
    if (member.warning !== undefined)
      await this.#confirm(`${member.warning} Make the link for ${member.label}?`, options);
    const mint = await this.deps.sharing.mint(request);
    if (options.json === true) {
      this.deps.out.success(JSON.stringify(mint, null, 2));
      return;
    }
    const qr = await this.deps.qr.encode(mint.link, options.large === true ? 'large' : 'compact');
    this.deps.screen.write(
      renderMint({
        mint,
        catalogs: owned,
        qr,
        columns: this.deps.terminal.columns(),
        warning: member.warning,
        binaryName: this.deps.binaryName,
      }),
    );
  }

  async shares(options: ShareCommandOptions): Promise<void> {
    const list = await this.deps.sharing.shares();
    const owned = options.json === true ? [] : (await this.deps.catalogs.list()).catalogs;
    this.#report(list, options, () => renderShareList(list, owned));
  }

  async unshare(shareId: string, options: ShareCommandOptions): Promise<void> {
    const ended = await this.deps.sharing.endShare(shareId.trim());
    this.#report(ended, options, () => renderShareEnded(ended));
  }

  async members(options: ShareCommandOptions): Promise<void> {
    const list = await this.deps.sharing.members();
    const owned = options.json === true ? [] : (await this.deps.catalogs.list()).catalogs;
    this.#report(list, options, () => renderMemberList(list, owned));
  }

  async rename(member: string, label: string, options: ShareCommandOptions): Promise<void> {
    const found = await this.#member(member);
    const renamed = await this.deps.sharing.renameMember(found.memberId, label.trim());
    this.#report(renamed, options, () => renderMemberRenamed(renamed));
  }

  async revoke(member: string, options: ConfirmedShareOptions): Promise<void> {
    const found = await this.#member(member);
    await this.#confirm(
      `Remove ${found.label} (${found.memberId}), sign out their ${found.keys.length} browser(s) and end their shares?`,
      options,
    );
    const revoked = await this.deps.sharing.revokeMember(found.memberId);
    this.#report(revoked, options, () => renderMemberRevoked(found.label, revoked));
  }

  async forgetKey(member: string, key: string, options: ConfirmedShareOptions): Promise<void> {
    const found = await this.#member(member);
    const browser = resolveKey(found, key);
    await this.#confirm(`Remove ${browser.clientName} (${browser.keyId}) from ${found.label}?`, options);
    const removed = await this.deps.sharing.removeKey(found.memberId, browser.keyId);
    this.#report(removed, options, () => renderKeyRemoved(found.label, removed));
  }

  async take(member: string, catalog: string, options: ConfirmedShareOptions): Promise<void> {
    const found = await this.#member(member);
    const owned = (await this.deps.catalogs.list()).catalogs;
    const target = this.#heldCatalog(found.catalogIds, owned, catalog);
    await this.#confirm(`Stop ${found.label} reading ${target.name} (${target.id})?`, options);
    const removed = await this.deps.sharing.removeCatalog(found.memberId, target.id);
    this.#report(removed, options, () => renderCatalogTaken(found.label, target.name, removed));
  }

  /** A catalog the member holds: by id, or by name among the catalogs this machine still has. */
  #heldCatalog(held: readonly string[], owned: readonly OwnedCatalog[], wanted: string): { id: string; name: string } {
    const trimmed = wanted.trim();
    if (held.includes(trimmed))
      return { id: trimmed, name: owned.find(entry => entry.id === trimmed)?.name ?? trimmed };
    const found = resolveCatalog(
      owned.filter(entry => held.includes(entry.id)),
      trimmed,
    );
    return { id: found.id, name: found.name };
  }

  async #member(wanted: string) {
    return resolveMember((await this.deps.sharing.members()).members, wanted);
  }

  async #recipient(
    options: ShareMintOptions,
  ): Promise<{ target: CatalogShareMintRequest['member']; warning: string | undefined; label: string }> {
    if (options.member !== undefined)
      return {
        target: { kind: 'new', label: options.member.trim() },
        warning: undefined,
        label: options.member.trim(),
      };
    const found = await this.#member(options.to ?? '');
    return {
      target: { kind: 'existing', memberId: found.memberId },
      warning: existingMemberWarning(found.label),
      label: found.label,
    };
  }

  async #confirm(question: string, options: ConfirmedShareOptions): Promise<void> {
    if (options.yes === true) return;
    if (!this.deps.interactive) throw new Error('nobody to ask on this terminal — pass --yes to go ahead');
    const answer = await this.deps.prompt.ask(`${question} [y/N]`);
    if (!AFFIRMATIVE.test(answer.trim())) throw new Error('cancelled — nothing was changed');
  }

  #report(payload: unknown, options: ShareCommandOptions, human: () => string): void {
    this.deps.out.success(options.json === true ? JSON.stringify(payload, null, 2) : human());
  }
}
