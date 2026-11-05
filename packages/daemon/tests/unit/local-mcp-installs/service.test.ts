import { describe, it } from 'bun:test';
import should from 'should';
import { LocalMcpRefusalError } from '../../../src/lib/local-mcp-installs/ports.ts';
import {
  ACCOUNT_ID,
  BAD_ID,
  CALLER,
  COMPONENT_ID,
  copy,
  FAKE_VALUE,
  GOVERNANCE,
  PROJECT_ID,
  projectTarget,
  type Rig,
  ROOT,
  rig,
  runtimeTarget,
  STEP_UP,
  stdioServer,
  URL_ID,
} from './support.ts';

const refusedWith = async (code: string, work: () => Promise<unknown>) => {
  const error = await work().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  should(error).be.instanceOf(LocalMcpRefusalError);
  should((error as LocalMcpRefusalError).code).equal(code);
  return error as LocalMcpRefusalError;
};

const previewOf = (rigged: Rig, target = projectTarget(), id = ACCOUNT_ID) =>
  rigged.service.preview(target.scope, { source: { id }, target }, CALLER);

const entryNamed = (rigged: Rig, name: string): unknown =>
  (JSON.parse(rigged.mcp.text ?? '{}') as { mcpServers?: Record<string, unknown> }).mcpServers?.[name];

