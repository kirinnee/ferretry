import { describe, it } from 'bun:test';
import should from 'should';
import { CatalogController } from '../../../src/lib/catalog/controller';
import {
  AT,
  CATALOG_ID,
  CapturingOutput,
  CWD,
  catalog,
  DIGEST,
  FakeGateway,
  MCP_ID,
  MemoryFiles,
  mcpItem,
  NEW_DIGEST,
  preview,
  ScriptedPrompt,
  SKILL_ID,
  sharedItem,
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
    should(human.gateway.calls[0]).eql({ call: 'list', sourceState: true });

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

  it('should refuse, writing nothing, a copy that is exactly an older version again', async () => {
    const older = skillItem({
      current: 3,
      versions: [1, 2, 3].map(number => ({ version: number, digest: DIGEST, size: 120, publishedAt: AT })),
    });
    const gateway = new FakeGateway({
      catalogs: [catalog({ items: [older] })],
      preview: preview({ sameAsVersion: 1 }),
    });
    const { controller } = build({ gateway });
    await should(controller.publish('Team tools', SKILL_ID, { yes: true })).rejectedWith(
      /exactly version 1 again; making an older version current is not built yet/,
    );
    should(writes(gateway)).have.length(0);
  });

  it('should refuse a withdrawn item', async () => {
    const withdrawnItem = skillItem({ withdrawnAt: '2026-10-31T10:00:00.000Z', sourceState: 'withdrawn' });
    const gateway = new FakeGateway({ catalogs: [catalog({ items: [withdrawnItem] })], preview: preview() });
    const { controller } = build({ gateway });
    await should(controller.publish('Team tools', SKILL_ID, { yes: true })).rejectedWith(/was withdrawn/);
  });
});

describe('fy catalog publish — what changed', () => {
  const changes = {
    entries: [
      {
        label: 'Starts',
        change: 'changed' as const,
        document: false,
        before: 'a',
        after: 'b',
        flag: 'command' as const,
      },
    ],
    unchanged: 1,
    newWarnings: [],
    goneWarnings: [],
  };

  it('should print what changed before it asks, and ask only after', async () => {
    const gateway = new FakeGateway({
      catalogs: [catalog()],
      preview: preview({ version: 2, itemId: SKILL_ID, changes }),
    });
    const { controller, out, prompt } = build({ gateway, answers: ['y'] });
    await controller.publish('Team tools', 'pdf-tools', {});
    should(out.lines[0]).containEql('What changed since the version installers get now:');
    should(out.lines[0]).containEql('~ Starts [command]');
    should(prompt.asked).have.length(1);
  });

  it('should keep the changes in the JSON preview on stderr', async () => {
    const gateway = new FakeGateway({
      catalogs: [catalog()],
      preview: preview({ version: 2, itemId: SKILL_ID, changes }),
    });
    const { controller, out } = build({ gateway });
    await controller.publish('Team tools', 'pdf-tools', { yes: true, json: true });
    should(JSON.parse(out.diagnostics[0] as string).preview.changes.entries[0].label).equal('Starts');
  });
});

