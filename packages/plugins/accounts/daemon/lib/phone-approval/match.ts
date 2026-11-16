/**
 * WHICH SIGN-IN A PHONE APPROVAL IS FOR — decided by the daemon from what IT observed (the page's host, the terminal's
 * `program@host`), never by the ferret. Copied from today's `input-requests/phone-approval.ts` (`match`, `viaChainTo`)
 * and `saved-logins.ts` (`targetMatchKey`, `remoteHostOf`, bb89d054d).
 *
 * TODO(contract): `targetMatchKey` belongs to the Vault's saved-login matcher (it names a terminal's key for the card's
 * offers). An approval keys a terminal the same way, so it is copied here until the Vault's contract exports it.
 */
import type { TerminalFacts } from '@ferretry/core-vault/contract';
import {
  type AccountRef,
  chosenSignIn,
  LoginMatchSchema,
  type PhoneApproval,
  type PhoneApprovalRaise,
  type SignInId,
  type SignInSummary,
} from '../../../contract/routes/index.ts';
import type { SavedListing } from '../vault-inputs.ts';

/** How far a `via` chain is followed: ClickUp via Okta via Google is two hops. */
const VIA_DEPTH = 3;

const REMOTE_PROGRAMS = new Set(['ssh', 'scp', 'sftp']);
/** ssh's options that take a value, so the destination is not mistaken for one. */
const SSH_VALUE_OPTIONS = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''));

function hostPart(word: string | undefined): string | undefined {
  if (word === undefined) return undefined;
  const withoutScheme = word.replace(/^(?:ssh|sftp):\/\//u, '');
  const afterUser = withoutScheme.slice(withoutScheme.lastIndexOf('@') + 1);
  const host = afterUser.replace(/:.*$/u, '').toLowerCase();
  return host === '' ? undefined : host;
}

/** The destination host an ssh-family command line names, lowercased, or `undefined` when it cannot be read. */
function remoteHostOf(argv: string): string | undefined {
  const words = argv.trim().split(/\s+/u).slice(1);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    if (word === '--') return hostPart(words[index + 1]);
    if (word.startsWith('-')) {
      const option = word.slice(1);
      if (option.length === 1 && SSH_VALUE_OPTIONS.has(option)) index += 1;
      continue;
    }
    return hostPart(word);
  }
  return undefined;
}

/** This machine's name as a key uses it: the first label, lowercase. */
function shortHost(hostName: string): string | undefined {
  const host = hostName.trim().toLowerCase().split('.')[0] ?? '';
  return host === '' ? undefined : host;
}

/** A terminal's key: `program@host` of the PROVED foreground program, in line mode only; else nothing to match on. */
export function terminalMatchKey(facts: TerminalFacts, hostName: string): string | undefined {
  const program = facts.program?.trim().toLowerCase();
  if (program === undefined || program === '' || facts.canonical !== true) return undefined;
  const host = REMOTE_PROGRAMS.has(program) ? remoteHostOf(facts.foreground.argv) : shortHost(hostName);
  const key = host === undefined ? undefined : `${program}@${host}`;
  return key !== undefined && LoginMatchSchema.safeParse(key).success ? key : undefined;
}

/** What the daemon matched a target to: the sign-in, its account and the provider it goes via, and its hosts. */
export interface Matched {
  readonly signIn?: SignInId;
  readonly account?: AccountRef;
  readonly username?: string;
  readonly via?: AccountRef;
  readonly factor?: PhoneApproval['factor'];
  /** The login domains of the sign-in and of every sign-in its `via` chain reaches: where a number may be read. */
  readonly domains: ReadonlySet<string>;
  /**
   * The login domains of the PROVIDER sign-ins the chain reaches (never the matched sign-in's own): the only hosts off
   * Okta's own where Okta's widget may give a number (an organisation's custom Okta domain, secrev-1244 R1).
   */
  readonly providerDomains: ReadonlySet<string>;
}

/**
 * The hinted sign-in, when its `via` chain reaches a sign-in at `key` and it does not sign in at `key` itself: the
 * sign-in, the chain walked (it and every provider sign-in), and the provider account the card names.
 */