describe('previewing an MCP server copy', () => {
  it('should show placeholders and the review, never a value, and write nothing', async () => {
    const rigged = rig();
    rigged.secrets.add('API_TOKEN');

    const preview = await previewOf(rigged);

    should(preview.name).equal('search');
    should(preview.origin).deepEqual({
      kind: 'account',
      owner: 'claude-work',
      harness: 'claude',
      scope: 'user',
      id: ACCOUNT_ID,
    });
    should(preview.secrets).deepEqual([
      { placeholder: 'API_TOKEN', held: true },
      { placeholder: 'REGION', held: false },
    ]);
    should(preview.destination).match(/\/work\/app\/\.mcp\.json/u);
    should(preview.review.length).be.above(0);
    should(preview.provenance.publisherName).equal('This machine');
    should(JSON.stringify(preview)).not.match(new RegExp(FAKE_VALUE, 'u'));
    should(rigged.mcp.text).be.null();
    should(rigged.store.writes).equal(0);
  });

  it('should leave out which secrets are held for a caller who may not list them', async () => {
    const rigged = rig();

    const preview = await rigged.service.preview(
      'project',
      { source: { id: ACCOUNT_ID }, target: projectTarget() },
      { ...CALLER, mayListSecrets: false },
    );

    should(preview.secrets).deepEqual([{ placeholder: 'API_TOKEN' }, { placeholder: 'REGION' }]);
  });

  it('should say a project server is the origin’s project, and a component one has no env value', async () => {
    const rigged = rig();

    const fromProject = await previewOf(rigged, projectTarget(), PROJECT_ID);
    const fromComponent = await previewOf(rigged, runtimeTarget(), COMPONENT_ID);

    should(fromProject.origin.kind).equal('project');
    should(fromProject.origin.owner).equal('/work/other');
    should(fromProject.secrets).deepEqual([]);
    should(fromComponent.secrets).deepEqual([{ placeholder: 'DOCS_KEY', held: false }]);
  });

  it('should leave an address’s credentials out and say so', async () => {
    const rigged = rig();
    rigged.servers = [
      stdioServer({
        id: URL_ID,
        name: 'remote',
        declaration: {
          name: 'remote',
          transport: 'http',
          url: 'https://user:pw@mcp.example.com/mcp?api_key=zzz&x=1',
          headers: {},
        },
      }),
    ];

    const preview = await previewOf(rigged, runtimeTarget(), URL_ID);

    should(preview.skipped.map(problem => problem.subject)).containEql('url');
    should(JSON.stringify(preview)).not.match(/user:pw|api_key=zzz/u);
  });

  it('should refuse a source the inventory does not list', async () => {
    const rigged = rig();

    await refusedWith('local_mcp_source_unknown', () => previewOf(rigged, projectTarget(), 'd'.repeat(24)));
  });

  it('should refuse a source that cannot be copied, saying why', async () => {
    const rigged = rig();

    const error = await refusedWith('local_mcp_source_invalid', () => previewOf(rigged, projectTarget(), BAD_ID));

    should(error.message.length).be.above(0);
  });

  it('should refuse a scope that is not the target’s', async () => {
    const rigged = rig();

    await refusedWith('local_mcp_target_unknown', () =>
      rigged.service.preview('runtime', { source: { id: ACCOUNT_ID }, target: projectTarget() }, CALLER),
    );
  });

  it('should refuse Codex as a project target and a project that is not known', async () => {
    const rigged = rig();

    const codex = await refusedWith('local_mcp_target_unknown', () => previewOf(rigged, projectTarget('codex')));
    await refusedWith('local_mcp_target_unknown', () => previewOf(rigged, projectTarget('claude', '/elsewhere')));

    should(codex.message).match(/\.mcp\.json/u);
  });

  it('should answer a project spelled with a trailing slash as the same project', async () => {
    const rigged = rig();

    const preview = await previewOf(rigged, projectTarget('claude', `${ROOT}/`));

    should(preview.target).deepEqual(projectTarget());
  });

  it('should refuse a runtime or profile it does not know, and one that would not reach the runtime', async () => {
    const rigged = rig();

    await refusedWith('local_mcp_target_unknown', () => previewOf(rigged, runtimeTarget('nope')));
    await refusedWith('local_mcp_target_unknown', () => previewOf(rigged, runtimeTarget('claude-work', 'nope')));
    await refusedWith('local_mcp_target_unknown', () => previewOf(rigged, runtimeTarget('claude-work', 'play')));
  });

  it('should name a runtime by its own name whichever spelling was given', async () => {
    const rigged = rig();

    const preview = await previewOf(rigged, runtimeTarget('rt-claude'));

    should(preview.target).deepEqual(runtimeTarget('claude-work'));
  });

  it('should refuse an OAuth server for a project, and one that needs a client registered by hand for a runtime', async () => {
    const rigged = rig();
    rigged.servers = [
      stdioServer({
        id: URL_ID,
        name: 'remote',
        declaration: null,
        scope: 'component',
        component: { url: 'https://mcp.example.com/mcp', auth: 'oauth' },
      }),
      stdioServer({
        id: COMPONENT_ID,
        name: 'handmade',
        declaration: null,
        scope: 'component',
        component: { url: 'https://mcp.example.com/h', auth: 'oauth', oauth: { clientId: 'abc' } },
      }),
    ];

    await refusedWith('local_mcp_source_invalid', () => previewOf(rigged, projectTarget(), URL_ID));
    await previewOf(rigged, runtimeTarget(), URL_ID);
    await refusedWith('local_mcp_source_invalid', () => previewOf(rigged, runtimeTarget(), COMPONENT_ID));
  });

  it('should refuse a project server whose arguments look like a key', async () => {
    const rigged = rig();
    rigged.servers = [
      stdioServer({
        declaration: { name: 'search', transport: 'stdio', command: 'x', args: ['ghp_notarealtoken'], env: {} },
      }),
    ];

    await refusedWith('local_mcp_source_invalid', () => previewOf(rigged));
  });

  it('should refuse to preview over a conflict, before anything is held', async () => {
    const rigged = rig();
    rigged.mcp.text = JSON.stringify({ mcpServers: { search: { command: 'mine' } } });

    await refusedWith('local_mcp_conflict', () => previewOf(rigged));
    should(rigged.previews.size).equal(0);
  });

  it('should refuse a project file it cannot parse, and pass on a failure it does not know', async () => {
    const rigged = rig();
    rigged.mcp.text = '{ not json';
    await refusedWith('local_mcp_conflict', () => previewOf(rigged));

    rigged.mcp.text = null;
    rigged.mcp.failRead = new Error('disk gone');
    const error = await previewOf(rigged).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    should((error as Error).message).equal('disk gone');
  });
});

