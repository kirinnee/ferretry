import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerCatalogCommands } from '../../../src/lib/catalog/commands';
import { CatalogController } from '../../../src/lib/catalog/controller';
import { CapturingOutput, CATALOG_ID, CWD, FakeGateway, MemoryFiles, SKILL_ID, ScriptedPrompt } from './fixtures';

function run(argv: string[]) {
  const gateway = new FakeGateway();
  const out = new CapturingOutput();
  const files = new MemoryFiles();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerCatalogCommands(program, new CatalogController(gateway, out, new ScriptedPrompt([]), files, false, CWD));
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), gateway, out, files };
}

describe('catalog command surface', () => {
  it('should list when no verb is given, and under the plural group name', async () => {
    const bare = run(['catalog']);
    await bare.parsed;
    should(bare.out.text).containEql('Team tools');
    const plural = run(['catalogs', 'ls']);
    await plural.parsed;
    should(plural.out.text).containEql('Team tools');
  });

  it('should print JSON from either side of the verb', async () => {
    const before = run(['catalog', '--json', 'ls']);
    await before.parsed;
    const after = run(['catalog', 'ls', '--json']);
    await after.parsed;
    should(JSON.parse(before.out.text).publisher).equal(JSON.parse(after.out.text).publisher);
  });

  it('should create with a description', async () => {
    const { parsed, gateway } = run(['catalog', 'create', 'Team tools', '--description', 'for us']);
    await parsed;
    should(gateway.calls[0]).eql({ call: 'create', request: { name: 'Team tools', description: 'for us' } });
  });

  it('should rename and describe', async () => {
    const renamed = run(['catalog', 'rename', 'Team tools', 'Better']);
    await renamed.parsed;
    should(renamed.gateway.calls.at(-1)).match({ call: 'update', request: { name: 'Better' } });
    const described = run(['catalog', 'describe', 'Team tools', 'about it']);
    await described.parsed;
    should(described.gateway.calls.at(-1)).match({ call: 'update', request: { description: 'about it' } });
  });

  it('should remove with --yes, also spelled remove', async () => {
    const { parsed, gateway } = run(['catalog', 'remove', 'Team tools', '--yes']);
    await parsed;
    should(gateway.calls.at(-1)).eql({ call: 'remove', catalogId: CATALOG_ID });
  });

  it('should add a skill and an MCP setup, with a summary', async () => {
    const skill = run(['catalog', 'add', 'Team tools', '--skill', 'pdf-tools', '--summary', 'mine', '-y']);
    await skill.parsed;
    should(skill.gateway.calls.at(-1)).match({
      call: 'add',
      request: { source: { kind: 'skill', skill: 'pdf-tools' }, summary: 'mine' },
    });
    const mcp = run(['catalog', 'add', 'Team tools', '--mcp', 'github', '--yes']);
    await mcp.parsed;
    should(mcp.gateway.calls.at(-1)).match({ call: 'add', request: { source: { kind: 'mcp', mcp: 'github' } } });
  });

  it('should publish and withdraw by item name', async () => {
    const published = run(['catalog', 'publish', 'Team tools', 'pdf-tools', '--yes']);
    await published.parsed;
    should(published.gateway.calls.at(-1)).match({ call: 'publishVersion', itemId: SKILL_ID });
    const withdrawn = run(['catalog', 'withdraw', 'Team tools', 'pdf-tools', '--yes']);
    await withdrawn.parsed;
    should(withdrawn.gateway.calls.at(-1)).match({ call: 'withdraw', itemId: SKILL_ID });
  });

  it('should export with repeated --item, --out and --force', async () => {
    const { parsed, gateway, files } = run([
      'catalog',
      'export',
      'Team tools',
      '--item',
      'pdf-tools',
      '--item',
      'github',
      '--out',
      '/tmp/x.json',
      '--force',
      '--yes',
    ]);
    await parsed;
    should(gateway.calls.at(-1)).match({ call: 'export', request: { itemIds: [SKILL_ID, `itm_${'m'.repeat(22)}`] } });
    should(files.written.get('/tmp/x.json')?.overwrite).equal(true);
  });
});
