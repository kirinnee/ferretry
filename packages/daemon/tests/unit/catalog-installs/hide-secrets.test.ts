import { describe, it } from 'bun:test';
import type { SharedCatalogItem } from '@ferretry/protocol';
import should from 'should';
import { HIDDEN, HIDDEN_DIFFERENT, hideSecrets } from '../../../src/lib/catalog-installs/hide-secrets.ts';

const base = { format: 'ferretry-catalog-item', version: 1, publisher: 'p', catalogId: 'c', itemId: 'i', name: 'x' };
const mcp = (setup: object) =>
  ({ ...base, kind: 'mcp', mcp: setup }) as unknown as Extract<SharedCatalogItem, { kind: 'mcp' }>;
const skill = (...files: [string, string][]) =>
  ({
    ...base,
    kind: 'skill',
    skill: { files: files.map(([path, content]) => ({ path, content })) },
  }) as unknown as Extract<SharedCatalogItem, { kind: 'skill' }>;
const command = (extra: object) => mcp({ transport: 'command', command: 'run', args: [], env: {}, ...extra });

describe('hideSecrets: servers', () => {
  it('should keep a whole placeholder and a harmless value, and cut a secret-looking literal', () => {
    const [before] = hideSecrets(
      command({ env: { A_TOKEN: '${secret:A_TOKEN}', MODE: 'production', DB_PASSWORD: 'hunter2xyz' } }),
      command({}),
    );
    should((before as { mcp: { env: unknown } }).mcp.env).eql({
      A_TOKEN: '${secret:A_TOKEN}',
      MODE: 'production',
      DB_PASSWORD: HIDDEN,
    });
  });

  it('should cut a secret in the command, an argument and the address, and the user info of an address', () => {
    const [one] = hideSecrets(
      command({ command: 'run API_KEY=sk-abcdefghijklmnop', args: ['--token=ghp_abcdefghijklmnop'] }),
      command({}),
    );
    const text = JSON.stringify(one);
    should(text).not.match(/sk-abcdef|ghp_abcdef/u);
    const [url] = hideSecrets(
      mcp({ transport: 'url', url: 'https://user:pass1234@mcp.example.com/x?api_key=abcdefghijkl' }),
      mcp({ transport: 'url', url: 'https://mcp.example.com' }),
    );
    should(JSON.stringify(url)).not.match(/pass1234|abcdefghijkl/u);
  });

  it('should mark a value hidden on both sides but different, and not one that is the same', () => {
    const [, same] = hideSecrets(
      command({ env: { DB_PASSWORD: 'hunter2xyz' } }),
      command({ env: { DB_PASSWORD: 'hunter2xyz' } }),
    );
    should((same as { mcp: { env: unknown } }).mcp.env).eql({ DB_PASSWORD: HIDDEN });
    const [, different] = hideSecrets(
      command({ env: { DB_PASSWORD: 'hunter2xyz' } }),
      command({ env: { DB_PASSWORD: 'swordfish99' } }),
    );
    should((different as { mcp: { env: unknown } }).mcp.env).eql({ DB_PASSWORD: HIDDEN_DIFFERENT });
  });

  it('should compare against a server reached by address as if it had no environment', () => {
    const [, offered] = hideSecrets(
      mcp({ transport: 'url', url: 'https://a.example.com' }),
      command({ env: { DB_PASSWORD: 'hunter2xyz' } }),
    );
    should((offered as { mcp: { env: unknown } }).mcp.env).eql({ DB_PASSWORD: HIDDEN });
  });
});