describe('applying an MCP server copy into a project', () => {
  it('should write the reviewed server, bound or unbound, and record what it wrote', async () => {
    const rigged = rig();
    rigged.secrets.add('API_TOKEN');

    const { installed } = await copy(rigged, projectTarget(), { bindings: { API_TOKEN: 'API_TOKEN', REGION: null } });

    should(entryNamed(rigged, 'search')).deepEqual({
      command: 'npx',
      args: ['-y', 'search-mcp'],
      env: { API_TOKEN: '${API_TOKEN}' },
    });
    should(installed.install.secretBindings).deepEqual({ API_TOKEN: 'API_TOKEN', REGION: null });
    should(installed.notes.join(' ')).match(/API_TOKEN/u);
    should(installed.notes.join(' ')).match(/REGION is not set/u);
    should(JSON.stringify(installed)).not.match(new RegExp(FAKE_VALUE, 'u'));
    should(JSON.stringify(rigged.store.state)).not.match(new RegExp(FAKE_VALUE, 'u'));
    should(rigged.mcp.text).not.match(new RegExp(FAKE_VALUE, 'u'));
    const [record] = rigged.store.state.installs;
    should(record?.key).equal(`project:${ROOT}/.mcp.json#search`);
    should(record?.entrySha256).match(/^[0-9a-f]{64}$/u);
    should(record?.componentSha256).be.undefined();
    should((await rigged.service.list()).installs.map(install => install.name)).deepEqual(['search']);
    should(JSON.stringify(await rigged.service.list())).not.match(/entrySha256/u);
  });

  it('should keep every other server in the file', async () => {
    const rigged = rig();
    rigged.mcp.text = JSON.stringify({ mcpServers: { other: { command: 'o' } }, extra: 1 });

    await copy(rigged, projectTarget());

    should(entryNamed(rigged, 'other')).deepEqual({ command: 'o' });
    should(JSON.parse(rigged.mcp.text ?? '{}').extra).equal(1);
  });

  it('should refuse bindings that do not match the placeholders, or name a secret the person lacks', async () => {
    const rigged = rig();
    const preview = await previewOf(rigged);
    const apply = (bindings: Record<string, string | null>) =>
      rigged.service.apply('project', preview.previewId, bindings, CALLER, GOVERNANCE);

    await refusedWith('local_mcp_bindings_invalid', () => apply({ API_TOKEN: null }));
    await refusedWith('local_mcp_bindings_invalid', () => apply({ API_TOKEN: null, REGION: null, EXTRA: null }));
    await refusedWith('local_mcp_bindings_invalid', () => apply({ API_TOKEN: 'NOT_MINE', REGION: null }));
    await refusedWith('local_mcp_bindings_invalid', () => apply({ API_TOKEN: 'lower_case', REGION: null }));
    should(rigged.mcp.text).be.null();
    should(rigged.previews.size).equal(1);
  });

  it('should refuse a preview that is unknown, spent, someone else’s, for the other scope, or expired', async () => {
    const rigged = rig();
    const apply = (previewId: string, scope: 'project' | 'runtime' = 'project', caller = CALLER) =>
      rigged.service.apply(scope, previewId, {}, caller, GOVERNANCE);
    await refusedWith('local_mcp_preview_unknown', () => apply(`lmp_${'z'.repeat(22)}`));

    const kept = await previewOf(rigged, projectTarget(), PROJECT_ID);
    await refusedWith('local_mcp_preview_unknown', () => apply(kept.previewId, 'project', { ...CALLER, id: 'host' }));
    await refusedWith('local_mcp_preview_unknown', () => apply(kept.previewId, 'runtime'));
    await apply(kept.previewId);
    await refusedWith('local_mcp_preview_unknown', () => apply(kept.previewId));

    const late = await previewOf(rigged, runtimeTarget(), COMPONENT_ID);
    rigged.clock.now += 600_001;
    await refusedWith('local_mcp_preview_expired', () => apply(late.previewId, 'runtime'));
  });

  it('should refuse when something not ours is in the way, or the file moved after the review', async () => {
    const rigged = rig();
    const preview = await previewOf(rigged);
    rigged.mcp.text = JSON.stringify({ mcpServers: { search: { command: 'mine' } } });
    const bindings = { API_TOKEN: null, REGION: null };

    await refusedWith('local_mcp_conflict', () =>
      rigged.service.apply('project', preview.previewId, bindings, CALLER, GOVERNANCE),
    );

    const again = rig();
    const second = await previewOf(again);
    again.mcp.onRead = reads => {
      if (reads === 3) again.mcp.text = JSON.stringify({ mcpServers: { search: { command: 'sneaky' } } });
    };
    await refusedWith('local_mcp_conflict', () =>
      again.service.apply('project', second.previewId, bindings, CALLER, GOVERNANCE),
    );
  });

  it('should write a new file only while it is still absent, carrying that very reading into the write', async () => {
    const rigged = rig();
    const preview = await previewOf(rigged);
    const bindings = { API_TOKEN: null, REGION: null };

    await rigged.service.apply('project', preview.previewId, bindings, CALLER, GOVERNANCE);

    should(rigged.mcp.replaced).deepEqual([{ expected: null }]);

    const racing = rig();
    const second = await previewOf(racing);
    racing.mcp.afterRead = reads => {
      if (reads === 3) racing.mcp.editElsewhere(JSON.stringify({ mcpServers: { other: { command: 'o' } } }));
    };
    await refusedWith('local_mcp_conflict', () =>
      racing.service.apply('project', second.previewId, bindings, CALLER, GOVERNANCE),
    );
    should(racing.mcp.replaced).deepEqual([{ expected: null }]);
    should(entryNamed(racing, 'search')).be.undefined();
    should(racing.store.writes).equal(0);
  });

  it('should replace an existing file only as it was read, and give way when it was saved in between', async () => {
    const rigged = rig();
    rigged.mcp.editElsewhere(JSON.stringify({ mcpServers: { other: { command: 'o' } } }));
    const preview = await previewOf(rigged);
    const bindings = { API_TOKEN: null, REGION: null };
    const version = rigged.mcp.version;

    await rigged.service.apply('project', preview.previewId, bindings, CALLER, GOVERNANCE);

    should(rigged.mcp.replaced).deepEqual([{ expected: `e${version}` }]);

    const racing = rig();
    racing.mcp.editElsewhere(JSON.stringify({ mcpServers: { other: { command: 'o' } } }));
    const second = await previewOf(racing);
    const before = racing.mcp.text;
    racing.mcp.afterRead = reads => {
      if (reads === 3) racing.mcp.editElsewhere(JSON.stringify({ mcpServers: { other: { command: 'changed' } } }));
    };
    await refusedWith('local_mcp_conflict', () =>
      racing.service.apply('project', second.previewId, bindings, CALLER, GOVERNANCE),
    );
    should(racing.mcp.replaced).deepEqual([{ expected: 'e1' }]);
    should(racing.mcp.text).not.equal(before);
    should(entryNamed(racing, 'search')).be.undefined();
    should(racing.store.writes).equal(0);
  });

  it('should let a failure of the file port that is not a race travel on, writing nothing', async () => {
    const rigged = rig();
    const preview = await previewOf(rigged);
    rigged.mcp.failReplace = new Error('disk full');

    await should(
      rigged.service.apply('project', preview.previewId, { API_TOKEN: null, REGION: null }, CALLER, GOVERNANCE),
    ).be.rejectedWith('disk full');
    should(rigged.store.writes).equal(0);
  });

  it('should let a failure of the file port travel on when removing, keeping the record', async () => {
    const rigged = rig();
    const { installed } = await copy(rigged, projectTarget());
    rigged.mcp.failReplace = new Error('disk full');

    await should(rigged.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP)).be.rejectedWith(
      'disk full',
    );
    should(rigged.store.state.installs.length).equal(1);
  });

  it('should replace its own earlier copy, and say so in the next preview', async () => {
    const rigged = rig();
    const first = await copy(rigged, projectTarget());

    const preview = await previewOf(rigged);
    const second = await copy(rigged, projectTarget(), { bindings: { API_TOKEN: null, REGION: null } });

    should(preview.replaces).deepEqual({ installId: first.installed.install.installId });
    should(rigged.store.state.installs.length).equal(1);
    should(rigged.store.state.installs[0]?.installId).equal(second.installed.install.installId);
  });

  it('should not replace its own copy once it was edited here', async () => {
    const rigged = rig();
    await copy(rigged, projectTarget());
    rigged.mcp.text = JSON.stringify({ mcpServers: { search: { command: 'edited' } } });

    await refusedWith('local_mcp_conflict', () => previewOf(rigged));
  });

  it('should write a fresh entry when its own copy was deleted from the file', async () => {
    const rigged = rig();
    await copy(rigged, projectTarget());
    rigged.mcp.text = JSON.stringify({ mcpServers: {} });

    await copy(rigged, projectTarget());

    should(entryNamed(rigged, 'search')).not.be.undefined();
  });

  it('should hold the apply back behind the one before it', async () => {
    const rigged = rig();
    const a = await previewOf(rigged, projectTarget(), PROJECT_ID);
    const b = await previewOf(rigged, projectTarget(), PROJECT_ID);
    const bindings = {};

    const results = await Promise.allSettled([
      rigged.service.apply('project', a.previewId, bindings, CALLER, GOVERNANCE),
      rigged.service.apply('project', b.previewId, bindings, CALLER, GOVERNANCE),
    ]);

    should(results.map(result => result.status)).deepEqual(['fulfilled', 'fulfilled']);
    should(rigged.store.state.installs.length).equal(1);
  });

  it('should keep going after an apply that failed', async () => {
    const rigged = rig();
    const preview = await previewOf(rigged);
    await refusedWith('local_mcp_bindings_invalid', () =>
      rigged.service.apply('project', preview.previewId, {}, CALLER, GOVERNANCE),
    );

    await rigged.service.apply('project', preview.previewId, { API_TOKEN: null, REGION: null }, CALLER, GOVERNANCE);

    should(rigged.store.state.installs.length).equal(1);
  });
});

