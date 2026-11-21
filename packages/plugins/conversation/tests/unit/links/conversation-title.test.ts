import { describe, expect, test } from 'bun:test';
import {
  cleanTitle,
  deriveTitle,
  dropCredentialShapes,
  fileTitle,
  looksLikeCredential,
  type ScrubText,
  scrubTitleText,
} from '../../../daemon/links/lib/conversation-title.ts';

/**
 * THE SCRUB (r11 S11): a title travels further than a preview, so a credential never reaches one. These tests are the explicit
 * list the review asks for: token shapes, vault values through a fake vault, text over several lines, and unicode.
 *
 * Every secret below is FAKE: it has the shape of the real thing and opens nothing.
 */

/** A fake vault: the values it knows are masked as the kernel's redaction masks them (`[redacted:NAME]`). */
const fakeVault =
  (values: Readonly<Record<string, string>>): ScrubText =>
  text =>
    Object.entries(values)
      .sort(([, a], [, b]) => b.length - a.length)
      .reduce((masked, [name, value]) => masked.split(value).join(`[redacted:${name}]`), text);

const NO_VAULT: ScrubText = text => text;

/**
 * A fake credential, spelled in two pieces: the prefix is what a scanner recognises, so no whole literal of one is ever committed
 * (GitHub's push protection refuses a branch that holds one, fake or not).
 */
const fake = (prefix: string, body: string): string => `${prefix}${body}`;

