import { describe, it } from 'bun:test';
import should from 'should';
import { CatalogController } from '../../../src/lib/catalog/controller';
import {
  CapturingOutput,
  CATALOG_ID,
  CWD,
  catalog,
  FakeGateway,
  MemoryFiles,
  MCP_ID,
  NEW_DIGEST,
  preview,
  SKILL_ID,
  ScriptedPrompt,
  skillItem,
} from './fixtures';

function build(
  options: { answers?: string[]; interactive?: boolean; files?: MemoryFiles; gateway?: FakeGateway } = {},
) {
  const gateway = options.gateway ?? new FakeGateway();
  const out = new CapturingOutput();
  const prompt = new ScriptedPrompt(options.answers ?? []);
  const files = options.files ?? new MemoryFiles();
  const controller = new CatalogController(gateway, out, prompt, files, options.interactive ?? true, CWD);
  return { controller, gateway, out, prompt, files };
}

const writes = (gateway: FakeGateway) => gateway.calls.filter(call => call.call !== 'list' && call.call !== 'preview');

describe('fy catalog ls', () => {
  it('should print the catalogs, or the payload with --json', async () => {
    const human = build();
    await human.controller.list({});
    should(human.out.text).containEql('Team tools');

    const json = build();
    await json.controller.list({ json: true });
    should(JSON.parse(json.out.text).catalogs).have.length(1);
  });
});

describe('fy catalog create / rename / describe', () => {
  it('should create with a trimmed name and only the description that was given', async () => {
    const { controller, gateway, out } = build();
    await controller.create('  Team tools ', { description: 'for us' });
    await controller.create('Bare', {});
    should(gateway.calls[0]).eql({ call: 'create', request: { name: 'Team tools', description: 'for us' } });
    should(gateway.calls[1]).eql({ call: 'create', request: { name: 'Bare' } });
    should(out.lines[0]).startWith('Created catalog Team tools');
  });

  it('should rename by name, sending the id', async () => {
    const { controller, gateway, out } = build();
    await controller.rename('team tools', ' Better ', {});
    should(gateway.calls.at(-1)).eql({ call: 'update', catalogId: CATALOG_ID, request: { name: 'Better' } });
    should(out.text).containEql('is now at revision 4');
  });

  it('should describe by id', async () => {
    const { controller, gateway } = build();
    await controller.describe(CATALOG_ID, 'about', { json: true });
    should(gateway.calls.at(-1)).eql({ call: 'update', catalogId: CATALOG_ID, request: { description: 'about' } });
  });
});

describe('fy catalog rm', () => {
  it('should delete after a yes', async () => {
    const { controller, gateway, prompt, out } = build({ answers: ['y'] });
    await controller.remove('Team tools', {});
    should(prompt.asked[0]).containEql('Delete catalog Team tools');
    should(gateway.calls.at(-1)).eql({ call: 'remove', catalogId: CATALOG_ID });
    should(out.text).containEql('Deleted catalog Team tools');
  });

  it('should delete without asking under --yes', async () => {
    const { controller, prompt, gateway } = build();
    await controller.remove('Team tools', { yes: true });
    should(prompt.asked).have.length(0);
    should(writes(gateway)).have.length(1);
  });

  it('should refuse and delete nothing on anything but yes', async () => {
    const { controller, gateway } = build({ answers: ['n'] });
    await should(controller.remove('Team tools', {})).rejectedWith('cancelled — nothing was changed');
    should(writes(gateway)).have.length(0);
  });

  it('should refuse off a terminal without --yes', async () => {
    const { controller, gateway } = build({ interactive: false });
    await should(controller.remove('Team tools', {})).rejectedWith(/pass --yes/);
    should(writes(gateway)).have.length(0);
  });
});

describe('fy catalog add', () => {
  it('should preview, show it all, ask, then add with the preview digest', async () => {
    const { controller, gateway, out, prompt } = build({ answers: ['Yes'] });
    await controller.add('Team tools', { skill: '/s/pdf-tools/SKILL.md', summary: 'mine' });
    should(gateway.calls.slice(1)).eql([
      {
        call: 'preview',
        catalogId: CATALOG_ID,
        request: { source: { kind: 'skill', skill: '/s/pdf-tools/SKILL.md' }, summary: 'mine' },
      },
      {
        call: 'add',
        catalogId: CATALOG_ID,
        request: { source: { kind: 'skill', skill: '/s/pdf-tools/SKILL.md' }, digest: NEW_DIGEST, summary: 'mine' },
      },
    ]);
    should(out.lines[0]).containEql('line two');
    should(prompt.asked[0]).containEql('Add skill pdf-tools to Team tools exactly as shown above? [y/N]');
    should(out.lines[1]).startWith('Published pdf-tools version 1');
  });

  it('should add an MCP setup with --yes and no summary', async () => {
    const { controller, gateway, prompt } = build();
    await controller.add('Team tools', { mcp: 'github', yes: true });
    should(prompt.asked).have.length(0);
    should(gateway.calls.at(-1)).eql({
      call: 'add',
      catalogId: CATALOG_ID,
      request: { source: { kind: 'mcp', mcp: 'github' }, digest: NEW_DIGEST },
    });
  });

  it('should add nothing when the answer is no', async () => {
    const { controller, gateway } = build({ answers: [''] });
    await should(controller.add('Team tools', { skill: 'x' })).rejectedWith(/^cancelled/);
    should(writes(gateway)).have.length(0);
  });

  it('should send the preview to stderr, and one payload to stdout, with --json', async () => {
    const { controller, out } = build();
    await controller.add('Team tools', { skill: 'x', yes: true, json: true });
    should(JSON.parse(out.diagnostics[0] ?? '{}').phase).equal('preview');
    should(out.lines).have.length(1);
    should(JSON.parse(out.text).itemVersion).equal(1);
  });

  it('should ask for exactly one source before calling the daemon', async () => {
    const { controller, gateway } = build();
    await should(controller.add('Team tools', {})).rejectedWith(/say what to add/);
    await should(controller.add('Team tools', { skill: 'a', mcp: 'b' })).rejectedWith(/only one of --skill, --mcp/);
    should(gateway.calls).have.length(0);
  });
});