describe('applying an MCP server copy into a runtime', () => {
  it('should hand the fleet the reviewed server with the person’s own secrets, and record its hash', async () => {
    const rigged = rig();
    rigged.secrets.add('API_TOKEN');

    const { installed } = await copy(rigged, runtimeTarget(), { bindings: { API_TOKEN: 'API_TOKEN', REGION: null } });

    const [change] = rigged.fleet.proposed as unknown as {
      component: { env: Record<string, string> };
      installedFrom: { publisherName: string; itemId: string };
      replace: boolean;
      profile: string;
    }[];
    should(change?.component.env).deepEqual({ API_TOKEN: '${secret:API_TOKEN}' });
    should(change?.installedFrom.publisherName).equal('This machine');
    should(change?.installedFrom.itemId).match(/^itm_/u);
    should(change?.replace).be.false();
    should(change?.profile).equal('work');
    should(installed.notes.join(' ')).match(/profile work/u);
    const [record] = rigged.store.state.installs;
    should(record?.key).equal('fleet:mcp/search');
    should(record?.componentSha256).match(/^[0-9a-f]{64}$/u);
    should(JSON.stringify(rigged.store.state)).not.match(new RegExp(FAKE_VALUE, 'u'));
  });

  it('should hand over a server with no variables as one without an env', async () => {
    const rigged = rig();

    await copy(rigged, runtimeTarget(), { id: COMPONENT_ID, bindings: { DOCS_KEY: null } });
    await copy(rigged, runtimeTarget(), { id: PROJECT_ID });

    const proposed = rigged.fleet.proposed as unknown as { component: Record<string, unknown> }[];
    should(proposed[1]?.component.env).be.undefined();
  });

  it('should hand over a URL server', async () => {
    const rigged = rig();

    await copy(rigged, runtimeTarget(), { id: URL_ID });

    const [change] = rigged.fleet.proposed as unknown as { component: Record<string, unknown> }[];
    should(change?.component).deepEqual({ kind: 'mcp', url: 'https://mcp.example.com/mcp' });
  });

  it('should refuse a server that is already on this machine and was not put there by a copy', async () => {
    const rigged = rig();
    rigged.fleet.components.set('mcp', [{ name: 'search', detail: { kind: 'mcp', command: 'mine' } } as never]);

    await refusedWith('local_mcp_conflict', () => previewOf(rigged, runtimeTarget()));
  });

  it('should replace its own copy and ask the fleet to replace, but not once it was edited', async () => {
    const rigged = rig();
    await copy(rigged, runtimeTarget());
    const again = await copy(rigged, runtimeTarget());

    const proposed = rigged.fleet.proposed as unknown as { replace: boolean }[];
    should(proposed[1]?.replace).be.true();
    should(again.preview.replaces).not.be.undefined();

    rigged.fleet.components.set('mcp', [{ name: 'search', detail: { kind: 'mcp', command: 'edited' } } as never]);
    await refusedWith('local_mcp_conflict', () => previewOf(rigged, runtimeTarget()));
  });
});