function viaChainTo(
  key: string,
  hint: NonNullable<PhoneApprovalRaise['secretHint']>,
  listing: SavedListing,
):
  | { readonly signIn: SignInSummary; readonly chain: readonly SignInSummary[]; readonly provider: AccountRef }
  | undefined {
  const hinted = listing.signIns.filter(candidate =>
    hint.startsWith('si_') ? candidate.id === hint : candidate.account === hint,
  );
  if (hinted.length !== 1) return undefined;
  const start = hinted[0] as SignInSummary;
  if (start.place.kind === 'site' && start.place.domains.includes(key)) return undefined;
  let frontier: readonly SignInSummary[] = [start];
  const chain: SignInSummary[] = [start];
  for (let depth = 0; depth < VIA_DEPTH; depth += 1) {
    const next = frontier.flatMap(each => {
      const via = each.via;
      if (via === undefined) return [];
      return listing.signIns.filter(candidate =>
        via.signIn === undefined ? candidate.account === via.account.id : candidate.id === via.signIn,
      );
    });
    if (next.length === 0) return undefined;
    chain.push(...next);
    const here = next.find(each => each.place.kind === 'site' && each.place.domains.includes(key));
    if (here !== undefined) {
      const provider = listing.accounts.find(each => each.id === here.account);
      return provider === undefined
        ? undefined
        : { signIn: start, chain, provider: { id: provider.id, label: provider.label } };
    }
    frontier = next;
  }
  return undefined;
}

/**
 * WHICH SIGN-IN THIS IS, from the target key the daemon observed. A sign-in that signs in at this key, the ferret's
 * hint ordering only among those; else, when the hint names a sign-in whose provider chain signs in here (ClickUp
 * via Okta, on the Okta page), that one, named "via" its provider. A hint that reaches nothing here is ignored.
 */
export function matchSignIn(
  key: string | undefined,
  listing: SavedListing,
  raise: Pick<PhoneApprovalRaise, 'secretHint' | 'factor'>,
): Matched {
  const none: Matched = { domains: new Set(), providerDomains: new Set() };
  if (key === undefined) return none;
  const hint = raise.secretHint;
  const viaHere = hint === undefined ? undefined : viaChainTo(key, hint, listing);
  const direct = chosenSignIn(key, listing.signIns, hint === undefined ? {} : { hint });
  const signIn =
    viaHere?.signIn ?? listing.signIns.find(candidate => direct !== undefined && candidate.id === direct.signIn);
  if (signIn === undefined) return none;
  const account = listing.accounts.find(each => each.id === signIn.account);
  if (account === undefined) return none;
  const chain = viaHere?.chain ?? [signIn];
  const domains = new Set(chain.flatMap(each => (each.place.kind === 'site' ? each.place.domains : [])));
  if (signIn.place.kind === 'terminal') domains.clear();
  // The provider sign-ins only: every sign-in the chain reached through `via`, never the matched one itself.
  const providerDomains = new Set(
    chain.slice(1).flatMap(each => (each.place.kind === 'site' ? each.place.domains : [])),
  );
  const pushes = account.factors.filter(factor => factor.kind === 'push');
  const factor =
    pushes.find(each => raise.factor !== undefined && each.id === raise.factor) ??
    (pushes.length === 1 ? pushes[0] : undefined);
  return {
    signIn: signIn.id,
    account: { id: account.id, label: account.label },
    ...(account.username === undefined ? {} : { username: account.username }),
    ...(viaHere?.provider === undefined ? {} : { via: viaHere.provider }),
    ...(factor === undefined
      ? {}
      : {
          factor: {
            id: factor.id,
            label: factor.label,
            ...(factor.kind === 'push' && factor.app !== undefined ? { app: factor.app } : {}),
          },
        }),
    domains,
    providerDomains,
  };
}

/** The card's facts from a match: only what the daemon knows. */
export function approvalFacts(matched: Matched): Partial<PhoneApproval> {
  return {
    ...(matched.signIn === undefined ? {} : { signIn: matched.signIn }),
    ...(matched.account === undefined ? {} : { account: matched.account }),
    ...(matched.username === undefined ? {} : { username: matched.username }),
    ...(matched.via === undefined ? {} : { via: matched.via }),
    ...(matched.factor === undefined ? {} : { factor: matched.factor }),
  };
}