/** The token shapes the scrub must drop with NO help from the vault: one realistic fake of each well-known format. */
const TOKEN_SHAPES: Readonly<Record<string, string>> = {
  'GitHub classic': fake('ghp_', 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF3hJ6'),
  'GitHub OAuth': fake('gho_', '16C7e42F292c6912E7710c838347Ae178B4a'),
  'GitHub fine-grained': fake(
    'github_pat_',
    '11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789abcdefghijklmnopqrstuvwxyz',
  ),
  OpenAI: fake('sk-proj-', 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF3hJ6kL9n'),
  Anthropic: fake('sk-ant-', 'api03-aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF3hJ6kL9nP2rS5uV8xY'),
  'Stripe live': fake('sk_live_', '4eC39HqLyjWDarjtT1zdp7dc'),
  'AWS access key': fake('AKIA', 'IOSFODNN7EXAMPLE'),
  'AWS temporary key': fake('ASIA', 'Y34FZKBOKMUTVV7A'),
  Slack: fake('xoxb-', '123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'),
  GitLab: fake('glpat-', 'aB3dE6gH9jK2mN5pQ8sT'),
  npm: fake('npm_', 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF3hJ6'),
  HuggingFace: fake('hf_', 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF3hJ6'),
  Google: fake('AIza', 'SyA-aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0d'),
  'Google OAuth': 'ya29.a0AfH6SMBx_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF3hJ6',
  JWT: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  'long hex (a SHA-256 / a 128-bit key in hex)': '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  'long mixed key': 'Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWo0NTY3',
  'named in a key=value word': 'DB_PASSWORD=correct-horse-battery',
  'a flag with a value': '--api-key=aB3dE6gH9jK2',
  'a password in a URL': 'postgres://admin:s3cr3tpass@db.internal:5432/app',
};

describe('the credential shapes are dropped with no vault at all', () => {
  for (const [shape, token] of Object.entries(TOKEN_SHAPES)) {
    test(`${shape}: not in the title, whether the first sentence is built round it or it trails`, () => {
      const around = deriveTitle(`Fix the login ${token} bug in auth. Thanks`, NO_VAULT);
      const trailing = deriveTitle(`Fix the flaky login test, here is the key ${token}`, NO_VAULT);
      for (const title of [around, trailing]) {
        expect(title).toBeDefined();
        // Neither the token nor any run of it long enough to be a fragment of it.
        const value = token.includes('=') ? token.split('=')[1] : token;
        expect(title).not.toContain(value ?? token);
        expect(title).not.toContain((value ?? token).slice(0, 8));
        expect(title).not.toContain(token);
      }
    });

    test(`${shape}: a CLI title that carries it is cut to the words around it`, () => {
      const title = cleanTitle(`Debug ${token} login`, NO_VAULT);
      expect(title).toBe('Debug login');
    });
  }

  test('a title that is only a credential is nothing, so the next source of a title is used', () => {
    expect(cleanTitle(TOKEN_SHAPES.OpenAI as string, NO_VAULT)).toBeUndefined();
    expect(fileTitle({ name: TOKEN_SHAPES.OpenAI as string }, NO_VAULT)).toBeNull();
    expect(fileTitle({ name: TOKEN_SHAPES.OpenAI as string, firstMessage: 'Fix the checkout total' }, NO_VAULT)).toBe(
      'Fix the Checkout Total',
    );
  });

  test('a Bearer or Basic credential loses the credential, whatever its shape', () => {
    expect(deriveTitle('Why does curl fail? Authorization: Bearer abcdef0123456789xyz', NO_VAULT)).not.toContain(
      'abcdef0123456789xyz',
    );
    expect(scrubTitleText('send Basic dXNlcjpwYXNzd29yZA== now', NO_VAULT)).not.toContain('dXNlcjpwYXNzd29yZA');
  });

  test('ordinary words are never taken for a credential', () => {
    for (const word of [
      'authentication',
      'internationalisation',
      'kubernetes',
      'README.md',
      'v1.2.3',
      'abc1234',
      'login-page',
      'OAuth2',
      'ログイン',
    ]) {
      expect(looksLikeCredential(word)).toBe(false);
    }
    expect(deriveTitle('Add OAuth2 login-page for kubernetes. Use the internationalisation helper', NO_VAULT)).toBe(
      'Add OAuth2 Login-page for Kubernetes',
    );
  });

  test('a long file path is a place, not a key; a token inside a path is still a token', () => {
    const path = '/home/x/.ferretry/state/ferrets/sessions/scout/turns/turn-001.md';
    expect(looksLikeCredential(path)).toBe(false);
    expect(looksLikeCredential(`./build/output2/${'a'.repeat(30)}1.log`)).toBe(false);
    expect(looksLikeCredential(`/tmp/${TOKEN_SHAPES['GitHub classic']}/x`)).toBe(true);
  });

  test('dropping shapes keeps the line breaks, so a heading is still a heading', () => {
    expect(dropCredentialShapes(`# Fix login\n\nkey ${TOKEN_SHAPES['GitHub classic']}\nmore`)).toMatch(
      /^# Fix login\n\nkey\s+\nmore$/u,
    );
  });
});

describe('the vault’s own values are masked, through a fake vault', () => {
  const vault = fakeVault({
    DEPLOY_KEY: 'hunter2-prod-deploy',
    DB_PASSWORD: 'correct horse battery staple',
    CERT_PEM: 'line one of the secret\nline two of the secret',
    JP_SECRET: 'パスワード秘密123',
    SHORT: 'zq9',
  });

  test('a value in the first sentence is in neither the title nor the vault’s mark', () => {
    const title = deriveTitle('Why does hunter2-prod-deploy get refused by the registry?', vault);
    expect(title).toBeDefined();
    expect(title).not.toContain('hunter2');
    expect(title).not.toContain('prod-deploy');
    // The vault's mark is not a word of a title (it would name the secret).
    expect(title).not.toMatch(/redacted/iu);
    expect(title).not.toContain('DEPLOY_KEY');
    expect(title).not.toContain('[');
  });

  test('a value of several words is masked whole', () => {
    const title = deriveTitle('My password is correct horse battery staple, so why is login refused', vault);
    expect(title).not.toMatch(/horse|battery|staple/iu);
    expect(title).not.toMatch(/redacted|DB_PASSWORD/iu);
  });

  test('a value that spans lines is masked whole', () => {
    const message = 'Please use this cert:\nline one of the secret\nline two of the secret\nto sign the build';
    const title = deriveTitle(message, vault);
    expect(title).not.toMatch(/secret|line one|line two/iu);
    expect(scrubTitleText(message, vault)).not.toContain('line one of the secret');
  });

  test('a unicode value is masked', () => {
    const title = deriveTitle('パスワード秘密123 でログインできない', vault);
    expect(title).toBeDefined();
    expect(title).not.toContain('パスワード秘密123');
    expect(title).not.toContain('秘密123');
  });

  test('a value is masked in a CLI title and in a ferret’s own title as well', () => {
    expect(cleanTitle('Deploy with hunter2-prod-deploy today', vault)).toBe('Deploy with today');
    expect(cleanTitle('hunter2-prod-deploy', vault)).toBeUndefined();
  });

  test('a value spelled with invisible characters or full-width letters is still found', () => {
    // A zero-width space between its letters, and the same value in full-width Latin.
    const hidden = 'hunter2-prod-​deploy';
    const wide = 'ｈｕｎｔｅｒ２－ｐｒｏｄ－ｄｅｐｌｏｙ';
    for (const spelled of [hidden, wide]) {
      const title = deriveTitle(`Why is ${spelled} refused by the registry`, vault);
      expect(title ?? '').not.toMatch(/hunter|ｈｕｎｔｅｒ/iu);
    }
  });

  test('the vault’s read is asked once for a message and not once per word', () => {
    let reads = 0;
    const counting: ScrubText = text => {
      reads += 1;
      return vault(text);
    };
    deriveTitle('Fix the flaky login test in the billing service today please', counting);
    // Before and after the text is made plain, and once on the made title: a fixed number, whatever the text.
    expect(reads).toBeLessThanOrEqual(4);
  });
});

describe('text over several lines', () => {
  const GH = TOKEN_SHAPES['GitHub classic'] as string;

  test('a token on a later line is gone, and the heading on the first line is the title', () => {
    const message = `# Rotate the billing keys\n\nUse this token:\n${GH}\n\nThen redeploy.`;
    const title = deriveTitle(message, NO_VAULT);
    expect(title).toBe('Rotate the Billing Keys');
    expect(scrubTitleText(message, NO_VAULT)).not.toContain(GH);
  });

  test('a private key block is dropped from its BEGIN line to its END line', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyz\nabc123def456\n-----END RSA PRIVATE KEY-----';
    const out = scrubTitleText(`Fix the signing step\n${key}\nthen push`, NO_VAULT);
    expect(out).not.toMatch(/MIIEow|abc123def456|BEGIN|PRIVATE KEY/u);
    expect(out).toContain('Fix the signing step');
    expect(out).toContain('then push');
  });

  test('a private key block whose END was cut off by the length limit is dropped to the end of the text', () => {
    const out = scrubTitleText('Fix signing\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC', NO_VAULT);
    expect(out).not.toMatch(/MIIEvQ|BEGIN/u);
    expect(out).toContain('Fix signing');
  });

  test('Windows line endings and blank lines change nothing', () => {
    const title = deriveTitle(`# Fix the login redirect\r\n\r\nthe key is ${GH}\r\n`, NO_VAULT);
    expect(title).toBe('Fix the Login Redirect');
  });

  test('a message that is a long paste is read only as far as a title needs', () => {
    const paste = `Fix the parser\n${'x'.repeat(10_000)}\n${GH}`;
    const title = deriveTitle(paste, NO_VAULT);
    expect(title).toBe('Fix the Parser');
  });

  test('a made title is one line, at most 60 characters, with no path', () => {
    const title = deriveTitle(
      'can you look at why the deploy script fails on mac? see /tmp/x.log\nand /home/me/app/deploy.sh',
      NO_VAULT,
    );
    expect(title).toBeDefined();
    expect(title).not.toContain('\n');
    expect(title).not.toContain('/');
    expect((title ?? '').length).toBeLessThanOrEqual(60);
    expect((title ?? '').split(' ').length).toBeLessThanOrEqual(5);
  });
});

describe('unicode', () => {
  test('full-width Latin spelling a token is the token', () => {
    const wide = 'ｇｈｐ＿ａＢ３ｄＥ６ｇＨ９ｊＫ２ｍＮ５ｐＱ８ｓＴ１ｖＷ４ｙＺ７ｂＣ０ｄＦ３ｈＪ６';
    expect(deriveTitle(`Fix login ${wide} now`, NO_VAULT)).toBe('Fix Login Now');
    expect(scrubTitleText(wide, NO_VAULT).trim()).toBe('');
  });

  test('zero-width and direction characters inside a token do not hide it', () => {
    const token = 'ghp_aB3dE6gH​9jK2mN5pQ8sT1vW4⁠yZ7bC0dF3hJ6';
    expect(scrubTitleText(`key ${token}`, NO_VAULT).trim()).toBe('key');
    const reversed = `‮gnirts‬ ${TOKEN_SHAPES.npm}`;
    expect(scrubTitleText(reversed, NO_VAULT)).not.toContain('npm_');
  });

  test('titles in other scripts, emoji and accents survive', () => {
    expect(cleanTitle('ログインのバグを直す', NO_VAULT)).toBe('ログインのバグを直す');
    expect(cleanTitle('Corriger la connexion déjà cassée 🚀', NO_VAULT)).toBe('Corriger la connexion déjà cassée 🚀');
    expect(cleanTitle('Исправить вход в систему', NO_VAULT)).toBe('Исправить вход в систему');
    expect(deriveTitle('Réparer la page de connexion. Merci', NO_VAULT)).toBe('Réparer La Page De Connexion');
  });

  test('control characters are removed and a title is one line', () => {
    expect(cleanTitle('Fix\u0007 the\nlogin\u0000 bug\u009F', NO_VAULT)).toBe('Fix the login bug');
  });

  test('a title is cut to the wire limit', () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}x`).join(' ');
    expect((cleanTitle(long, NO_VAULT) ?? '').length).toBeLessThanOrEqual(120);
  });
});

describe('what the title is made from', () => {
  test('the CLI’s own name wins over the first message', () => {
    expect(fileTitle({ name: 'Fix flaky login test', firstMessage: 'something else entirely' }, NO_VAULT)).toBe(
      'Fix flaky login test',
    );
  });

  test('with no name, the first message gives a task-like title, never its first 60 characters', () => {
    const message = 'can you look at why the deploy script fails on mac? see /tmp/x.log';
    const title = fileTitle({ firstMessage: message }, NO_VAULT);
    expect(title).not.toBeNull();
    expect(title).not.toBe(message.slice(0, 60));
    expect(title).not.toContain('/');
  });

  test('the way a request is opened is not part of its title', () => {
    expect(deriveTitle('Can you please fix the flaky login test?', NO_VAULT)).toBe('Fix the Flaky Login Test');
    expect(deriveTitle('hey, could you look at the billing totals', NO_VAULT)).toBe('Look at the Billing Totals');
    expect(deriveTitle('I need you to rotate the signing keys', NO_VAULT)).toBe('Rotate the Signing Keys');
    expect(deriveTitle("Let's add a retry to the uploader", NO_VAULT)).toBe('Add a Retry');
    // A heading is left as the owner wrote it, and a message that is only the opening says nothing.
    expect(deriveTitle('# Can you hear me\nthe rest', NO_VAULT)).toBe('Can You Hear Me');
    expect(deriveTitle('please', NO_VAULT)).toBeUndefined();
  });

  test('a message with nothing readable gives no title (the caller shows its opening words)', () => {
    expect(fileTitle({ firstMessage: '```\n```' }, NO_VAULT)).toBeNull();
    expect(fileTitle({ firstMessage: '   ' }, NO_VAULT)).toBeNull();
    expect(fileTitle({}, NO_VAULT)).toBeNull();
  });
});
