import { describe, it } from 'bun:test';
import should from 'should';
import type { CatalogChanges, CatalogMcpSetup } from '@ferretry/protocol';
import {
  mcpAsInstalled,
  setupOfProjectEntry,
  skillAsInstalled,
  withPlaceholders,
  withUnreadableFiles,
} from '../../../src/lib/catalog-installs/on-disk-item.ts';
import { mcpItem, skillItem } from '../../support/catalog-fixtures.ts';

/** An item as this machine has it on disk now, rebuilt so a diff can read it against an offered version. */

const DAEMON = `fy_daemon_${'A'.repeat(43)}`;

const command = (env: Record<string, string>): CatalogMcpSetup => ({
  transport: 'command',
  command: 'acme-mcp',
  args: ['--stdio'],
  env,
});

describe('skillAsInstalled', () => {
  it('should carry the files on disk and the version the install recorded', () => {
    const item = skillItem(DAEMON, { itemVersion: 4 });
    if (item.kind !== 'skill') throw new Error('fixture');
    const built = skillAsInstalled(item, 2, new Map([['SKILL.md', 'mine']]));
    should(built.itemVersion).equal(2);
    should(built.skill.files).deepEqual([{ path: 'SKILL.md', content: 'mine' }]);
  });
});

describe('mcpAsInstalled', () => {
  it('should carry the setup on disk and the version the install recorded', () => {
    const item = mcpItem(DAEMON, { itemVersion: 3 });
    if (item.kind !== 'mcp') throw new Error('fixture');
    const built = mcpAsInstalled(item, 1, command({}));
    should(built.itemVersion).equal(1);
    should(built.mcp).deepEqual(command({}));
  });
});

describe('setupOfProjectEntry', () => {
  it('should read a command entry, naming the person’s variables as placeholders', () => {
    should(
      setupOfProjectEntry({
        command: 'acme-mcp',
        args: ['--stdio'],
        env: { ACME_TOKEN: '${ACME_TOKEN_OWN}', MODE: 'x' },
      }),
    ).deepEqual(command({ ACME_TOKEN: '${secret:ACME_TOKEN_OWN}', MODE: 'x' }));
  });

  it('should read an entry with no arguments or environment', () => {
    should(setupOfProjectEntry({ command: 'acme-mcp' })).deepEqual({
      transport: 'command',
      command: 'acme-mcp',
      args: [],
      env: {},
    });
  });

  it('should read an entry reached by address', () => {
    should(setupOfProjectEntry({ type: 'http', url: 'https://mcp.example.com/x' })).deepEqual({
      transport: 'url',
      url: 'https://mcp.example.com/x',
    });
  });

  it('should answer nothing for what an install does not write', () => {
    should(setupOfProjectEntry('nope')).be.undefined();
    should(setupOfProjectEntry(undefined)).be.undefined();
    should(setupOfProjectEntry({ args: ['x'] })).be.undefined();
    should(setupOfProjectEntry({ command: 'acme-mcp', env: 'bad' })).deepEqual({
      transport: 'command',
      command: 'acme-mcp',
      args: [],
      env: {},
    });
    should(setupOfProjectEntry({ command: 'acme-mcp', env: { A: 5 } })).be.undefined();
  });
});

describe('withPlaceholders', () => {
  it('should leave a setup reached by address as it is', () => {
    const url: CatalogMcpSetup = { transport: 'url', url: 'https://mcp.example.com/x' };
    should(withPlaceholders(url, url, {})).deepEqual(url);
  });

  it('should turn a bound value back into the placeholder it came from, and leave a literal', () => {
    should(
      withPlaceholders(
        command({ ACME_TOKEN: '${secret:OWN}', MODE: 'x', LOOSE: '${secret:NOBODY}' }),
        command({ ACME_TOKEN: '${secret:ACME_TOKEN}', MODE: 'x' }),
        { ACME_TOKEN: 'OWN' },
      ),
    ).deepEqual(command({ ACME_TOKEN: '${secret:ACME_TOKEN}', MODE: 'x', LOOSE: '${secret:NOBODY}' }));
  });

  it('should settle a variable two placeholders share by the one the offered setup uses there', () => {
    const bindings = { B_TOKEN: 'OWN', A_TOKEN: 'OWN' };
    should(withPlaceholders(command({ T: '${secret:OWN}' }), command({ T: '${secret:B_TOKEN}' }), bindings)).deepEqual(
      command({ T: '${secret:B_TOKEN}' }),
    );
    should(withPlaceholders(command({ T: '${secret:OWN}' }), command({ T: 'plain' }), bindings)).deepEqual(
      command({ T: '${secret:A_TOKEN}' }),
    );
  });

  it('should put back a placeholder the install left unbound, which is on disk as nothing at all', () => {
    should(
      withPlaceholders(command({}), command({ ACME_TOKEN: '${secret:ACME_TOKEN}' }), { ACME_TOKEN: null }),
    ).deepEqual(command({ ACME_TOKEN: '${secret:ACME_TOKEN}' }));
    const url: CatalogMcpSetup = { transport: 'url', url: 'https://mcp.example.com/x' };
    should(withPlaceholders(command({}), url, { ACME_TOKEN: null })).deepEqual(command({}));
  });
});

describe('withUnreadableFiles', () => {
  const changes: CatalogChanges = {
    entries: [
      { label: 'Skill file SKILL.md', change: 'changed', document: true },
      { label: 'Skill file big.bin', change: 'changed', document: true },
    ],
    unchanged: 0,
    newWarnings: [],
    goneWarnings: [],
  };

  it('should mark a file it could not read as too large to show, changed or removed by the offered version', () => {
    const offered = skillItem(DAEMON, {
      files: [
        { path: 'SKILL.md', content: 'x' },
        { path: 'big.bin', content: 'y' },
      ],
    });
    if (offered.kind !== 'skill') throw new Error('fixture');
    const marked = withUnreadableFiles(changes, ['big.bin', 'old.bin'], offered);
    should(marked.entries.map(entry => [entry.label, entry.change, entry.tooLarge])).deepEqual([
      ['Skill file big.bin', 'changed', true],
      ['Skill file old.bin', 'removed', true],
      ['Skill file SKILL.md', 'changed', undefined],
    ]);
  });
});
