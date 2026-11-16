import { describe, expect, it } from 'bun:test';
import { looksSecret, secretNamed, shownWord, shownWordWith } from '@ferretry/std/credential-words';
import { envEntryRefused, firstRefusedWord, refusedLine } from '../../../../contract/index.ts';
import { PUBLISH_TESTS } from '../../../../contract/lib/command-line.ts';

// Fake values only. The word cutter and the words that name a credential are `@ferretry/std/credential-words`'s, and
// their tests are there; these pin the publish layer a catalog stands on, and give the vault's ledger its own 100%.
// V is a fake 22-character value, T a fake 20-character token body.
const V = 'fakevalue0000000000000';
const T = 'aaaaaaaaaaaaaaaaaaaa';

describe('what a catalog refuses in a command line', () => {
  it('R-0261 should name the first word a catalog refuses in a command line, or -1', () => {
    expect(firstRefusedWord(['--read-only', '--token', 'fake-tok-0000'])).toBe(2);
    expect(firstRefusedWord(['fake-tok-0000'], '--token')).toBe(0);
    expect(firstRefusedWord(['--read-only', '--port', '8080'])).toBe(-1);
  });

  it('R-0261 should read an environment entry as a launch flag does, a name that starts with an underscore included', () => {
    expect(envEntryRefused('PASSWORD', 'fake-pw-0000')).toBe(true);
    expect(envEntryRefused('_API_KEY', 'fake-key-0000')).toBe(true);
    expect(envEntryRefused('NOTE', 'Authorization: Bearer fake-tok-0000')).toBe(true);
    expect(envEntryRefused('MODEL', 'gpt-4o-mini')).toBe(false);
    expect(envEntryRefused('PASSWORD', '${secret:PASSWORD}')).toBe(false);
  });

  it('R-0261 should keep a whole placeholder with a long name as written, a short one too', () => {
    // The GitHub MCP server's own variable name is 29 characters: split at the colon it read as `${secret` + a long run.
    expect(envEntryRefused('GITHUB_PERSONAL_ACCESS_TOKEN', '${secret:GITHUB_PERSONAL_ACCESS_TOKEN}')).toBe(false);
    expect(envEntryRefused('TOKEN', '${secret:SHORT_TOKEN}')).toBe(false);
  });

  it('R-0261 should still refuse a raw token glued to a placeholder', () => {
    const token = `ghp_${T}`;
    expect(envEntryRefused('NOTE', `\${secret:X}${token}`)).toBe(true);
    expect(envEntryRefused('NOTE', `${token}\${secret:X}`)).toBe(true);
    expect(envEntryRefused('NOTE', `prefix \${secret:X} ${token}`)).toBe(true);
    expect(envEntryRefused('GITHUB_PERSONAL_ACCESS_TOKEN', `\${secret:GITHUB_PERSONAL_ACCESS_TOKEN}${token}`)).toBe(
      true,
    );
  });
});

