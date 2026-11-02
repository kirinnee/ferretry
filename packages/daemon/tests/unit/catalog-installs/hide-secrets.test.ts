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
