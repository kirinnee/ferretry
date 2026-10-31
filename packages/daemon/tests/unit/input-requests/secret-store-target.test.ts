import { describe, it } from 'bun:test';
import type { InputTarget, InputTargetFacts, SecretName } from '@ferretry/protocol';
import should from 'should';
import {
  InputTargetRouter,
  type SecretStoreDirectory,
  SecretStoreTarget,
  type TerminalInputTargetPort,
} from '../../../src/lib/index.ts';
import { SESSION } from './support.ts';

const NAME = 'VERCEL_TOKEN' as SecretName;
const INTO: InputTarget = { kind: 'secret', key: NAME };
const NEW: InputTargetFacts = { kind: 'secret', name: NAME, exists: false };
const TOKEN = 'vcp_STORE-NEVER-LEAKS-77a1';

/** A store that records each put, holding the names it was seeded with; its check-and-put is one step, as the vault's is. */
function vault(
  names: readonly string[] = [],
  options: { readonly unreadable?: boolean; readonly putFails?: boolean; readonly full?: boolean } = {},
) {
  const held = new Set(names);
  const puts: { name: string; value: string }[] = [];
  const directory: SecretStoreDirectory = {
    list: async () => {
      if (options.unreadable === true) throw new Error('the vault is locked');
      return [...held].map(name => ({ name }));
    },
    putIf: async (name, value, exists) => {
      if (options.unreadable === true) return 'unreadable';
      if (held.has(name) !== exists) return 'changed';
      if (options.full === true && !exists) return 'full';
      if (options.putFails === true) throw new Error('the disk went away mid-write');
      puts.push({ name, value });
      held.add(name);
      return 'stored';
    },
  };
  return { directory, puts, held };
}

describe('the secret store as an input target', () => {
  it('should observe whether the name holds a value, never a value', async () => {
    const empty = new SecretStoreTarget(vault().directory);
    const full = new SecretStoreTarget(vault([NAME]).directory);

    should(await empty.observe(SESSION, INTO)).eql({ ok: true, facts: NEW });
    should(await full.observe(SESSION, INTO)).eql({ ok: true, facts: { ...NEW, exists: true } });
  });

  it('should say it cannot see a store it cannot list, never that the name is free', async () => {
    const target = new SecretStoreTarget(vault([], { unreadable: true }).directory);

    should(await target.observe(SESSION, INTO)).eql({ ok: false, reason: 'unsupported' });
    should(await target.observe(SESSION, { kind: 'terminal', key: 'dev' })).eql({ ok: false, reason: 'unsupported' });
  });

  it('should put the one value under the name the card showed', async () => {
    const store = vault();
    const target = new SecretStoreTarget(store.directory);

    const result = await target.type(SESSION, INTO, [{ field: 'value', text: TOKEN }], false, NEW);

    should(result).equal('typed');
    should(store.puts).eql([{ name: NAME, value: TOKEN }]);
  });

  it('should write nothing when the name gained or lost a value since the card was drawn', async () => {
    const gained = vault([NAME]);
    const lost = vault();

    const asNew = await new SecretStoreTarget(gained.directory).type(
      SESSION,
      INTO,
      [{ field: 'value', text: TOKEN }],
      false,
      NEW,
    );
    const asReplace = await new SecretStoreTarget(lost.directory).type(
      SESSION,
      INTO,
      [{ field: 'value', text: TOKEN }],
      false,
      {
        ...NEW,
        exists: true,
      },
    );

    should([asNew, asReplace]).eql(['target_changed', 'target_changed']);
    should([gained.puts, lost.puts]).eql([[], []]);
  });

  it('should let only the first of two pastes into one new name write it', async () => {
    const store = vault();
    const target = new SecretStoreTarget(store.directory);

    const results = await Promise.all([
      target.type(SESSION, INTO, [{ field: 'value', text: TOKEN }], false, NEW),
      target.type('other-session', INTO, [{ field: 'value', text: 'second' }], false, NEW),
    ]);

    should(results).eql(['typed', 'target_changed']);
    should(store.puts).eql([{ name: NAME, value: TOKEN }]);
  });

  it('should refuse anything but one value into a secret it observed', async () => {
    const store = vault();
    const target = new SecretStoreTarget(store.directory);
    const one = [{ field: 'value', text: TOKEN }];

    should(await target.type(SESSION, INTO, [], false, NEW)).equal('target_changed');
    should(await target.type(SESSION, INTO, [...one, ...one], false, NEW)).equal('target_changed');
    should(await target.type(SESSION, { kind: 'terminal', key: 'dev' }, one, false, NEW)).equal('target_changed');
    should(await target.type(SESSION, INTO, one, false, { kind: 'browser' } as unknown as InputTargetFacts)).equal(
      'target_changed',
    );
    should(store.puts).eql([]);
  });

  it('should report a full or unreadable store as gone, nothing written, and a put that threw mid-write as uncertain', async () => {
    const one = [{ field: 'value', text: TOKEN }];

    should(await new SecretStoreTarget(vault([], { full: true }).directory).type(SESSION, INTO, one, false, NEW)).equal(
      'target_gone',
    );

    should(
      await new SecretStoreTarget(vault([], { unreadable: true }).directory).type(SESSION, INTO, one, false, NEW),
    ).equal('target_gone');
    should(
      await new SecretStoreTarget(vault([], { putFails: true }).directory).type(SESSION, INTO, one, false, NEW),
    ).equal('uncertain');
  });
});

describe('routing a paste into the secret store', () => {
  const terminal = {
    observe: async () => {
      throw new Error('a secret is never a terminal');
    },
    type: async () => {
      throw new Error('a secret is never a terminal');
    },
  } as unknown as TerminalInputTargetPort;

  it('should send a secret target to the store, and to nothing when no store is wired', async () => {
    const store = vault();
    const wired = new InputTargetRouter(terminal, undefined, new SecretStoreTarget(store.directory));
    const bare = new InputTargetRouter(terminal);

    should(await wired.observe(SESSION, INTO, [])).eql({ ok: true, facts: NEW });
    should(await wired.type(SESSION, INTO, [{ field: 'value', text: TOKEN }], false, NEW)).equal('typed');
    should(await bare.observe(SESSION, INTO, [])).eql({ ok: false, reason: 'unsupported' });
    should(await bare.type(SESSION, INTO, [{ field: 'value', text: TOKEN }], false, NEW)).equal('target_gone');
    should(store.puts).have.length(1);
  });
});