describe('removing an MCP server copy', () => {
  it('should take its own entry out of a project file and forget the record', async () => {
    const rigged = rig();
    rigged.mcp.text = JSON.stringify({ mcpServers: { other: { command: 'o' } } });
    const { installed } = await copy(rigged, projectTarget());

    const removed = await rigged.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP);

    should(removed.name).equal('search');
    should(entryNamed(rigged, 'search')).be.undefined();
    should(entryNamed(rigged, 'other')).deepEqual({ command: 'o' });
    should(rigged.store.state.installs).deepEqual([]);
  });

  it('should finish when the entry is already gone', async () => {
    const rigged = rig();
    const { installed } = await copy(rigged, projectTarget());
    rigged.mcp.text = JSON.stringify({ mcpServers: {} });

    await rigged.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP);

    should(rigged.store.state.installs).deepEqual([]);
  });

  it('should refuse to remove an entry that was edited here, and when the file changes under it', async () => {
    const rigged = rig();
    const { installed } = await copy(rigged, projectTarget());
    rigged.mcp.text = JSON.stringify({ mcpServers: { search: { command: 'edited' } } });
    await refusedWith('local_mcp_conflict', () =>
      rigged.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP),
    );

    const racing = rig();
    const second = await copy(racing, projectTarget());
    const written = racing.mcp.text;
    const etag = `e${racing.mcp.version}`;
    racing.mcp.replaced.length = 0;
    racing.mcp.afterRead = () => {
      racing.mcp.afterRead = undefined;
      racing.mcp.editElsewhere(
        JSON.stringify({
          mcpServers: { search: JSON.parse(written ?? '{}').mcpServers.search, other: { command: 'o' } },
        }),
      );
    };
    await refusedWith('local_mcp_conflict', () =>
      racing.service.remove('project', second.installed.install.installId, GOVERNANCE, STEP_UP),
    );
    should(racing.mcp.replaced).deepEqual([{ expected: etag }]);
    should(entryNamed(racing, 'search')).not.be.undefined();
    should(racing.store.state.installs.length).equal(1);

    const clean = rig();
    const third = await copy(clean, projectTarget());
    const cleanEtag = `e${clean.mcp.version}`;
    clean.mcp.replaced.length = 0;
    await clean.service.remove('project', third.installed.install.installId, GOVERNANCE, STEP_UP);
    should(clean.mcp.replaced).deepEqual([{ expected: cleanEtag }]);
  });

  it('should say there is no such copy, or none in that scope', async () => {
    const rigged = rig();
    const { installed } = await copy(rigged, projectTarget());

    await refusedWith('local_mcp_install_unknown', () =>
      rigged.service.remove('project', `lmi_${'q'.repeat(22)}`, GOVERNANCE, STEP_UP),
    );
    await refusedWith('local_mcp_install_unknown', () =>
      rigged.service.remove('runtime', installed.install.installId, GOVERNANCE, STEP_UP),
    );
  });

  it('should not trust a record that names a place of a project it does not know', async () => {
    const rigged = rig();
    const { installed } = await copy(rigged, projectTarget());
    const original = structuredClone(rigged.store.state);

    for (const damage of [
      { root: '/elsewhere' },
      { key: 'project:/work/app/.mcp.json#other' },
      { entrySha256: undefined },
    ]) {
      rigged.store.state = structuredClone(original);
      Object.assign(rigged.store.state.installs[0] ?? {}, damage);
      await refusedWith('local_mcp_target_unknown', () =>
        rigged.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP),
      );
      // a record under another key is not this server's record, so what sits there is simply nobody's
      await refusedWith('key' in damage ? 'local_mcp_conflict' : 'local_mcp_target_unknown', () => previewOf(rigged));
    }
  });

  it('should propose the removal and apply it for a runtime copy', async () => {
    const rigged = rig();
    const { installed } = await copy(rigged, runtimeTarget());

    const removed = await rigged.service.remove('runtime', installed.install.installId, GOVERNANCE, STEP_UP);

    should(removed.destination).match(/profile work/u);
    should(rigged.fleet.components.get('mcp')).deepEqual([]);
    should(rigged.store.state.installs).deepEqual([]);
    should(rigged.fleet.proposed.at(-1)).containEql({ kind: 'component.remove', componentKind: 'mcp', name: 'search' });
  });

  it('should refuse to remove a runtime server that was edited, and finish when it is already gone', async () => {
    const rigged = rig();
    const { installed } = await copy(rigged, runtimeTarget());
    const stored = rigged.fleet.components.get('mcp') ?? [];
    rigged.fleet.components.set('mcp', [{ name: 'search', detail: { kind: 'mcp', command: 'edited' } } as never]);
    await refusedWith('local_mcp_conflict', () =>
      rigged.service.remove('runtime', installed.install.installId, GOVERNANCE, STEP_UP),
    );

    rigged.fleet.components.set('mcp', []);
    await rigged.service.remove('runtime', installed.install.installId, GOVERNANCE, STEP_UP);

    should(stored.length).equal(1);
    should(rigged.store.state.installs).deepEqual([]);
  });

  it('should not trust a runtime record that names another place', async () => {
    const rigged = rig();
    const { installed } = await copy(rigged, runtimeTarget());
    const original = structuredClone(rigged.store.state);

    for (const damage of [{ key: 'fleet:mcp/other' }, { componentSha256: undefined }]) {
      rigged.store.state = structuredClone(original);
      Object.assign(rigged.store.state.installs[0] ?? {}, damage);
      await refusedWith('local_mcp_target_unknown', () =>
        rigged.service.remove('runtime', installed.install.installId, GOVERNANCE, STEP_UP),
      );
    }
  });
});

