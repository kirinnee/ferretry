import { describe, it } from 'bun:test';
import type { StateFileDef } from '@ferretry/kernel/contract';
import should from 'should';
import {
  IdentityLinksDocumentSchema,
  type IdentityLinksDocument,
  MAX_IDENTITY_LINK_PROPOSALS,
} from '../../../contract/routes/index.ts';
import { StateIdentityLinksStore } from '../../../daemon/adapters/state-identity-links-store.ts';
import { IdentityLinkError, IdentityLinks, withProposal } from '../../../daemon/lib/identity-links.ts';

/** The graph's edges at rest, and a ferret's "S lives in I" held for the owner: never an edge, never a value. */

const AT = '2026-11-27T09:00:00.000Z';
const SI = (n: number): string => `si_${n.toString(16).padStart(16, '0')}`;
const EMPTY: IdentityLinksDocument = { format: 1, links: [], proposals: [] };
const proposal = (n: number, identity: string) => ({
  signIn: SI(n) as never,
  identity,
  why: 'the login page is here',
  proposedAt: AT as never,
});

class MemoryState {
  value: unknown = undefined;
  failure: string | undefined;
  async read(_file: StateFileDef) {
    return this.failure === undefined
      ? ({ ok: true, value: this.value } as const)
      : ({ ok: false, error: { sentence: this.failure } } as const);
  }
  async write(_file: StateFileDef, body: unknown) {
    this.value = body;
  }
}

const world = (signIns: readonly number[] = [1, 2]) => {
  const state = new MemoryState();
  const links = new IdentityLinks({
    store: new StateIdentityLinksStore(state as never, {} as StateFileDef),
    accounts: { listing: async () => ({ signIns: signIns.map(n => ({ id: SI(n) as never })) }) },
    clock: { now: () => AT },
    redact: async text => text.replaceAll('hunter2', '[redacted]'),
  });
  return { state, links };
};

/** What a promise that must fail failed with; a promise that does not fail fails the test. */
const rejection = async (work: Promise<unknown>): Promise<Error> => {
  const outcome = await work.then(
    () => undefined,
    (error: unknown) => error as Error,
  );
  if (outcome === undefined) throw new Error('expected a refusal, but it went through');
  return outcome;
};

describe('the graph document', () => {
  it('should read as empty only from a home that never recorded an edge, and raise on a damaged file', async () => {
    const { state, links } = world();
    should(await links.links()).eql([]);

    state.failure = 'the file is damaged';
    should((await rejection(links.links())).message).equal('the file is damaged');
    state.failure = undefined;
    state.value = { links: [{ nonsense: true }] };
    should((await rejection(links.links())).message).not.containEql('nonsense');
  });

  it('should refuse an identity key that could leave the profile folder, a field it does not know, and a value', () => {
    const edge = { signIn: SI(1), identity: 'work', seenAt: AT, how: 'filled' };
    const parse = (link: object) => IdentityLinksDocumentSchema.safeParse({ format: 1, links: [link], proposals: [] });
    should(parse(edge).success).equal(true);
    for (const identity of ['../etc', 'Work', 'a/b', '']) should(parse({ ...edge, identity }).success).equal(false);
    should(parse({ ...edge, how: 'guessed' }).success).equal(false);
    should(parse({ ...edge, cookie: 'x' }).success).equal(false);
  });
});

describe('a ferret saying "S lives in I"', () => {
  it('should hold it as a pending proposal and never as an edge the graph reads', async () => {
    const { state, links } = world();

    should(await links.propose({ signIn: SI(1) as never, identity: 'work', why: 'it is here' })).equal('pending');

    should(await links.links()).eql([]);
    should((state.value as IdentityLinksDocument).proposals).eql([
      { signIn: SI(1), identity: 'work', why: 'it is here', proposedAt: AT },
    ]);
  });

  it('should keep one pending proposal per sign-in and identity, and say known when the graph already has the edge', () => {
    const once = withProposal(EMPTY, proposal(1, 'work'));
    const twice = withProposal(once.document, { ...proposal(1, 'work'), why: 'again' });
    should(twice.document.proposals).have.length(1);
    should(twice.document.proposals[0]?.why).equal('again');
    should(withProposal(once.document, proposal(1, 'home')).document.proposals).have.length(2);

    const held = {
      ...EMPTY,
      links: [{ signIn: SI(1) as never, identity: 'work', seenAt: AT as never, how: 'owner' as const }],
    };
    should(withProposal(held, proposal(1, 'work'))).eql({ document: held, filed: 'known' });
  });

  it('should cap the waiting proposals and refuse a sign-in that does not exist, in words', async () => {
    let document = EMPTY;
    for (let n = 0; n < MAX_IDENTITY_LINK_PROPOSALS; n += 1)
      document = withProposal(document, proposal(n + 1, 'work')).document;
    should(() => withProposal(document, proposal(999, 'work'))).throw(IdentityLinkError);

    const { links } = world([1]);
    const refused = await rejection(links.propose({ signIn: SI(7) as never, identity: 'work', why: 'x' }));
    should(refused).be.instanceOf(IdentityLinkError).and.have.property('code', 'not_found');
  });

  it('should redact the ferret’s reason before it rests, and keep it to one line', async () => {
    const { state, links } = world();
    await links.propose({ signIn: SI(1) as never, identity: 'work', why: 'password hunter2\nis on this page' });
    const why = (state.value as IdentityLinksDocument).proposals[0]?.why;
    should(why).equal('password [redacted] is on this page');
  });

  it('should not lose a proposal when two arrive together', async () => {
    const { state, links } = world();
    await Promise.all([
      links.propose({ signIn: SI(1) as never, identity: 'work', why: 'a' }),
      links.propose({ signIn: SI(2) as never, identity: 'home', why: 'b' }),
    ]);
    should((state.value as IdentityLinksDocument).proposals).have.length(2);
  });
});