describe('the publish strength', () => {
  it('R-0261 should refuse a publish-only name in every reading', () => {
    for (const words of [
      ['--key', V],
      ['--license-key', V],
      ['--pass', V],
      ['--pwd', V],
      ['--bearer', V],
    ])
      expect(firstRefusedWord(words)).not.toBe(-1);
    for (const word of [`--license-key=${V}`, `--pass ${V}`, `x?key=${V}`, `x#pwd=${V}`])
      expect(firstRefusedWord([word])).toBe(0);
    for (const name of ['DB_PASS', 'PWD', 'BEARER', 'LICENSE_KEY']) expect(envEntryRefused(name, V)).toBe(true);
  });

  it('R-0261 should take a publish-only name’s value as a credential only when it is one unbroken piece of 16 or more', () => {
    expect(envEntryRefused('LICENSE_KEY', V)).toBe(true);
    for (const [name, value] of [
      ['SSH_KEY_PATH', '/home/person/.ssh/id_ed25519'],
      ['PWD', '/srv/app/current'],
      ['KIMI_API_KEY', 'short'],
    ] as const)
      expect(envEntryRefused(name, value)).toBe(false);
    expect(firstRefusedWord(['--key-file', '/etc/ssl/server.pem'])).toBe(-1);
  });

  it('R-0261 should accept a plain value under a name that only ENDS in key, which the display hides (v4 parity)', () => {
    // The display (std SHOWN_TESTS) hides a value of 8 or more under any name that ends in key/token/secret/password;
    // a catalog does not (the write rule accepts them): the one zone where the display hides more.
    expect(envEntryRefused('PRIMARY_KEY', 'created_at_id')).toBe(false);
    expect(envEntryRefused('MONKEY', 'banana-banana-1')).toBe(false);
    expect(firstRefusedWord(['--sort-key', 'modified_time'])).toBe(-1);
    expect(firstRefusedWord(['-c', 'model_providers.kimi.env_key="KIMI_API_KEY"'])).toBe(-1);
    expect(shownWord('modified_time', '--sort-key').hidden).toBe(true);
  });

  it('R-0261 should still refuse a real token shape under such a name', () => {
    const token = `ghp_${T}`;
    expect(envEntryRefused('MY_KEY', token)).toBe(true);
    expect(envEntryRefused('MONKEY', `sk-${T}`)).toBe(true);
    expect(firstRefusedWord(['--sort-key', token])).toBe(1);
    expect(firstRefusedWord([`--my-key=${token}`])).toBe(0);
  });

  it('R-0261 should read KEY, PASS, PWD, BEARER and BASIC as names on word boundaries only', () => {
    for (const name of ['--signing-key', '--pass', 'PWD', 'BEARER', '--basic'])
      expect(firstRefusedWord([name, V])).toBe(1);
    for (const name of ['--keyboard', 'PASSENGER_NAME', 'KEYSPACE', 'OLDPWD', 'BYPASS', 'PORT'])
      expect(firstRefusedWord([name, V])).toBe(-1);
  });

  it('R-0261 should add sk_test_, rk_live_, rk_test_ and pk_live_ tokens to the formats a catalog refuses', () => {
    for (const prefix of ['sk_test_', 'rk_live_', 'rk_test_', 'pk_live_']) {
      expect(PUBLISH_TESTS.looksSecret('', `${prefix}${T}`)).toBe(true);
      expect(firstRefusedWord([`--stripe=${prefix}${T}`])).toBe(0);
      expect(firstRefusedWord([`x:${prefix}${T}`])).toBe(0);
      expect(refusedLine(`x/${prefix}${T}`)).toBe(true);
    }
    expect(PUBLISH_TESTS.looksSecret('', '$sk_test_AAAAAAAAAAAA')).toBe(false);
    expect(PUBLISH_TESTS.looksSecret('', 'sk_t')).toBe(false);
  });

  it('R-0261 should refuse a token of 20 or more characters that follows / ? & or #', () => {
    const token = `ghp_${T}`;
    for (const joined of [`x/${token}`, `x?${token}`, `x#${token}`, `x&${token}`, `npx/${token}`])
      expect(firstRefusedWord([joined])).toBe(0);
    expect(firstRefusedWord([`https://h.example.invalid/p/${token}`])).toBe(0);
    expect(firstRefusedWord(['@acme/sk-mcp-server'])).toBe(-1);
    expect(firstRefusedWord(['https://h.example.invalid/hf_transfer'])).toBe(-1);
    expect(envEntryRefused('NOTE', `x/${token}`)).toBe(true);
  });

  it('R-0261 should read an argument or an environment value that holds white space as the words it holds', () => {
    expect(firstRefusedWord([`--port 1\n--token ${V}`])).toBe(0);
    expect(envEntryRefused('OPTS', `--token ${V}`)).toBe(true);
    // A word inside is judged on its own: a short value glued to a flag is no 16-character piece, yet it is a credential.
    expect(envEntryRefused('OPTS', '--port 1 --token=fake-tok-0000')).toBe(true);
    expect(firstRefusedWord(['--port 1\n--token=fake-tok-0000'])).toBe(0);
    expect(envEntryRefused('LICENSE_KEY', `--auth ${V}`)).toBe(true);
    expect(envEntryRefused('OPTS', '--port 8080 --verbose')).toBe(false);
    expect(firstRefusedWord(['line one\nline two'])).toBe(-1);
    expect(envEntryRefused('NODE_OPTIONS', '--max-old-space-size=4096')).toBe(false);
  });

  it('R-0261 should refuse an announcing word joined to its value by / , ; ? & # " or a quote (G-B1 closed)', () => {
    for (const joined of ['/', ',', ';', '?', '&', '#', '"', "'", '\n', ' ']) {
      expect(firstRefusedWord([`--token${joined}${V}`])).toBe(0);
      expect(firstRefusedWord([`x${joined}key${joined}${V}`])).toBe(0);
    }
    expect(firstRefusedWord([V], 'key')).toBe(0);
  });

  it('R-0261 should keep a plain argument that merely says token or authorization', () => {
    expect(firstRefusedWord(['Authorization token required'])).toBe(-1);
    expect(firstRefusedWord(['--token', '$SOME_LONG_VARIABLE_NAME'])).toBe(-1);
  });

  it('R-0261 should read a command, an address and an id without the split reading', () => {
    expect(refusedLine('https://h.example.invalid/oauth/token/refresh-endpoint')).toBe(false);
    expect(refusedLine('https://h.example.invalid/v1/auth/session-management')).toBe(false);
    expect(refusedLine(`https://h.example.invalid/x?key=${V}`)).toBe(true);
    expect(refusedLine(`https://h.example.invalid/x#pwd=${V}`)).toBe(true);
    expect(refusedLine(`https://h.example.invalid/p/ghp_${T}`)).toBe(true);
    expect(refusedLine(`npx/ghp_${T}`)).toBe(true);
    expect(refusedLine('npx -y @acme/server')).toBe(false);
  });
});