describe('what a copy never carries out of the source', () => {
  const OPAQUE = 'dummy-credential-0123456789abcdef';
  const remote = (url: string) =>
    stdioServer({
      id: URL_ID,
      name: 'remote',
      declaration: { name: 'remote', transport: 'http', url, headers: {} },
    });
  const launching = (command: string, args: string[]) =>
    stdioServer({
      id: BAD_ID,
      name: 'launched',
      declaration: { name: 'launched', transport: 'stdio', command, args, env: {} },
    });

  it('should leave an encoded credential out of the review, the project file and the runtime definition', async () => {
    for (const target of [projectTarget(), runtimeTarget()]) {
      const rigged = rig();
      rigged.servers = [
        remote(`https://mcp.example.com/mcp?api%5Fkey=${OPAQUE}&sk%2Dlive%2Dabcdefghijklmnopqrstuv=1&keep=1&bad=%ZZ`),
      ];

      const { preview } = await copy(rigged, target, { id: URL_ID });

      const everything = JSON.stringify([preview, rigged.mcp.text, rigged.fleet.proposed, rigged.store.state]);
      should(everything).not.match(/api%5Fkey|api_key|sk%2Dlive|abcdefghijklmnopqrstuv|dummy-credential/u);
      should(everything).match(/keep=1/u);
      should(preview.skipped.map(problem => problem.reason).join(' ')).match(/malformed percent-encoding/u);
    }
  });

  it('should leave a plus-escaped credential out of the review and everything written', async () => {
    for (const target of [projectTarget(), runtimeTarget()]) {
      const rigged = rig();
      rigged.servers = [remote(`https://mcp.example.com/mcp?x=Bearer+${OPAQUE}&keep=hello+world`)];

      const { preview } = await copy(rigged, target, { id: URL_ID });

      const everything = JSON.stringify([preview, rigged.mcp.text, rigged.fleet.proposed, rigged.store.state]);
      should(everything).not.match(/Bearer|dummy-credential/u);
      should(everything).match(/keep=hello\+world/u);
    }
  });

  it('should refuse a command whose arguments hold a credential, writing nothing and echoing nothing', async () => {
    const shapes: [string, string[]][] = [
      ['curl', ['--user', `dummy:${OPAQUE}`]],
      ['curl', [`--user=dummy:${OPAQUE}`]],
      ['node', ['server.js', `https://dummy:${OPAQUE}@mcp.example.com`]],
      ['npx', ['mcp-remote', '--header', `Authorization: Bearer ${OPAQUE}`]],
      ['node', ['server.js', `https://mcp.example.com/?api%5Fkey=${OPAQUE}`]],
      ['node', ['server.js', `https://dummy:%64${OPAQUE}@mcp.example.com`]],
      ['curl', ['--user', `dummy:%64${OPAQUE}`]],
    ];
    for (const target of [projectTarget(), runtimeTarget()])
      for (const [command, args] of shapes) {
        const rigged = rig();
        rigged.servers = [launching(command, args)];

        const error = await refusedWith('local_mcp_source_invalid', () => previewOf(rigged, target, BAD_ID));

        should(error.message).match(/holds what looks like a password or key/u);
        should(error.message).not.match(/dummy/u);
        should(rigged.mcp.text).be.null();
        should(rigged.mcp.replaced).deepEqual([]);
        should(rigged.fleet.proposed).deepEqual([]);
        should(rigged.store.writes).equal(0);
      }
  });

  it('should write what was reviewed even when the source changes after the preview', async () => {
    for (const target of [projectTarget(), runtimeTarget()]) {
      const rigged = rig();
      const preview = await previewOf(rigged, target);

      rigged.servers = [
        stdioServer({
          declaration: {
            name: 'search',
            transport: 'stdio',
            command: 'swapped-command',
            args: [`https://dummy:${OPAQUE}@mcp.example.com`],
            env: { OTHER_TOKEN: FAKE_VALUE },
          },
        }),
      ];
      await rigged.service.apply(
        target.scope,
        preview.previewId,
        { API_TOKEN: null, REGION: null },
        CALLER,
        GOVERNANCE,
      );

      const written = JSON.stringify([rigged.mcp.text, rigged.fleet.proposed]);
      should(written).match(/search-mcp/u);
      should(written).not.match(/swapped-command|OTHER_TOKEN|dummy/u);
    }
  });
});