describe('hideSecrets: names, flags and addresses', () => {
  const setupOf = (item: unknown) =>
    (item as { mcp: { args: string[]; env: Record<string, string>; command: string } }).mcp;

  it('should hide a value at any length when its name announces a secret, and keep references', () => {
    const [one] = hideSecrets(
      command({
        env: { DB_PASSWORD: 'hunter2', A_TOKEN: '$TOKEN', B_TOKEN: '${secret:B}', MODE: 'dev', EMPTY_TOKEN: '' },
      }),
      command({}),
    );
    should(setupOf(one).env).eql({
      DB_PASSWORD: HIDDEN,
      A_TOKEN: '$TOKEN',
      B_TOKEN: '${secret:B}',
      MODE: 'dev',
      EMPTY_TOKEN: '',
    });
  });

  it('should cut the password after a flag that names one, and the value of such a flag written with =', () => {
    const [one] = hideSecrets(
      command({
        args: [
          '--password',
          'hunter2xyz',
          '--api-key=short1',
          '--token',
          '$TOKEN',
          '--mode',
          'fast',
          '--password',
          '--x',
        ],
      }),
      command({}),
    );
    should(setupOf(one).args).eql([
      '--password',
      HIDDEN,
      '--api-key=' + HIDDEN,
      '--token',
      '$TOKEN',
      '--mode',
      'fast',
      '--password',
      '--x',
    ]);
  });

  it('should cut user info and a query secret out of an environment value', () => {
    const [one] = hideSecrets(command({ env: { DB_URL: 'postgres://app:pa55word99@db/app' } }), command({}));
    should(setupOf(one).env.DB_URL).equal(`postgres://${HIDDEN}@db/app`);
  });

  it('should say a hidden change differs in the command, an argument and an address', () => {
    const [, offered] = hideSecrets(
      command({ command: 'run API_KEY=sk-aaaaaaaaaaaaaaaa', args: ['--token=ghp_aaaaaaaaaaaaaaaa'] }),
      command({ command: 'run API_KEY=sk-bbbbbbbbbbbbbbbb', args: ['--token=ghp_bbbbbbbbbbbbbbbb'] }),
    );
    should(setupOf(offered).command).equal(`run API_KEY=${HIDDEN_DIFFERENT}`);
    should(setupOf(offered).args).eql(['--token=' + HIDDEN_DIFFERENT]);
    const [, url] = hideSecrets(
      mcp({ transport: 'url', url: 'https://a.example.com/x?api_key=aaaaaaaaaaaa' }),
      mcp({ transport: 'url', url: 'https://a.example.com/x?api_key=bbbbbbbbbbbb' }),
    );
    should((url as { mcp: { url: string } }).mcp.url).equal(`https://a.example.com/x?api_key=${HIDDEN_DIFFERENT}`);
  });

  it('should say a hidden change differs in a file whose lines are cut', () => {
    const [, same] = hideSecrets(
      skill(['a.md', 'API_TOKEN=exampleexample1\n']),
      skill(['a.md', 'API_TOKEN=exampleexample1\n']),
    );
    should((same as { skill: { files: { content: string }[] } }).skill.files[0]?.content).equal(
      `API_TOKEN=${HIDDEN}\n`,
    );
    const [, other] = hideSecrets(
      skill(['a.md', 'API_TOKEN=myrealtoken99x\n']),
      skill(['a.md', 'API_TOKEN=exampleexample1\n']),
    );
    should((other as { skill: { files: { content: string }[] } }).skill.files[0]?.content).equal(
      `API_TOKEN=${HIDDEN_DIFFERENT}\n`,
    );
  });
});

describe('hideSecrets: leftovers', () => {
  const contentOf = (item: unknown) => (item as { skill: { files: { content: string }[] } }).skill.files[0]?.content;
  const one = (text: string) => contentOf(hideSecrets(skill(['a.md', text]), skill())[0]);
  const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

  it.each([
    ['trailing space', `notes\ngh \np_${TOKEN.slice(3)}\n`],
    ['a bare carriage return', `notes\rgh\rp_${TOKEN.slice(3)}\r`],
    ['a path before the break', `see path/gh\np_${TOKEN.slice(3)}\n`],
    ['blank lines between', `notes\ngh\n\n   \np_${TOKEN.slice(3)}\n`],
  ])('should hide a token split across lines with %s', (_label, text) => {
    should(one(text)).equal(HIDDEN);
  });

  it('should cut a short password after its name, on the same line or the next', () => {
    should(one('password: hunter2\nrest')).equal(`password: ${HIDDEN}\nrest`);
    should(one('password:\nhunter2\nrest')).equal(`password:\n${HIDDEN}\nrest`);
  });

  it('should hide PASS and DB_PASS values and the argument after --pass, and leave -p alone', () => {
    const [shown] = hideSecrets(
      command({ args: ['--pass', 'hunter2', '-p', '5432'], env: { PASS: 'hunter2', DB_PASS: 'x1' } }),
      command({}),
    );
    should((shown as { mcp: { args: string[]; env: unknown } }).mcp.args).eql(['--pass', HIDDEN, '-p', '5432']);
    should((shown as { mcp: { env: unknown } }).mcp.env).eql({ PASS: HIDDEN, DB_PASS: HIDDEN });
  });
});

