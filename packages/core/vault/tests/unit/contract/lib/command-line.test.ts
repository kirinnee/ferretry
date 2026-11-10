import { describe, expect, it } from 'bun:test';
import {
  envEntryRefused,
  firstRefusedWord,
  HIDDEN_WORD_TEXT,
  looksSecret,
  pointsElsewhere,
  refusedLine,
  SECRET_TOKEN_SOURCE,
  secretNamed,
  shownWord,
  shownWords,
} from '../../../../contract/index.ts';

// Fake values only. The rule's own differential and its mutation-checked shapes are Runtimes' (the Resolved view);
// these pin the surface Catalogs and Runtimes both stand on, and give the vault's ledger its own 100%.
// V is a fake 22-character value, T a fake 20-character token body.
const V = 'fakevalue0000000000000';
const T = 'aaaaaaaaaaaaaaaaaaaa';

describe('the one command-line rule', () => {
  it('R-0082 should cut the password of a URL user, and keep the user and the host', () => {
    expect(shownWord('postgres://person:fake-pw-0000@db/x', undefined)).toEqual({
      text: `postgres://person:${HIDDEN_WORD_TEXT}@db/x`,
      hidden: true,
    });
  });

  it('R-0082 should hide the word after a secret-named flag, and a header under a secret-named key', () => {
    expect(shownWords(['--token', 'fake-tok-0000'])).toEqual([
      { text: '--token', hidden: false },
      { text: HIDDEN_WORD_TEXT, hidden: true },
    ]);
    expect(shownWord('X-Api-Key: fake-key-0000', '--header').hidden).toBe(true);
    expect(shownWord('--set=a=1,client.secret=fake-0000x', undefined).text).toBe(
      `--set=a=1,client.secret=${HIDDEN_WORD_TEXT}`,
    );
  });

  it('R-0082 should show a harmless flag, a pointer and a plain word as written', () => {
    expect(shownWords(['--port', '8080', '--token', '${secret:TOKEN}']).map(word => word.hidden)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

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
});

describe('what reads as a credential', () => {
  it('R-0082 should know a secret name by its words and a token by its prefix', () => {
    expect(secretNamed('OPENAI_API_KEY')).toBe(true);
    expect(secretNamed('--client-secret')).toBe(true);
    expect(secretNamed('LOG_LEVEL')).toBe(false);
    expect(looksSecret('ANYTHING', 'ghp_aaaaaaaaaaaaaaaa')).toBe(true);
    expect(looksSecret('GITHUB_TOKEN', 'abcdefghij')).toBe(true);
    expect(looksSecret('AUTH', '1')).toBe(false);
  });

  it('R-0082 should treat a pointer as holding no secret', () => {
    expect(pointsElsewhere('$TOKEN')).toBe(true);
    expect(pointsElsewhere('${TOKEN}')).toBe(true);
    expect(pointsElsewhere('Bearer ${secret:TOKEN}')).toBe(true);
    expect(pointsElsewhere('plain')).toBe(false);
    expect(looksSecret('GITHUB_TOKEN', '${secret:GITHUB_TOKEN}')).toBe(false);
  });

  it('R-0082 should find a whole token in a text through the one source', () => {
    expect(new RegExp(SECRET_TOKEN_SOURCE, 'u').test('<&ghp_aaaaaaaaaaaaaaaa')).toBe(true);
    expect(new RegExp(SECRET_TOKEN_SOURCE, 'u').test('no token here')).toBe(false);
  });
});

describe('the publish strength', () => {
  it('R-0261 should refuse a publish-only name in every reading, and Runtimes should show it', () => {
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
    // Shown as written by the hide strength.
    for (const word of [`--license-key=${V}`, `--pass ${V}`, `x?key=${V}`, `x#pwd=${V}`])
      expect(shownWord(word, undefined)).toEqual({ text: word, hidden: false });
    expect(shownWord(V, '--key').hidden).toBe(false);
    // The Codex launch flag names a variable on purpose.
    const envKey = '-c model_providers.openrouter.env_key="OPENROUTER_API_KEY"';
    expect(shownWord(envKey, undefined)).toEqual({ text: envKey, hidden: false });
  });

  it('R-0261 should take a publish-only name’s value as a credential only when it is one unbroken piece of 16 or more', () => {
    expect(envEntryRefused('LICENSE_KEY', V)).toBe(true);
    for (const [name, value] of [
      ['SSH_KEY_PATH', '/home/person/.ssh/id_ed25519'],
      ['PRIMARY_KEY', 'created_at_id'],
      ['PWD', '/srv/app/current'],
      ['KIMI_API_KEY', 'short'],
    ] as const)
      expect(envEntryRefused(name, value)).toBe(false);
    expect(firstRefusedWord(['--key-file', '/etc/ssl/server.pem'])).toBe(-1);
    expect(firstRefusedWord(['--sort-key', 'modified_time'])).toBe(-1);
  });

  it('R-0261 should read KEY, PASS, PWD, BEARER and BASIC as names on word boundaries only', () => {
    for (const name of ['--signing-key', '--pass', 'PWD', 'BEARER', '--basic'])
      expect(firstRefusedWord([name, V])).toBe(1);
    for (const name of ['--keyboard', 'MONKEY', 'PASSENGER_NAME', 'KEYSPACE', 'OLDPWD', 'BYPASS', 'PORT'])
      expect(firstRefusedWord([name, V])).toBe(-1);
  });

  it('R-0082 R-0261 should know sk_test_, rk_live_, rk_test_ and pk_live_ tokens at both strengths', () => {
    for (const prefix of ['sk_test_', 'rk_live_', 'rk_test_', 'pk_live_']) {
      expect(looksSecret('', `${prefix}${T}`)).toBe(true);
      expect(shownWord(`--stripe=${prefix}${T}`, undefined).hidden).toBe(true);
      expect(firstRefusedWord([`x:${prefix}${T}`])).toBe(0);
    }
  });

  it('R-0082 R-0261 should cut a token of 20 or more characters that follows / ? & or #', () => {
    const token = `ghp_${T}`;
    expect(shownWord(`x/${token}`, undefined)).toEqual({ text: `x/${HIDDEN_WORD_TEXT}`, hidden: true });
    for (const joined of [`x?${token}`, `x#${token}`, `x&${token}`, `npx/${token}`])
      expect(shownWord(joined, undefined).text).toBe(
        `${joined.slice(0, joined.length - token.length)}${HIDDEN_WORD_TEXT}`,
      );
    expect(shownWord(`https://h.example.invalid/p/${token}`, undefined).text).toBe(
      `https://h.example.invalid/p/${HIDDEN_WORD_TEXT}`,
    );
    expect(shownWord('@acme/sk-mcp-server', undefined).hidden).toBe(false);
    expect(shownWord('https://h.example.invalid/hf_transfer', undefined).hidden).toBe(false);
  });

  it('R-0261 should read an argument or an environment value that holds white space as the words it holds', () => {
    expect(firstRefusedWord([`--port 1\n--token ${V}`])).toBe(0);
    expect(envEntryRefused('OPTS', `--token ${V}`)).toBe(true);
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

// A word is hidden at the hide strength only if a catalog refuses it too (the invariant #41 needs).
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

  it('R-0261 R-0293 should refuse every word Runtimes hides', () => {
    let hidden = 0;
    for (const word of ALL)
      for (const before of [undefined, '--token', '--model', 'plain']) {
        if (!shownWord(word, before).hidden) continue;
        hidden += 1;
        expect(firstRefusedWord([word], before)).toBe(0);
      }
    expect(hidden).toBeGreaterThan(100);
  });
});

describe('every line of the rule', () => {
  it('R-0082 should cut a quoted nested value to its closing quote, and a key inside a covered value is covered', () => {
    expect(shownWord('API_KEY="fake-value,0000"', undefined).text).toBe(`API_KEY=${HIDDEN_WORD_TEXT}`);
    expect(shownWord("a='x',API_KEY='fake-value,0000'", undefined).hidden).toBe(true);
    expect(shownWord('API_KEY=fake-value-0000,token=other-value-0000', undefined).text).toBe(
      `API_KEY=${HIDDEN_WORD_TEXT},token=${HIDDEN_WORD_TEXT}`,
    );
    expect(shownWord('API_KEY=fake-value-0000 token=other-value-0000', undefined).hidden).toBe(true);
  });

  it('R-0082 should read the parts before and after a pointer that a space or # sets apart', () => {
    const pointer = '${secret:OTHER_TOKEN}';
    expect(shownWord(`API_KEY=${pointer} CLIENT_SECRET=fake-value-0000`, undefined).hidden).toBe(true);
    expect(shownWord(`API_KEY=fake-value-0000 ${pointer}`, undefined).hidden).toBe(true);
    expect(shownWord(`Authorization: Basic fake-value-0000== ${pointer}`, undefined).hidden).toBe(true);
    expect(shownWord(`API_KEY=${pointer} fake-value-0000==`, undefined).hidden).toBe(true);
    expect(shownWord(`API_KEY=${pointer}#fake-value-0000`, undefined).hidden).toBe(true);
    expect(shownWord(`API_KEY=$FAKE_NAME_0000 ${pointer}`, undefined).hidden).toBe(false);
    expect(shownWord(`API_KEY=\${FAKE_NAME} ${pointer}`, undefined).hidden).toBe(false);
    expect(shownWord(`API_KEY=$1234567890 x ${pointer}`, undefined).hidden).toBe(true);
    expect(shownWord(`API_KEY=\${A}x0000000 ${pointer}`, undefined).hidden).toBe(true);
    expect(shownWord(`API_KEY="fake-value-0000" ${pointer}`, undefined).hidden).toBe(true);
    expect(shownWord(`API_KEY=${pointer} X-Trace: fake-value-0000`, undefined).hidden).toBe(false);
    expect(shownWord(`API_KEY=short ${pointer} X-Trace: ${pointer}`, undefined).hidden).toBe(false);
  });

  it('R-0082 should read a secret-named flag’s value with a pointer on either side, and a non-plain flag as a key', () => {
    const pointer = '${secret:OTHER_TOKEN}';
    expect(shownWords(['--token', `fake-value-0000 ${pointer}`]).map(word => word.hidden)).toEqual([false, true]);
    expect(shownWord(`--token fake-value-0000 ${pointer}`, undefined).hidden).toBe(true);
    expect(shownWord(`-Hclient.secret:fake-value-0000`, undefined).hidden).toBe(true);
    expect(shownWord('-Hclient.secret', '--other').hidden).toBe(false);
    expect(shownWords(['-c', 'client.secret=fake-value-0000']).map(word => word.hidden)).toEqual([false, true]);
  });

  it('R-0082 should cut a URL password inside a longer text, and a key that reaches into it', () => {
    expect(
      shownWord('--url=https://person:fake-pw-0000@h.example.invalid/x?token=fake-value-0000', undefined).text,
    ).toBe(`--url=https://person:${HIDDEN_WORD_TEXT}@h.example.invalid/x?token=${HIDDEN_WORD_TEXT}`);
    expect(shownWord('API_KEY=https://person:fake-pw-0000@h.example.invalid/x', undefined).hidden).toBe(true);
    expect(shownWord('https://person:${secret:PW}@h.example.invalid/x', undefined).hidden).toBe(false);
  });

  it('R-0082 should cut a token glued into a flag, a stuck flag and a nested key', () => {
    expect(shownWord(`-H${`ghp_${T}`},API_KEY=fake-value-0000`, undefined).text).toBe(`-H${HIDDEN_WORD_TEXT}`);
    expect(shownWord(`-cAPI_KEY:fake-value-0000,PASSWORD=other-value-0000`, undefined).hidden).toBe(true);
    expect(shownWord(`-eAPI_KEY=${V},token=${V}`, undefined).hidden).toBe(true);
    expect(shownWord(`--hdr,api_key=${V};token=${V}`, undefined).hidden).toBe(true);
    expect(shownWord(`--x&API_KEY:${V};Bearer sk-${T}`, undefined).hidden).toBe(true);
    expect(shownWord(`-Hsk-${T}`, undefined).text).toBe(`-H${HIDDEN_WORD_TEXT}`);
  });
});
