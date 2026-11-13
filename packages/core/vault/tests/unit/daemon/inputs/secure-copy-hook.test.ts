import { describe, it } from 'bun:test';
import should from 'should';
import type { InputTargetFacts, SecureCopyProvider } from '../../../../contract/index.ts';
import { SecureCopiesThroughHook } from '../../../../daemon/adapters/inputs/secure-copy.ts';
import { COPY_VALUE, copyMeta } from './world.ts';

/**
 * The Vault's view of Accounts' secure copies (`input.secure-copy:copy`): looked up on every call, parsed at the Vault's
 * boundary, and failing closed. The provider is a fake; the adapter is the real one.
 */
const FACTS = { kind: 'terminal' } as unknown as InputTargetFacts;

function provider(over: Partial<SecureCopyProvider> = {}): SecureCopyProvider {
  return {
    describe: () => copyMeta(),
    open: () => COPY_VALUE,
    used: () => undefined,
    refusal: async () => undefined,
    reserve: () => 'rule-1',
    release: () => undefined,
    spent: () => undefined,
    ...over,
  };
}

describe('the Vault’s secure copies, through the hook', () => {
  it('should know no copy and match no rule while Accounts provides nothing', async () => {
    const copies = new SecureCopiesThroughHook(() => undefined);

    should(copies.describe('s1', 'vercel')).equal(undefined);
    should(copies.open('s1', 'vercel')).equal(undefined);
    should(copies.reserve('s1', { kind: 'command', program: 'gh' }, FACTS)).equal(undefined);
    should(await copies.refusal('s1', 'vercel', { kind: 'page', key: 'app' })).equal(undefined);
    should(() => {
      copies.used('s1', 'vercel', { kind: 'terminal', key: 'dev' });
      copies.release('rule-1');
      copies.spent('rule-1');
    }).not.throw();
  });

  it('should read a live copy the provider describes, and nothing the provider says that is not a copy', () => {
    const live = new SecureCopiesThroughHook(() => provider());
    const ended = new SecureCopiesThroughHook(() => provider({ describe: () => copyMeta({ state: 'discarded' }) }));
    const smuggling = new SecureCopiesThroughHook(() =>
      provider({ describe: () => ({ ...copyMeta(), value: COPY_VALUE }) }),
    );
    const garbage = new SecureCopiesThroughHook(() => provider({ describe: () => 'not a copy' }));

    should(live.describe('s1', 'vercel')).match({ handle: 'sealed:vercel', state: 'live' });
    should(ended.describe('s1', 'vercel')).equal(undefined);
    // A member a ferret may not see is refused whole, never shown.
    should(smuggling.describe('s1', 'vercel')).equal(undefined);
    should(garbage.describe('s1', 'vercel')).equal(undefined);
  });

  it('should open the value only through the provider and treat a throwing provider as no copy', () => {
    const open = new SecureCopiesThroughHook(() => provider());
    const throwing = new SecureCopiesThroughHook(() =>
      provider({
        describe: () => {
          throw new Error(`boom ${COPY_VALUE}`);
        },
        open: () => {
          throw new Error(`boom ${COPY_VALUE}`);
        },
        reserve: () => {
          throw new Error('boom');
        },
      }),
    );

    should(open.open('s1', 'vercel')).equal(COPY_VALUE);
    should(throwing.describe('s1', 'vercel')).equal(undefined);
    should(throwing.open('s1', 'vercel')).equal(undefined);
    should(throwing.reserve('s1', { kind: 'command', program: 'gh' }, FACTS)).equal(undefined);
  });

  it('should pass a rule only an origin that parses, and answer a takeover check the provider could not make with a refusal', async () => {
    const seen: unknown[] = [];
    const checked = new SecureCopiesThroughHook(() =>
      provider({
        reserve: (...args) => {
          seen.push(args);
          return 'rule-1';
        },
      }),
    );
    const broken = new SecureCopiesThroughHook(() =>
      provider({
        refusal: async () => {
          throw new Error('Browsers fell over');
        },
      }),
    );

    should(checked.reserve('s1', { kind: 'command', program: 7 } as never, FACTS)).equal(undefined);
    should(checked.reserve('s1', { kind: 'command', program: 'gh' }, FACTS, 'gh')).equal('rule-1');
    should(seen).eql([['s1', { kind: 'command', program: 'gh' }, FACTS, 'gh']]);
    should(await broken.refusal('s1', 'vercel', { kind: 'page', key: 'app' })).containEql('could not check');
  });
});
