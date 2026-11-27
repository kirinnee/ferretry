import {
  IDENTITY_LINK_WHY_MAX_LENGTH,
  type IdentityLink,
  type IdentityLinkProposal,
  type IdentityLinksDocument,
  MAX_IDENTITY_LINK_PROPOSALS,
  type SignInId,
} from '../../contract/routes/index.ts';

/** The graph's one document, read and written whole. A damaged file raises; it is never read as empty. */
export interface IdentityLinksStore {
  read(): Promise<IdentityLinksDocument>;
  write(document: IdentityLinksDocument): Promise<void>;
}

/** What a ferret's "S lives in I" came to. `known`: the graph already has that edge, so nothing was filed. */
export type IdentityLinkFiled = 'pending' | 'known';

/** A refusal in words the ferret can act on. */
export class IdentityLinkError extends Error {
  constructor(
    readonly code: 'not_found' | 'capacity' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'IdentityLinkError';
  }
}

const flat = (text: string): string => {
  const line = text
    .replaceAll(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
  return line.length <= IDENTITY_LINK_WHY_MAX_LENGTH ? line : `${line.slice(0, IDENTITY_LINK_WHY_MAX_LENGTH - 1)}…`;
};

/**
 * Files a ferret's proposal in the document: pure. An edge the graph already holds files nothing; an older proposal
 * for the same sign-in and identity is replaced (one pending per pair); the list is capped. A proposal is not an
 * edge: the graph's functions read `links` only.
 */
export function withProposal(
  document: IdentityLinksDocument,
  proposal: IdentityLinkProposal,
): { readonly document: IdentityLinksDocument; readonly filed: IdentityLinkFiled } {
  if (document.links.some(link => link.signIn === proposal.signIn && link.identity === proposal.identity))
    return { document, filed: 'known' };
  const others = document.proposals.filter(
    each => !(each.signIn === proposal.signIn && each.identity === proposal.identity),
  );
  if (others.length >= MAX_IDENTITY_LINK_PROPOSALS)
    throw new IdentityLinkError('capacity', 'Too many proposals are waiting for the owner; do not file more.');
  return { document: { ...document, proposals: [...others, proposal] }, filed: 'pending' };
}

export interface IdentityLinksDeps {
  readonly store: IdentityLinksStore;
  /** The sign-ins that exist (a proposal names one that does). */
  readonly accounts: { listing(): Promise<{ readonly signIns: readonly { readonly id: SignInId }[] }> };
  readonly clock: { now(): string };
  /** The vault redactor, over the ferret's reason. */
  readonly redact: (text: string) => Promise<string>;
}

/** The graph's edges for readers (`account_hint`) and a ferret's proposals. One write at a time. */
export class IdentityLinks {
  #writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: IdentityLinksDeps) {}

  async links(): Promise<readonly IdentityLink[]> {
    return (await this.deps.store.read()).links;
  }

  async propose(ask: {
    readonly signIn: SignInId;
    readonly identity: string;
    readonly why: string;
  }): Promise<IdentityLinkFiled> {
    const { signIns } = await this.deps.accounts.listing();
    if (!signIns.some(signIn => signIn.id === ask.signIn))
      throw new IdentityLinkError('not_found', 'Name a sign-in that account_hint lists.');
    const why = flat(await this.deps.redact(ask.why));
    const run = async (): Promise<IdentityLinkFiled> => {
      const filed = withProposal(await this.deps.store.read(), {
        signIn: ask.signIn,
        identity: ask.identity,
        why,
        proposedAt: this.deps.clock.now() as IdentityLinkProposal['proposedAt'],
      });
      if (filed.filed === 'pending') await this.deps.store.write(filed.document);
      return filed.filed;
    };
    const next = this.#writing.then(run, run);
    this.#writing = next.catch(() => undefined);
    return await next;
  }
}