describe('fy catalog versions', () => {
  it('should list the versions of one item and write nothing', async () => {
    const { controller, gateway, out } = build();
    await controller.versions('Team tools', 'pdf-tools', {});
    should(gateway.calls.map(call => call.call)).eql(['list', 'getItem']);
    should(out.text).containEql('pdf-tools (' + SKILL_ID + ') · 1 version');
  });

  it('should refuse an item the catalog does not list', async () => {
    const { controller, gateway } = build();
    await should(controller.versions('Team tools', 'nope', {})).rejectedWith(/nope/);
    should(gateway.calls.some(call => call.call === 'getItem')).equal(false);
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
  it('should list what it will sign, ask, and write <slug>.catalog.json without overwriting', async () => {
    const { controller, gateway, files, out, prompt } = build({ answers: ['y'] });
    await controller.export('Team tools', {});
    const path = `${CWD}/team-tools.catalog.json`;
    should(gateway.calls.at(-1)).eql({ call: 'export', catalogId: CATALOG_ID, request: {} });
    should(out.lines[0]).containEql('This will sign Team tools');
    should(out.lines[0]).containEql(`pdf-tools v1 ${DIGEST}`);
    should(out.lines[0]).containEql('published as laptop');
    should(prompt.asked[0]).startWith('Sign Team tools with the items listed above?');
    should(files.written.get(path)?.overwrite).equal(false);
    should(files.written.get(path)?.text.endsWith('}\n')).equal(true);
    should(files.written.get(path)?.text.trimEnd().includes('\n')).equal(false);
    should(JSON.parse(files.written.get(path)?.text ?? '').format).equal('ferretry-catalog-file');
    should(out.lines.at(-1)).equal(`Exported Team tools (1 item) to ${path}.`);
  });

  it('should write nothing when the answer is not yes, and not sign anything', async () => {
    const { controller, gateway, files } = build({ answers: ['n'] });
    await should(controller.export('Team tools', {})).rejectedWith(/cancelled/);
    should(gateway.calls.some(call => call.call === 'export')).equal(false);
    should(files.written.size).equal(0);
  });

  it('should still print what it signs with --yes, and with --json send that to stderr', async () => {
    const human = build();
    await human.controller.export('Team tools', { yes: true });
    should(human.prompt.asked).have.length(0);
    should(human.out.lines[0]).containEql('This will sign');

    const json = build();
    await json.controller.export('Team tools', { yes: true, json: true });
    should(JSON.parse(json.out.diagnostics[0] ?? '{}')).containEql({ phase: 'sign' });
    should(JSON.parse(json.out.lines[0] ?? '{}').path).containEql('team-tools.catalog.json');
  });

  it('should say there are no items when none is live, and need --yes off a terminal', async () => {
    const empty = new FakeGateway({ catalogs: [catalog({ items: [] })], preview: preview() });
    const { controller, out } = build({ gateway: empty });
    await controller.export('Team tools', { yes: true });
    should(out.lines[0]).containEql('no items');

    const quiet = build({ interactive: false });
    await should(quiet.controller.export('Team tools', {})).rejectedWith(/pass --yes/);
  });

  it('should list a withdrawn item as not signed', async () => {
    const gateway = new FakeGateway({
      catalogs: [catalog({ items: [skillItem(), mcpItem({ withdrawnAt: '2026-10-31T10:00:00.000Z' })] })],
      preview: preview(),
    });
    const { controller, out } = build({ gateway });
    await controller.export('Team tools', { yes: true });
    should(out.lines[0]).not.containEql('github');
  });

  it('should write nothing when the daemon signed different items than the ones shown', async () => {
    const gateway = new FakeGateway();
    gateway.signedDigest = NEW_DIGEST;
    const { controller, files } = build({ gateway });
    await should(controller.export('Team tools', { yes: true })).rejectedWith(/signed different items/);
    should(files.written.size).equal(0);
  });

  it('should write nothing when the daemon signed a different number of items', async () => {
    const gateway = new FakeGateway();
    const original = gateway.export.bind(gateway);
    gateway.export = async (catalogId, request) => {
      const file = await original(catalogId, request);
      return {
        ...file,
        signedManifest: {
          ...file.signedManifest,
          manifest: { ...file.signedManifest.manifest, items: file.signedManifest.manifest.items.slice(0, 1) },
        },
      };
    };
    const { controller, files } = build({ gateway });
    await should(controller.export('Team tools', { yes: true })).rejectedWith(/signed different items/);
    should(files.written.size).equal(0);
  });

  it('should refuse to replace a file without --force, before asking the daemon to sign', async () => {
    const files = new MemoryFiles([`${CWD}/team-tools.catalog.json`]);
    const { controller, gateway } = build({ files });
    await should(controller.export('Team tools', { yes: true })).rejectedWith(/already exists — pass --force/);
    should(gateway.calls.some(call => call.call === 'export')).equal(false);
  });

  it('should replace it with --force, and write to --out relative to the working directory', async () => {
    const files = new MemoryFiles([`${CWD}/out/c.json`]);
    const { controller, gateway } = build({ files });
    await controller.export('Team tools', {
      out: 'out/c.json',
      force: true,
      item: ['pdf-tools', MCP_ID],
      json: true,
      yes: true,
    });
    should(gateway.calls.at(-1)).eql({
      call: 'export',
      catalogId: CATALOG_ID,
      request: { itemIds: [SKILL_ID, MCP_ID] },
    });
    should(files.written.get(`${CWD}/out/c.json`)?.overwrite).equal(true);
  });

  it('should refuse an item the catalog does not have before signing anything', async () => {
    const { controller, gateway } = build();
    await should(controller.export('Team tools', { item: ['ghost'], yes: true })).rejectedWith(
      'no item in Team tools "ghost"',
    );
    should(gateway.calls.some(call => call.call === 'export')).equal(false);
  });
});

describe('fy catalog default', () => {
  it('should make the catalog the default by id, asking nothing', async () => {
    const { controller, gateway, out, prompt } = build();
    await controller.makeDefault('Team tools', {});
    should(gateway.calls.at(-1)).eql({ call: 'update', catalogId: CATALOG_ID, request: { role: 'default' } });
    should(prompt.asked).have.length(0);
    should(out.text).containEql('is now the default catalog');
  });

  it('should print the payload with --json', async () => {
    const { controller, out } = build();
    await controller.makeDefault('Team tools', { json: true });
    should(JSON.parse(out.text).id).equal(CATALOG_ID);
  });
});

describe('fy catalog ls (default)', () => {
  it('should mark the default catalog', async () => {
    const gateway = new FakeGateway({ catalogs: [catalog({ role: 'default' })], preview: preview() });
    const { controller, out } = build({ gateway });
    await controller.list({});
    should(out.text).containEql(`(${CATALOG_ID}) · default · revision`);
  });
});

describe('fy catalog add --item', () => {
  const other = catalog({ items: [] });
  const shared = (gateway: FakeGateway) => gateway.calls.filter(call => call.call === 'listItems');

  it('should show the frozen review, ask, then list the item at the version shown', async () => {
    const gateway = new FakeGateway({ catalogs: [other], preview: preview({ version: 2 }), shared: [sharedItem()] });
    const { controller, out, prompt } = build({ gateway, answers: ['y'] });
    await controller.add('Team tools', { item: 'pdf-tools' });
    should(shared(gateway)).have.length(1);
    should(gateway.calls.slice(-2)).eql([
      { call: 'preview', catalogId: CATALOG_ID, request: { itemId: SKILL_ID } },
      { call: 'add', catalogId: CATALOG_ID, request: { itemId: SKILL_ID, version: 2 } },
    ]);
    should(out.lines[0]).containEql('line two');
    should(prompt.asked[0]).containEql('Add skill pdf-tools to Team tools exactly as shown above? [y/N]');
    should(out.lines[1]).startWith('Added pdf-tools version 1');
  });

  it('should add nothing when the answer is no', async () => {
    const gateway = new FakeGateway({ catalogs: [other], preview: preview(), shared: [sharedItem()] });
    const { controller } = build({ gateway, answers: [''] });
    await should(controller.add('Team tools', { item: SKILL_ID })).rejectedWith(/^cancelled/);
    should(writes(gateway).filter(call => call.call !== 'listItems')).have.length(0);
  });

  it('should print one payload with --json', async () => {
    const gateway = new FakeGateway({ catalogs: [other], preview: preview(), shared: [sharedItem()] });
    const { controller, out } = build({ gateway });
    await controller.add('Team tools', { item: 'pdf-tools', yes: true, json: true });
    should(JSON.parse(out.text).itemId).equal(SKILL_ID);
  });

  it('should refuse an item the catalog already lists, before previewing', async () => {
    const gateway = new FakeGateway();
    const { controller } = build({ gateway });
    await should(controller.add('Team tools', { item: 'pdf-tools', yes: true })).rejectedWith(
      /already lists pdf-tools/,
    );
    should(gateway.calls.some(call => call.call === 'preview')).equal(false);
  });

  it('should list again an item the catalog withdrew', async () => {
    const gateway = new FakeGateway({
      catalogs: [catalog({ items: [skillItem({ withdrawnAt: '2026-10-31T10:00:00.000Z' })] })],
      preview: preview(),
      shared: [sharedItem()],
    });
    const { controller } = build({ gateway });
    await controller.add('Team tools', { item: 'pdf-tools', yes: true });
    should(gateway.calls.at(-1)).match({ call: 'add', request: { itemId: SKILL_ID } });
  });

  it('should refuse a name the machine does not keep, and mixing with a source', async () => {
    const gateway = new FakeGateway();
    const { controller } = build({ gateway });
    await should(controller.add('Team tools', { item: 'nope', yes: true })).rejectedWith(/no shared item "nope"/);
    await should(controller.add('Team tools', { item: 'x', skill: 'y' })).rejectedWith(/--item alone/);
    await should(controller.add('Team tools', { item: 'x', mcp: 'y' })).rejectedWith(/--item alone/);
    await should(controller.add('Team tools', { item: 'x', summary: 'y' })).rejectedWith(/--item alone/);
  });
});