describe('fy catalog publish', () => {
  it('should preview the next version from the remembered source and publish with its digest', async () => {
    const gateway = new FakeGateway({ catalogs: [catalog()], preview: preview({ version: 2, itemId: SKILL_ID }) });
    const { controller, prompt } = build({ gateway, answers: ['y'] });
    await controller.publish('Team tools', 'pdf-tools', {});
    should(gateway.calls.slice(1)).eql([
      { call: 'preview', catalogId: CATALOG_ID, request: { itemId: SKILL_ID } },
      { call: 'publishVersion', catalogId: CATALOG_ID, itemId: SKILL_ID, request: { digest: NEW_DIGEST } },
    ]);
    should(prompt.asked[0]).containEql('Publish version 2 of pdf-tools');
  });

  it('should say there is nothing to publish when the copy is the same, and write nothing', async () => {
    const gateway = new FakeGateway({ catalogs: [catalog()], preview: preview({ sameAsVersion: 1 }) });
    const { controller, out } = build({ gateway });
    await controller.publish('Team tools', SKILL_ID, { yes: true });
    should(out.text).equal('pdf-tools has not changed since version 1; there is nothing to publish.');
    should(writes(gateway)).have.length(0);
  });

  it('should refuse a withdrawn item', async () => {
    const withdrawnItem = skillItem({ withdrawnAt: '2026-10-31T10:00:00.000Z', sourceState: 'withdrawn' });
    const gateway = new FakeGateway({ catalogs: [catalog({ items: [withdrawnItem] })], preview: preview() });
    const { controller } = build({ gateway });
    await should(controller.publish('Team tools', SKILL_ID, { yes: true })).rejectedWith(/was withdrawn/);
  });
});

describe('fy catalog withdraw', () => {
  it('should withdraw by item name after a yes', async () => {
    const { controller, gateway, out, prompt } = build({ answers: ['y'] });
    await controller.withdraw('Team tools', 'pdf-tools', {});
    should(prompt.asked[0]).containEql('Withdraw pdf-tools');
    should(gateway.calls.at(-1)).eql({ call: 'withdraw', catalogId: CATALOG_ID, itemId: SKILL_ID });
    should(out.text).startWith('Withdrew pdf-tools');
  });

  it('should withdraw nothing when not confirmed', async () => {
    const { controller, gateway } = build({ interactive: false });
    await should(controller.withdraw('Team tools', MCP_ID, {})).rejected();
    should(writes(gateway)).have.length(0);
  });
});

describe('fy catalog export', () => {
  it('should write <slug>.catalog.json in the working directory, without overwriting', async () => {
    const { controller, gateway, files, out } = build();
    await controller.export('Team tools', {});
    const path = `${CWD}/team-tools.catalog.json`;
    should(gateway.calls.at(-1)).eql({ call: 'export', catalogId: CATALOG_ID, request: {} });
    should(files.written.get(path)?.overwrite).equal(false);
    should(files.written.get(path)?.text.endsWith('}\n')).equal(true);
    should(JSON.parse(files.written.get(path)?.text ?? '').format).equal('ferretry-catalog-file');
    should(out.text).equal(`Exported Team tools (1 item) to ${path}.`);
  });

  it('should refuse to replace a file without --force, before asking the daemon to sign', async () => {
    const files = new MemoryFiles([`${CWD}/team-tools.catalog.json`]);
    const { controller, gateway } = build({ files });
    await should(controller.export('Team tools', {})).rejectedWith(/already exists — pass --force/);
    should(gateway.calls.some(call => call.call === 'export')).equal(false);
  });

  it('should replace it with --force, and write to --out relative to the working directory', async () => {
    const files = new MemoryFiles([`${CWD}/out/c.json`]);
    const { controller, gateway } = build({ files });
    await controller.export('Team tools', { out: 'out/c.json', force: true, item: ['pdf-tools', MCP_ID], json: true });
    should(gateway.calls.at(-1)).eql({
      call: 'export',
      catalogId: CATALOG_ID,
      request: { itemIds: [SKILL_ID, MCP_ID] },
    });
    should(files.written.get(`${CWD}/out/c.json`)?.overwrite).equal(true);
  });

  it('should refuse an item the catalog does not have before signing anything', async () => {
    const { controller, gateway } = build();
    await should(controller.export('Team tools', { item: ['ghost'] })).rejectedWith('no item in Team tools "ghost"');
    should(gateway.calls.some(call => call.call === 'export')).equal(false);
  });
});
