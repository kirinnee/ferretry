import { describe, expect, test } from 'bun:test';
import { defineState } from '../../../contract/define.ts';
import { definePlugin } from '../../../manifest/builders.ts';
import {
  composePrivateFiles,
  covers,
  MIN_PUBLIC_REASON,
  namesASecret,
  privacyProblems,
  privatePlaces,
} from '../../../manifest/privacy.ts';
import type { Manifest } from '../../../manifest/types.ts';

/**
 * The fail-closed rule for a plugin's state files, at the manifest: a file named like a secret is declared private
 * (the fence pins it by identity) or public with a written reason, or the manifest is refused. `definePlugin` applies
 * it at load; the workspace check (`scripts/validate/private-files.ts`) applies the same function to every manifest.
 */

const state = (name: string, path: string) => defineState({ name, path, store: 'json', format: 1 });

const plugin = (extra: Partial<Manifest> & { readonly files?: readonly string[] }): Manifest => {
  const { files = [], ...rest } = extra;
  return {
    id: 'sample',
    title: 'Sample',
    version: '1.0.0',
    api: 5,
    core: false,
    kinds: [],
    data: { state: files.map((path, index) => state(`f${String(index)}`, path)) },
    ...rest,
  };
};

describe('PF-rule a secret-named state file must be declared one way or the other', () => {
  for (const word of ['key', 'secret', 'token', 'passkey', 'credential', 'oauth']) {
    test(`PF-rule the word "${word}" in a name is a secret name, in any case`, () => {
      expect(namesASecret(`my-${word}.json`)).toBe(true);
      expect(namesASecret(`My-${word.toUpperCase()}.json`)).toBe(true);
    });
  }

  test('PF-rule a plain name is not a secret name', () => {
    for (const name of ['cards.json', 'index.sqlite', 'tmux.sock', 'x11', 'agent-homes'])
      expect(namesASecret(name)).toBe(false);
  });

  test('PF-rule a new secret-named file with no declaration is refused, naming the file and both ways out', () => {
    const problems = privacyProblems(plugin({ files: ['cards.json', 'api-token.json'] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('api-token.json');
    expect(problems[0]).toContain('privacy.private');
    expect(problems[0]).toContain('privacy.public');
  });

  test('PF-rule the folder of a collection counts: "credentials/*" says credential', () => {
    expect(privacyProblems(plugin({ files: ['credentials/*'] }))).toHaveLength(1);
    expect(privacyProblems(plugin({ files: ['sealed/oauth-*.json'] }))).toHaveLength(1);
  });

  test('PF-rule declared private, the file is allowed and pinned', () => {
    const manifest = plugin({ files: ['api-token.json'], privacy: { private: ['api-token.json'] } });
    expect(privacyProblems(manifest)).toEqual([]);
    expect(privatePlaces(manifest)).toEqual(['state/sample/api-token.json']);
  });

  test('PF-rule a private folder covers the collection below it, and pins the folder', () => {
    const manifest = plugin({ files: ['credentials/*'], privacy: { private: ['credentials'] } });
    expect(privacyProblems(manifest)).toEqual([]);
    expect(privatePlaces(manifest)).toEqual(['state/sample/credentials']);
  });

  test('PF-rule a private pattern pins the folder before its first star, never the plugin folder', () => {
    const manifest = plugin({
      files: ['inbox/*-token.json'],
      privacy: { private: ['inbox/*-token.json'] },
    });
    expect(privatePlaces(manifest)).toEqual(['state/sample/inbox']);
    const wholeFolder = plugin({ files: ['*/token.json'], privacy: { private: ['*/token.json'] } });
    expect(privacyProblems(wholeFolder).join('\n')).toContain('must start with a plain folder or file name');
    expect(privatePlaces(wholeFolder)).toEqual([]);
  });

  test('PF-rule declared public WITH a reason, the file is allowed and pinned by nothing', () => {
    const manifest = plugin({
      files: ['oauth.json'],
      privacy: { public: [{ path: 'oauth.json', reason: 'Sign-in facts, never a token: issuer and client id only.' }] },
    });
    expect(privacyProblems(manifest)).toEqual([]);
    expect(privatePlaces(manifest)).toEqual([]);
  });

  test('PF-rule declared public with no reason, or a one-word reason, is refused', () => {
    for (const reason of ['', '   ', 'fine', 'x'.repeat(MIN_PUBLIC_REASON - 1)]) {
      const problems = privacyProblems(
        plugin({ files: ['oauth.json'], privacy: { public: [{ path: 'oauth.json', reason }] } }),
      );
      expect(problems.join('\n')).toContain('needs a written reason');
    }
  });

  test('PF-rule a path declared both private and public is refused', () => {
    const problems = privacyProblems(
      plugin({
        files: ['oauth.json'],
        privacy: { private: ['oauth.json'], public: [{ path: 'oauth.json', reason: 'Not a secret, honestly.' }] },
      }),
    );
    expect(problems.join('\n')).toContain('both private and public');
  });

  test('PF-rule a declaration is a plain relative path: no "..", no leading slash, no empty segment, one star at most', () => {
    for (const path of ['../vault.key', '/vault.key', 'a//b', './x', 'a/*/*', '']) {
      expect(privacyProblems(plugin({ privacy: { private: [path] } })).length).toBeGreaterThan(0);
    }
  });

  test('PF-rule a name that only LOOKS like a covered one is not covered', () => {
    expect(covers('credentials', 'credentials/*')).toBe(true);
    expect(covers('credentials', 'credentials-extra/*')).toBe(false);
    expect(covers('tokens.json', 'tokens.json.bak')).toBe(false);
    const problems = privacyProblems(plugin({ files: ['tokens.json.bak'], privacy: { private: ['tokens.json'] } }));
    expect(problems).toHaveLength(1);
  });

  test('PF-rule files no defineState names (the kernel identity key) are judged the same way', () => {
    expect(privacyProblems(plugin({}), ['identity.json'])).toEqual([]);
    expect(privacyProblems(plugin({}), ['signing.key'])).toHaveLength(1);
    expect(privacyProblems(plugin({ privacy: { private: ['signing.key'] } }), ['signing.key'])).toEqual([]);
  });
});

describe('PF-load definePlugin refuses a manifest that breaks the rule', () => {
  const spec = (extra: Partial<Manifest>) => ({
    id: 'sample',
    title: 'Sample',
    version: '1.0.0',
    api: 5 as const,
    core: false,
    kinds: [] as const,
    ...extra,
  });

  test('PF-load a secret-named state file with neither declaration refuses the manifest at load', () => {
    expect(() => definePlugin(spec({ data: { state: [state('t', 'session-token.json')] } }))).toThrow(
      'is named like a secret',
    );
  });

  test('PF-load declared private, or public with a reason, loads', () => {
    expect(
      definePlugin(
        spec({ data: { state: [state('t', 'session-token.json')] }, privacy: { private: ['session-token.json'] } }),
      ).id,
    ).toBe('sample');
    expect(
      definePlugin(
        spec({
          data: { state: [state('t', 'session-token.json')] },
          privacy: { public: [{ path: 'session-token.json', reason: 'Holds only the expiry date of a session.' }] },
        }),
      ).id,
    ).toBe('sample');
  });

  test('PF-load an unsound declaration refuses the manifest at load', () => {
    expect(() => definePlugin(spec({ privacy: { private: ['../escape'] } }))).toThrow('private file');
  });
});

describe('PF-compose the kernel composes every plugin list into the one the fence reads', () => {
  test('PF-compose each plugin pins under its own state folder, sorted, once', () => {
    const list = composePrivateFiles([
      plugin({ id: 'zeta', privacy: { private: ['b.key', 'a.key'] } }),
      plugin({ id: 'alpha', privacy: { private: ['a.key', 'creds/*'] } }),
      plugin({ id: 'none' }),
    ]);
    expect(list).toEqual(['state/alpha/a.key', 'state/alpha/creds', 'state/zeta/a.key', 'state/zeta/b.key']);
  });

  test('PF-compose a plugin cannot pin outside its own state folder', () => {
    expect(
      composePrivateFiles([plugin({ id: 'sample', privacy: { private: ['../vault/vault.key', '/etc/x'] } })]),
    ).toEqual([]);
  });
});