// A word the display hides is refused here too (the invariant #41 needs). The proof over the std corpus is in
// `packages/std/tests/unit/credential-words-corpus.test.ts`; this is the same law over a small generated product.
describe('the strengths agree', () => {
  const FLAGS = ['--token', '-k', '-H', '--header', '--model', '--key', '--pass', '---x', '-'];
  const VALUES = [V, `ghp_${T}`, `sk-${T}`, 'short', '$API_TOKEN', `Bearer ghp_${T}`, `KEY=${V}`, `a,sk-${T}`, ''];
  const JOINS = ['=', ' ', '', ':', ',', '/', '?', '#', '"'];
  const NESTED = ['API_KEY', 'Authorization', 'x.env.ACCESS_TOKEN', 'password', 'pwd', 'LOG_LEVEL'];
  const ALL: readonly string[] = [
    ...FLAGS.flatMap(flag => VALUES.flatMap(value => JOINS.map(join => `${flag}${join}${value}`))),
    ...NESTED.flatMap(key => VALUES.flatMap(value => [`${key}=${value}`, `${key}: ${value}`, `x,${key}=${value};y`])),
    ...VALUES,
  ];

  it('R-0261 R-0293 should refuse every word the display hides by std’s secret-name words and token shapes', () => {
    // The display's widened name tail (a name that only ENDS in key/token/…) is the one declared gap, pinned over the
    // std corpus; the narrow pair is the floor a catalog never goes below.
    const narrow = { namesSecret: secretNamed, looksSecret };
    let hidden = 0;
    for (const word of ALL)
      for (const before of [undefined, '--token', '--model', 'plain']) {
        if (!shownWordWith(narrow, word, before).hidden) continue;
        hidden += 1;
        expect(firstRefusedWord([word], before)).toBe(0);
      }
    expect(hidden).toBeGreaterThan(100);
  });
});