describe('hideSecrets: bounded work', () => {
  // A quadratic pattern would take minutes on these; hiding them whole takes none, because no pattern runs on them.
  const WITHIN_MS = 5000;
  const contentOf = (item: unknown) => (item as { skill: { files: { content: string }[] } }).skill.files[0]?.content;
  const timed = (text: string) => {
    const started = performance.now();
    const [one] = hideSecrets(skill(['a.md', text]), skill());
    return { shown: contentOf(one), took: performance.now() - started };
  };

  it('should hide a 256 KiB single-line file whole, without running a pattern on it', () => {
    const { shown, took } = timed('a'.repeat(256 * 1024));
    should(shown).equal(HIDDEN);
    should(took).be.below(WITHIN_MS);
  });

  it('should hide a hundred-line file with one 20 KB line, and a 40 KB hex line, whole', () => {
    const { shown, took } = timed(`${'one short line\n'.repeat(100)}${'ab'.repeat(10_000)}\nend\n`);
    should(shown).equal(HIDDEN);
    should(took).be.below(WITHIN_MS);
    const hex = timed('0123456789abcdef'.repeat(2_560));
    should(hex.shown).equal(HIDDEN);
    should(hex.took).be.below(WITHIN_MS);
  });

  it('should hide a file with a word over 1 KiB on a line under 4 KiB, and keep one with only short words', () => {
    should(timed(`ok\n${'x'.repeat(1_500)} tail\n`).shown).equal(HIDDEN);
    should(timed(`${'word '.repeat(700)}\n`).shown).equal(`${'word '.repeat(700)}\n`);
  });

  it('should finish on a long run of query marks, many short lines and many blank lines', () => {
    const started = performance.now();
    hideSecrets(command({ command: `run ${'?'.repeat(1_000)}` }), command({}));
    const shown = timed(`${'x\n'.repeat(19_000)}${'\n'.repeat(100_000)}end`).shown;
    should(shown).equal(`${'x\n'.repeat(19_000)}${'\n'.repeat(100_000)}end`);
    should(performance.now() - started).be.below(WITHIN_MS);
  });

  it('should hide a file with too many lines to check for a split secret, whole', () => {
    should(timed('x\ny\n'.repeat(10_001)).shown).equal(HIDDEN);
  });
});

describe('hideSecrets: skills', () => {
  it('should leave a file with nothing secret as it is', () => {
    const [before, after] = hideSecrets(skill(['SKILL.md', '# one\n']), skill(['SKILL.md', '# two\n']));
    should(JSON.stringify([before, after])).match(/# one/u);
  });

  it('should cut a secret line by line and keep the rest', () => {
    const [before] = hideSecrets(skill(['SKILL.md', 'keep\nAPI_TOKEN=ghp_abcdefghijklmnop\nthis\n']), skill());
    const text = (before as { skill: { files: { content: string }[] } }).skill.files[0]?.content;
    should(text).equal(`keep\nAPI_TOKEN=${HIDDEN}\nthis\n`);
  });

  it('should hide a whole file when a secret is split over lines, or it holds a private key', () => {
    const split = 'before gh\np_abcdefghijklmnopqrstuv\nafter';
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\n';
    const [a, b] = hideSecrets(skill(['a.md', split], ['b.md', key]), skill());
    should((a as { skill: { files: { content: string }[] } }).skill.files.map(file => file.content)).eql([
      HIDDEN,
      HIDDEN,
    ]);
    should(b).be.ok();
  });

  it('should say a wholly hidden file differs from an offered one that is hidden too, only when it does', () => {
    const split = (tail: string) => `x gh\np_abcdefghijklmnopqrstuv\n${tail}`;
    const [, same] = hideSecrets(skill(['a.md', split('a')]), skill(['a.md', split('a')]));
    should((same as { skill: { files: { content: string }[] } }).skill.files[0]?.content).equal(HIDDEN);
    const [, different] = hideSecrets(skill(['a.md', split('a')]), skill(['a.md', split('b')]));
    should((different as { skill: { files: { content: string }[] } }).skill.files[0]?.content).equal(HIDDEN_DIFFERENT);
  });

  it('should not compare a skill with a server', () => {
    const one = skill(['a.md', 'x']);
    const two = command({});
    should(hideSecrets(one, two)).eql([one, two]);
  });
});
