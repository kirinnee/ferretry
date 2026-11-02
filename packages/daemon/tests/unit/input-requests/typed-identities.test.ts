import { describe, it } from 'bun:test';
import should from 'should';
import {
  TYPED_IDENTITY_TTL_MS,
  TypedIdentities,
  usernameOf,
} from '../../../src/lib/input-requests/typed-identities.ts';

const SESSION = 'mvv6b4qw-49d0158d';
const GOOGLE = 'accounts.google.com';

function store() {
  let now = 1_000;
  const identities = new TypedIdentities(() => now);
  return {
    identities,
    later: (ms: number) => {
      now += ms;
    },
  };
}

describe('who a page is signing in, as the ferret typed it', () => {
  it('should answer what was typed on that page and host only', () => {
    const { identities } = store();
    identities.typed(SESSION, 'page-1', 'Accounts.Google.com', ' ernest@atomi.tech ');

    should(identities.at(SESSION, 'page-1', GOOGLE)).equal('ernest@atomi.tech');
    should(identities.at(SESSION, 'page-2', GOOGLE)).be.undefined();
    should(identities.at(SESSION, 'page-1', 'evil.example')).be.undefined();
    should(identities.at('other-session', 'page-1', GOOGLE)).be.undefined();
    should(identities.at(SESSION, 'page-1', undefined)).be.undefined();
  });

  it('should keep the newest type on a page, so a second identity replaces the first', () => {
    const { identities } = store();
    identities.typed(SESSION, 'page-1', GOOGLE, 'kirinnee97@gmail.com');
    identities.typed(SESSION, 'page-1', GOOGLE, 'ernest@atomi.tech');

    should(identities.at(SESSION, 'page-1', GOOGLE)).equal('ernest@atomi.tech');
  });

  it('should forget it once the page is seen on another host, but not on its own', () => {
    const { identities } = store();
    identities.typed(SESSION, 'page-1', GOOGLE, 'ernest@atomi.tech');
    identities.seen(SESSION, 'page-1', GOOGLE);
    should(identities.at(SESSION, 'page-1', GOOGLE)).equal('ernest@atomi.tech');

    identities.seen(SESSION, 'page-1', 'mail.google.com');
    should(identities.at(SESSION, 'page-1', GOOGLE)).be.undefined();
  });

  it('should forget one page when it is cleared, keeping the session’s other pages', () => {
    const { identities } = store();
    identities.typed(SESSION, 'page-1', GOOGLE, 'ernest@atomi.tech');
    identities.typed(SESSION, 'page-2', GOOGLE, 'kirin@x.com');
    identities.cleared(SESSION, 'page-1');
    identities.cleared('nobody', 'page-2');

    should(identities.at(SESSION, 'page-1', GOOGLE)).be.undefined();
    should(identities.at(SESSION, 'page-2', GOOGLE)).equal('kirin@x.com');
    identities.cleared(SESSION, 'page-2');
    should(identities.sessions()).deepEqual([]);
  });

  it('should forget it when an act leaves no host to read', () => {
    const { identities } = store();
    identities.typed(SESSION, 'page-1', GOOGLE, 'ernest@atomi.tech');
    identities.seen(SESSION, 'page-1', undefined);

    should(identities.at(SESSION, 'page-1', GOOGLE)).be.undefined();
  });

  it('should stop answering after its time, and when the session ends', () => {
    const { identities, later } = store();
    identities.typed(SESSION, 'page-1', GOOGLE, 'ernest@atomi.tech');
    later(TYPED_IDENTITY_TTL_MS);
    should(identities.at(SESSION, 'page-1', GOOGLE)).equal('ernest@atomi.tech');
    later(1);
    should(identities.at(SESSION, 'page-1', GOOGLE)).be.undefined();

    identities.typed(SESSION, 'page-2', GOOGLE, 'b@x.com');
    should(identities.sessions()).deepEqual([SESSION]);
    identities.forget(SESSION);
    should(identities.sessions()).deepEqual([]);
  });

  it('should keep nothing a username cannot be, and drop what was there', () => {
    const { identities } = store();
    identities.typed(SESSION, 'page-1', GOOGLE, 'ernest@atomi.tech');
    identities.typed(SESSION, 'page-1', GOOGLE, 'line\nbreak');

    should(identities.at(SESSION, 'page-1', GOOGLE)).be.undefined();
    should(usernameOf('   ')).be.undefined();
    should(usernameOf('x'.repeat(257))).be.undefined();
    should(usernameOf('a​b')).be.undefined();
    should(usernameOf(' kirin ')).equal('kirin');
  });
});
