import { describe, it } from 'bun:test';
import should from 'should';
import {
  ConnectorTextGuard,
  redactCredentialPatterns,
  REDACTED,
  WITHHELD,
} from '../../../../src/lib/connector/mcp/redaction.ts';

// Every sample is assembled from pieces so no real-looking credential sits in the source.
const part = (...pieces: string[]): string => pieces.join('');
const SAMPLES: Readonly<Record<string, string>> = {
  'ferretry session': part('fys', '_', 'abcdEFGH12345678abcd'),
  'connector access': part('fyc', '_at_', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg'),
  'connector refresh': part('fyc', '_rt_', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg'),
  anthropic: part('sk', '-ant-', 'api03-AbCdEfGhIjKlMnOp'),
  openai: part('sk', '-', 'proj-AbCdEfGhIjKlMnOpQrStUvWx'),
  'github classic': part('gh', 'p_', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'),
  'github fine': part('github', '_pat_', 'AbCdEfGhIjKlMnOpQrStUv_0123456789'),
  'aws access': part('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
  'aws session': part('AS', 'IA', 'ABCDEFGHIJKLMNOP'),
  slack: part('xox', 'b-', '1234567890-AbCdEfGhIj'),
  google: part('AI', 'za', 'SyA-AbCdEfGhIjKlMnOpQrStUvWxYz01234'),
  jwt: part('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'abcDEF123_-xyz'),
};

describe('redactCredentialPatterns', () => {
  for (const [name, sample] of Object.entries(SAMPLES)) {
    it(`masks a ${name} token`, () => {
      const out = redactCredentialPatterns(`before ${sample} after`);
      should(out).not.containEql(sample);
      should(out).containEql(REDACTED);
      should(out.startsWith('before ')).be.true();
      should(out.endsWith(' after')).be.true();
    });
  }

  it('masks a Bearer header value but keeps the word', () => {
    const out = redactCredentialPatterns('Authorization: Bearer abcdef0123456789xyz');
    should(out).not.containEql('abcdef0123456789xyz');
    should(out).containEql('Bearer');
  });

  it('masks a whole PEM private key block, and an unterminated one to the end', () => {
    const block = `-----BEGIN ${'RSA '}PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabcdef\n-----END ${'RSA '}PRIVATE KEY-----`;
    const out = redactCredentialPatterns(`x\n${block}\ny`);
    should(out).not.containEql('MIIEowIBAAKCAQEA');
    should(out).containEql('x');
    should(out).containEql('y');
    const cut = redactCredentialPatterns(`-----BEGIN ${'PRIVATE '}KEY-----\nMIIEvQIBADANBg\nmore`);
    should(cut).not.containEql('MIIEvQIBADANBg');
  });

  it('masks only the VALUE of password=, token=, secret=, api_key= assignments', () => {
    const cases: [string, string][] = [
      ['password=hunter22', 'password='],
      ['DB_PASSWORD: "correct horse"', 'DB_PASSWORD: '],
      ['{"api_key": "abc123xyz"}', '"api_key": '],
      ['export GITHUB_TOKEN=zzz999', 'GITHUB_TOKEN='],
      ["client_secret='s3cr3t value'", 'client_secret='],
    ];
    for (const [input, kept] of cases) {
      const out = redactCredentialPatterns(input);
      should(out).containEql(kept);
      should(out).containEql(REDACTED);
      should(out).not.match(/hunter22|correct horse|abc123xyz|zzz999|s3cr3t/u);
    }
  });

  it('masks the userinfo of a URL but keeps its host', () => {
    const out = redactCredentialPatterns('clone https://alice:pa55w0rd@git.example.com/repo.git now');
    should(out).not.containEql('pa55w0rd');
    should(out).not.containEql('alice');
    should(out).containEql('git.example.com/repo.git');
  });

  it('leaves ordinary prose and URLs alone', () => {
    const text = 'Visit https://example.com/path?a=1 and fix the token counter in sk-learn docs.';
    should(redactCredentialPatterns(text)).equal(text);
  });
});

describe('ConnectorTextGuard', () => {
  it('applies the stored-secret redactor and the patterns', async () => {
    const guard = new ConnectorTextGuard({ redact: async text => text.replaceAll('hunter2-value', '[secret]') });
    const out = await guard.clean(`a hunter2-value b ${SAMPLES.anthropic}`);
    should(out).containEql('[secret]');
    should(out).not.containEql(SAMPLES.anthropic as string);
  });

  it('fails closed when the secret redactor throws', async () => {
    const guard = new ConnectorTextGuard({
      redact: async () => {
        throw new Error('vault locked');
      },
    });
    should(await guard.clean('anything')).equal(WITHHELD);
    should(await guard.cleanAll(['a', 'b'])).eql([WITHHELD, WITHHELD]);
  });

  it('masks the live host admin and warden tokens, which no pattern would recognise', async () => {
    // Bare 43-character base64url values, assembled from pieces like every sample here.
    const admin = part('A1b2C3d4E5f6G7h8I9j0', 'K1l2M3n4O5p6Q7r8S9t0', 'U1v');
    const warden = part('Z9y8X7w6V5u4T3s2R1q0', 'P9o8N7m6L5k4J3i2H1g0', 'F9e');
    let live = [admin, warden, undefined, ''];
    const guard = new ConnectorTextGuard({ redact: async text => text }, () => live);

    const out = await guard.clean(`$ cat ~/.ferretry/api-token\n${admin}\nwarden ${warden}; again ${admin}`);

    should(out).not.containEql(admin);
    should(out).not.containEql(warden);
    should(out).containEql('$ cat ~/.ferretry/api-token');
    should(out.split(REDACTED).length - 1).equal(3);
    // Asked each time, so a token rotated while the daemon runs is covered from its next use.
    live = [warden];
    should(await guard.clean(`${admin} ${warden}`)).equal(`${admin} ${REDACTED}`);
  });

  it('never lets an empty or short live value mask everything, and withholds when the port throws', async () => {
    const trivial = new ConnectorTextGuard({ redact: async text => text }, () => ['', undefined, 'abc']);
    should(await trivial.clean('abc plain text')).equal('abc plain text');
    const broken = new ConnectorTextGuard({ redact: async text => text }, () => {
      throw new Error('no token');
    });
    should(await broken.clean('x')).equal(WITHHELD);
  });

  it('cleans every string inside data', async () => {
    const guard = new ConnectorTextGuard({ redact: async text => text });
    const out = (await guard.cleanData({ a: `x ${SAMPLES['ferretry session']}`, n: 3, l: ['password=abc'] })) as Record<
      string,
      unknown
    >;
    should(JSON.stringify(out)).not.containEql(SAMPLES['ferretry session'] as string);
    should(out.n).equal(3);
  });
});