describe('a configuration edit that lands between our check and the fleet staging a runtime change', () => {
  const edit = (rigged: Rig): void => {
    rigged.fleet.afterStoredComponent = () => {
      rigged.fleet.afterStoredComponent = undefined;
      const [stored] = rigged.fleet.components.get('mcp') ?? [];
      rigged.fleet.components.set('mcp', [
        { ...stored, detail: { ...(stored?.detail as object), command: 'edited-meanwhile' } } as never,
      ]);
    };
  };

  it('should not replace the edited server, and keep the record', async () => {
    const rigged = rig();
    const { installed } = await copy(rigged, runtimeTarget());
    const preview = await previewOf(rigged, runtimeTarget());
    const staged = rigged.fleet.proposed.length;
    edit(rigged);

    const error = await refusedWith('local_mcp_conflict', () =>
      rigged.service.apply('runtime', preview.previewId, { API_TOKEN: null, REGION: null }, CALLER, GOVERNANCE),
    );

    should(error.message).match(/edited on this machine just now/u);
    should(rigged.fleet.proposed.length).equal(staged);
    should(JSON.stringify(rigged.fleet.components.get('mcp'))).match(/edited-meanwhile/u);
    should(rigged.store.state.installs.map(install => install.installId)).deepEqual([installed.install.installId]);
  });

  it('should not install over a server that appeared once we had looked and found none', async () => {
    const rigged = rig();
    const preview = await previewOf(rigged, runtimeTarget());
    rigged.fleet.afterStoredComponent = () => {
      rigged.fleet.afterStoredComponent = undefined;
      rigged.fleet.components.set('mcp', [{ name: 'search', detail: { kind: 'mcp', command: 'mine' } } as never]);
    };

    await refusedWith('local_mcp_conflict', () =>
      rigged.service.apply('runtime', preview.previewId, { API_TOKEN: null, REGION: null }, CALLER, GOVERNANCE),
    );

    should(rigged.fleet.proposed).deepEqual([]);
    should(rigged.store.writes).equal(0);
  });

  it('should not remove the edited server, and keep the record', async () => {
    const rigged = rig();
    const { installed } = await copy(rigged, runtimeTarget());
    const staged = rigged.fleet.proposed.length;
    edit(rigged);

    const error = await refusedWith('local_mcp_conflict', () =>
      rigged.service.remove('runtime', installed.install.installId, GOVERNANCE, STEP_UP),
    );

    should(error.message).match(/edited on this machine just now, so it was not removed/u);
    should(rigged.fleet.proposed.length).equal(staged);
    should(rigged.fleet.components.get('mcp')?.length).equal(1);
    should(rigged.store.state.installs.length).equal(1);
  });

  it('should not remove a server that was deleted in that window', async () => {
    const rigged = rig();
    const { installed } = await copy(rigged, runtimeTarget());
    rigged.fleet.afterStoredComponent = () => {
      rigged.fleet.afterStoredComponent = undefined;
      rigged.fleet.components.set('mcp', []);
    };

    await refusedWith('local_mcp_conflict', () =>
      rigged.service.remove('runtime', installed.install.installId, GOVERNANCE, STEP_UP),
    );

    should(rigged.store.state.installs.length).equal(1);
  });
});
