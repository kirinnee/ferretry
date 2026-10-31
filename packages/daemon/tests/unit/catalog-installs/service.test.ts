import { beforeAll, describe, it } from 'bun:test';
import type { CatalogInstallPreview, SharedCatalogItem } from '@ferretry/protocol';
import type { DaemonIdentity } from '@ferretry/relay';
import should from 'should';
import { CatalogInstallRefusalError } from '../../../src/lib/catalog-installs/ports.ts';
import { McpProjectFileError } from '../../../src/lib/session-mcp/project-file.ts';
import { artifactItem, CATALOG_ID, mcpItem, newIdentity, skillItem } from '../../support/catalog-fixtures.ts';
import { GOVERNANCE, projectTarget, request, rig, ROOT, runtimeTarget, STEP_UP, type Rig } from './service-support.ts';

const OTHER_CATALOG = `cat_${'o'.repeat(22)}`;
const OTHER_ITEM = `itm_${'o'.repeat(22)}`;

let alice: DaemonIdentity;
let mallory: DaemonIdentity;
beforeAll(async () => {
  alice = await newIdentity();
  mallory = await newIdentity();
});

const refusal = async (work: Promise<unknown>): Promise<CatalogInstallRefusalError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof CatalogInstallRefusalError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

const secretRef = (name: string): string => `\${secret:${name}}`;

async function installSkill(
  r: Rig,
  item: SharedCatalogItem = skillItem(alice.daemonId),
  target = projectTarget(),
  options: { revision?: number; allowOlder?: true } = {},
) {
  const preview = await r.service.preview(target.scope, await request(alice, item, target, options));
  const installed = await r.service.apply(
    target.scope,
    { previewId: preview.previewId, secretBindings: {} },
    GOVERNANCE,
    STEP_UP,
  );
  return { preview, installed };
}

async function installMcp(
  r: Rig,
  bindings: Record<string, string | null> = { ACME_TOKEN: null },
  target = projectTarget(),
  item: SharedCatalogItem = mcpItem(alice.daemonId),
) {
  const preview = await r.service.preview(target.scope, await request(alice, item, target));
  const installed = await r.service.apply(
    target.scope,
    { previewId: preview.previewId, secretBindings: bindings },
    GOVERNANCE,
    STEP_UP,
  );
  return { preview, installed };
}

describe('catalog install preview: what is checked, in order', () => {
  it('should refuse a request whose target is of the other scope', async () => {
    const r = rig();
    const error = await refusal(
      r.service.preview('runtime', await request(alice, skillItem(alice.daemonId), projectTarget())),
    );
    should(error.code).equal('catalog_target_unknown');
  });

  it('should refuse a manifest that was not signed by the machine it names', async () => {
    const r = rig();
    const asked = await request(alice, skillItem(alice.daemonId), projectTarget());
    const forged = structuredClone(asked);
    forged.signedManifest.manifest.name = 'Somebody else';
    const error = await refusal(r.service.preview('project', forged));
    should(error.code).equal('catalog_signature_invalid');
    should(error.message).match(/not signed by the machine it names/u);
  });

  it('should refuse an item that is not the bytes its manifest lists', async () => {
    const r = rig();
    const asked = await request(alice, skillItem(alice.daemonId), projectTarget());
    const swapped = {
      ...asked,
      item: skillItem(alice.daemonId, { files: [{ path: 'SKILL.md', content: '# evil\n' }] }),
    };
    const error = await refusal(r.service.preview('project', swapped));
    should(error.code).equal('catalog_item_mismatch');
  });

  it('should refuse a changed publisher before it looks at anything after', async () => {
    const r = rig();
    await installSkill(r);
    // Mallory signs the SAME catalog id, and also asks for a target this machine does not know.
    const item = skillItem(mallory.daemonId);
    const error = await refusal(
      r.service.preview('project', await request(mallory, item, projectTarget('claude', '/not/registered'))),
    );
    should(error.code).equal('catalog_publisher_changed');
  });

  it('should refuse an older revision of a catalog it has already installed from', async () => {
    const r = rig();
    await installSkill(r, skillItem(alice.daemonId), projectTarget(), { revision: 3 });
    const error = await refusal(
      r.service.preview('project', await request(alice, mcpItem(alice.daemonId), projectTarget(), { revision: 2 })),
    );
    should(error.code).equal('catalog_revision_older');
    should(error.message).match(/revision 2/u);
  });

  it('should accept the same or a newer revision', async () => {
    const r = rig();
    await installSkill(r, skillItem(alice.daemonId), projectTarget(), { revision: 3 });
    await r.service.preview('project', await request(alice, mcpItem(alice.daemonId), projectTarget(), { revision: 3 }));
    await r.service.preview('project', await request(alice, mcpItem(alice.daemonId), projectTarget(), { revision: 4 }));
  });

  it('should refuse a downgrade unless it was chosen, and then say so first', async () => {
    const r = rig();
    await installSkill(r, skillItem(alice.daemonId, { itemVersion: 3 }));
    const older = skillItem(alice.daemonId, { itemVersion: 2 });
    const error = await refusal(r.service.preview('project', await request(alice, older, projectTarget())));
    should(error.code).equal('catalog_downgrade');
    const chosen = await r.service.preview(
      'project',
      await request(alice, older, projectTarget(), { allowOlder: true }),
    );
    should(chosen.warnings[0]?.code).equal('older-version');
    should(chosen.replaces?.version).equal(3);
  });

  it('should refuse an artifact: it is opened, not installed', async () => {
    const r = rig();
    const error = await refusal(
      r.service.preview('project', await request(alice, artifactItem(alice.daemonId), projectTarget())),
    );
    should(error.code).equal('catalog_not_installable');
    should(error.message).match(/artifact/u);
  });

  it('should refuse an MCP server for a codex project, with the reason', async () => {
    const r = rig();
    const error = await refusal(
      r.service.preview('project', await request(alice, mcpItem(alice.daemonId), projectTarget('codex'))),
    );
    should(error.code).equal('catalog_not_installable');
    should(error.message).match(/Codex does not read \.mcp\.json/u);
  });

  it('should refuse a project server the session-MCP rule refuses (oauth in a project file)', async () => {
    const r = rig();
    const item = mcpItem(alice.daemonId, {
      mcp: { transport: 'url', url: 'https://mcp.example.com/x', auth: 'oauth' },
    });
    const error = await refusal(r.service.preview('project', await request(alice, item, projectTarget())));
    should(error.code).equal('catalog_not_installable');
  });

  it('should refuse a runtime server that needs a hand-registered OAuth client', async () => {
    const r = rig();
    const item = mcpItem(alice.daemonId, {
      mcp: { transport: 'url', url: 'https://mcp.example.com/x', auth: 'oauth', oauth: { clientId: 'abc' } },
    });
    const error = await refusal(r.service.preview('runtime', await request(alice, item, runtimeTarget())));
    should(error.code).equal('catalog_not_installable');
    should(error.message).match(/OAuth client/u);
  });

  it('should refuse an item written for the other harness, in a project and in a runtime', async () => {
    const r = rig();
    const forCodex = skillItem(alice.daemonId, { harness: 'codex' });
    const inProject = await refusal(
      r.service.preview('project', await request(alice, forCodex, projectTarget('claude'))),
    );
    should(inProject.code).equal('catalog_not_installable');
    const inRuntime = await refusal(
      r.service.preview('runtime', await request(alice, forCodex, runtimeTarget('claude-work'))),
    );
    should(inRuntime.code).equal('catalog_not_installable');
    const forClaude = skillItem(alice.daemonId, { harness: 'claude' });
    const words = await refusal(
      r.service.preview('runtime', await request(alice, forClaude, runtimeTarget('codex-work'))),
    );
    should(words.message).match(/Claude Code/u);
    await r.service.preview(
      'project',
      await request(alice, skillItem(alice.daemonId, { harness: 'generic' }), projectTarget('codex')),
    );
  });

  it('should refuse a project this machine does not know', async () => {
    const r = rig();
    const error = await refusal(
      r.service.preview(
        'project',
        await request(alice, skillItem(alice.daemonId), projectTarget('claude', '/elsewhere')),
      ),
    );
    should(error.code).equal('catalog_target_unknown');
  });

  it('should refuse an unknown runtime, an unknown profile, and a profile the runtime does not launch with', async () => {
    const r = rig();
    const item = skillItem(alice.daemonId);
    const noRuntime = await refusal(r.service.preview('runtime', await request(alice, item, runtimeTarget('nope'))));
    should(noRuntime.message).match(/not a runtime/u);
    const noProfile = await refusal(
      r.service.preview('runtime', await request(alice, item, runtimeTarget('claude-work', 'nope'))),
    );
    should(noProfile.message).match(/not a profile/u);
    const other = await refusal(
      r.service.preview('runtime', await request(alice, item, runtimeTarget('claude-work', 'play'))),
    );
    should(other.message).match(/launches with the profile work/u);
    for (const error of [noRuntime, noProfile, other]) should(error.code).equal('catalog_target_unknown');
  });

  it('should report the earlier failure when two apply: a bad item beats an unknown target', async () => {
    const r = rig();
    const asked = await request(alice, skillItem(alice.daemonId), projectTarget('claude', '/elsewhere'));
    const error = await refusal(
      r.service.preview('project', {
        ...asked,
        item: skillItem(alice.daemonId, { files: [{ path: 'SKILL.md', content: 'x' }] }),
      }),
    );
    should(error.code).equal('catalog_item_mismatch');
  });
});

describe('catalog install preview: the answer', () => {
  it('should answer the review, the publisher as first seen, the words for the destination and each placeholder', async () => {
    const r = rig();
    r.secrets = new Set(['ACME_TOKEN']);
    const preview = await r.service.preview('project', await request(alice, mcpItem(alice.daemonId), projectTarget()));
    should(preview.publisher).eql({ daemonId: alice.daemonId, name: 'kirin-box', firstSeen: true });
    should(preview.warnings.map(warning => warning.code)).containEql('first-publisher');
    should(preview.secrets).eql([{ placeholder: 'ACME_TOKEN', held: true }]);
    should(preview.destination).match(/acme-mcp in \/work\/app\/\.mcp\.json/u);
    should(preview.provenance.digest).match(/^sha256:/u);
    should(preview.review.length).be.above(0);
    should(preview.replaces).be.undefined();
    should(Date.parse(preview.expiresAt)).equal(r.clock.now + 600_000);
  });

  it('should write nothing and remember nothing', async () => {
    const r = rig();
    await r.service.preview('project', await request(alice, skillItem(alice.daemonId), projectTarget()));
    should(r.store.writes).equal(0);
    should(r.folders.folders.size).equal(0);
    should(r.mcp.text).be.null();
    const again = await r.service.preview('project', await request(alice, skillItem(alice.daemonId), projectTarget()));
    should(again.publisher.firstSeen).be.true();
  });

  it('should say the publisher is no longer new once something was installed from it', async () => {
    const r = rig();
    await installSkill(r);
    const preview = await r.service.preview('project', await request(alice, mcpItem(alice.daemonId), projectTarget()));
    should(preview.publisher.firstSeen).be.false();
    should(preview.warnings.map(warning => warning.code)).not.containEql('first-publisher');
  });

  it('should describe a project skill and a runtime server in words', async () => {
    const r = rig();
    const skill = await r.service.preview(
      'project',
      await request(alice, skillItem(alice.daemonId), projectTarget('codex')),
    );
    should(skill.destination).equal('/work/app/.agents/skills/pdf-tools/ (1 file)');
    const runtime = await r.service.preview('runtime', await request(alice, mcpItem(alice.daemonId), runtimeTarget()));
    should(runtime.destination).equal('the MCP server acme-mcp in runtime claude-work, profile work');
    const many = skillItem(alice.daemonId, {
      files: [
        { path: 'SKILL.md', content: 'a' },
        { path: 'b.md', content: 'b' },
      ],
    });
    should((await r.service.preview('project', await request(alice, many, projectTarget()))).destination).match(
      /\(2 files\)/u,
    );
  });

  it('should match a runtime by its id as well as its name', async () => {
    const r = rig();
    await r.service.preview('runtime', await request(alice, skillItem(alice.daemonId), runtimeTarget('rt-claude')));
  });

  it('should accept the registered project with or without a trailing slash', async () => {
    const r = rig();
    await r.service.preview(
      'project',
      await request(alice, skillItem(alice.daemonId), projectTarget('claude', '/work/app/')),
    );
  });
});

describe('catalog install: the publisher pin', () => {
  it('should pin a catalog to its first publisher across two catalogs and two publishers', async () => {
    const r = rig();
    // Alice's first catalog and her second are both fine, and she is a known publisher the second time.
    await installSkill(r);
    const second = skillItem(alice.daemonId, { catalogId: OTHER_CATALOG, itemId: OTHER_ITEM, name: 'other-skill' });
    const preview = await r.service.preview(
      'project',
      await request(alice, second, projectTarget(), { catalogId: OTHER_CATALOG }),
    );
    should(preview.publisher.firstSeen).be.false();
    await r.service.apply('project', { previewId: preview.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP);
    // Mallory may publish a catalog of her own...
    const hers = skillItem(mallory.daemonId, { catalogId: `cat_${'m'.repeat(22)}`, name: 'mallory-skill' });
    const own = await r.service.preview(
      'project',
      await request(mallory, hers, projectTarget(), { catalogId: `cat_${'m'.repeat(22)}` }),
    );
    should(own.publisher.firstSeen).be.true();
    // ...but not under either of Alice's catalog ids.
    for (const catalogId of [CATALOG_ID, OTHER_CATALOG]) {
      const stolen = skillItem(mallory.daemonId, { catalogId, name: 'mallory-skill' });
      const error = await refusal(
        r.service.preview('project', await request(mallory, stolen, projectTarget(), { catalogId })),
      );
      should(error.code).equal('catalog_publisher_changed');
    }
  });

  it('should keep a pin after the only install of that catalog is removed', async () => {
    const r = rig();
    const { installed } = await installSkill(r);
    await r.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP);
    const error = await refusal(
      r.service.preview('project', await request(mallory, skillItem(mallory.daemonId), projectTarget())),
    );
    should(error.code).equal('catalog_publisher_changed');
  });

  it('should fall back to an install record when the state has no pin entry', async () => {
    const r = rig();
    await installSkill(r);
    r.store.state = { ...r.store.state, pins: {} };
    const error = await refusal(
      r.service.preview('project', await request(mallory, skillItem(mallory.daemonId), projectTarget())),
    );
    should(error.code).equal('catalog_publisher_changed');
  });

  it('should never let one publisher’s same-named item stand in for another’s', async () => {
    const r = rig();
    const { installed } = await installSkill(r);
    // Mallory's item has the SAME name in her own catalog: it is a conflict at the destination, never a replacement.
    const hers = skillItem(mallory.daemonId, { catalogId: `cat_${'m'.repeat(22)}`, itemId: `itm_${'m'.repeat(22)}` });
    const error = await refusal(
      r.service.preview(
        'project',
        await request(mallory, hers, projectTarget(), { catalogId: `cat_${'m'.repeat(22)}` }),
      ),
    );
    should(error.code).equal('catalog_install_conflict');
    should(error.message).match(new RegExp(installed.install.installId, 'u'));
    // And the same item at ANOTHER target is a fresh install, not a replacement.
    const elsewhere = await r.service.preview(
      'runtime',
      await request(alice, skillItem(alice.daemonId), runtimeTarget()),
    );
    should(elsewhere.replaces).be.undefined();
    const codex = await r.service.preview(
      'project',
      await request(alice, skillItem(alice.daemonId), projectTarget('codex')),
    );
    should(codex.replaces).be.undefined();
    const runtimes = await r.service.preview(
      'runtime',
      await request(alice, mcpItem(alice.daemonId), runtimeTarget('claude-work')),
    );
    should(runtimes.replaces).be.undefined();
  });

  it('should name the install a newer version replaces', async () => {
    const r = rig();
    const { installed } = await installSkill(r);
    const next = skillItem(alice.daemonId, { itemVersion: 2, files: [{ path: 'SKILL.md', content: '# v2\n' }] });
    const preview = await r.service.preview('project', await request(alice, next, projectTarget()));
    should(preview.replaces).eql({ installId: installed.install.installId, version: 1 });
  });
});

describe('catalog install apply: previews', () => {
  it('should refuse an unknown preview and a spent one', async () => {
    const r = rig();
    const none = await refusal(
      r.service.apply('project', { previewId: `cip_${'z'.repeat(22)}`, secretBindings: {} }, GOVERNANCE, STEP_UP),
    );
    should(none.code).equal('catalog_preview_unknown');
    const { preview } = await installSkill(r);
    const again = await refusal(
      r.service.apply('project', { previewId: preview.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP),
    );
    should(again.code).equal('catalog_preview_unknown');
  });

  it('should refuse a preview after 600 seconds and accept it just before', async () => {
    const r = rig();
    const asked = await request(alice, skillItem(alice.daemonId), projectTarget());
    const preview = await r.service.preview('project', asked);
    r.clock.now += 599_999;
    const late = await r.service.preview('project', asked);
    r.clock.now += 1;
    const error = await refusal(
      r.service.apply('project', { previewId: preview.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP),
    );
    should(error.code).equal('catalog_preview_expired');
    await r.service.apply('project', { previewId: late.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP);
  });

  it('should keep only a bounded number of previews, dropping the oldest', async () => {
    const r = rig({ maxKept: 2 });
    const asked = await request(alice, skillItem(alice.daemonId), projectTarget());
    const first = await r.service.preview('project', asked);
    await r.service.preview('project', asked);
    await r.service.preview('project', asked);
    should(r.previews.size).equal(2);
    const error = await refusal(
      r.service.apply('project', { previewId: first.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP),
    );
    should(error.code).equal('catalog_preview_unknown');
  });

  it('should refuse a project preview applied as a runtime install', async () => {
    const r = rig();
    const preview = await r.service.preview(
      'project',
      await request(alice, skillItem(alice.daemonId), projectTarget()),
    );
    const error = await refusal(
      r.service.apply('runtime', { previewId: preview.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP),
    );
    should(error.code).equal('catalog_preview_unknown');
  });

  it('should judge again at apply: a pin made since the preview wins', async () => {
    const r = rig();
    const asked = await request(alice, skillItem(alice.daemonId), projectTarget());
    const preview = await r.service.preview('project', asked);
    r.store.state = { ...r.store.state, pins: { [CATALOG_ID]: mallory.daemonId } };
    const error = await refusal(
      r.service.apply('project', { previewId: preview.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP),
    );
    should(error.code).equal('catalog_publisher_changed');
  });
});

describe('catalog install apply: secret bindings', () => {
  const preview = async (r: Rig, target = projectTarget()) =>
    r.service.preview(target.scope, await request(alice, mcpItem(alice.daemonId), target));

  const apply = (
    r: Rig,
    p: CatalogInstallPreview,
    secretBindings: Record<string, string | null>,
    scope: 'project' | 'runtime' = 'project',
  ) => r.service.apply(scope, { previewId: p.previewId, secretBindings }, GOVERNANCE, STEP_UP);

  it('should refuse a placeholder left out', async () => {
    const r = rig();
    const error = await refusal(apply(r, await preview(r), {}));
    should(error.code).equal('catalog_bindings_invalid');
    should(error.message).match(/ACME_TOKEN/u);
  });

  it('should refuse a placeholder the item never asked for', async () => {
    const r = rig();
    const error = await refusal(apply(r, await preview(r), { ACME_TOKEN: null, EXTRA: null }));
    should(error.code).equal('catalog_bindings_invalid');
    should(error.message).match(/EXTRA is not something/u);
    const two = await refusal(apply(r, await preview(r), { ACME_TOKEN: null, A: null, B: null }));
    should(two.message).match(/are not something/u);
  });

  it('should refuse a binding to a secret this machine does not hold', async () => {
    const r = rig();
    const error = await refusal(apply(r, await preview(r), { ACME_TOKEN: 'MISSING' }));
    should(error.code).equal('catalog_bindings_invalid');
    should(error.message).match(/no secret called MISSING/u);
  });

  it('should install an unbound placeholder even when a secret of that name exists, and not use that secret', async () => {
    const r = rig();
    r.secrets.add('ACME_TOKEN');
    const done = await apply(r, await preview(r), { ACME_TOKEN: null });
    should(done.install.secretBindings).eql({ ACME_TOKEN: null });
    should(r.mcp.text).not.match(/ACME_TOKEN/u);
  });

  it('should write ${OWN} for a project and ${secret:OWN} for a runtime', async () => {
    const r = rig();
    const project = await apply(r, await preview(r), { ACME_TOKEN: 'ACME_TOKEN_OWN' });
    const file = JSON.parse(r.mcp.text ?? '{}') as { mcpServers: Record<string, { env: Record<string, string> }> };
    should(file.mcpServers['acme-mcp']?.env.ACME_TOKEN).equal('${ACME_TOKEN_OWN}');
    should(project.notes[0]).match(/give the ferret a variable called ACME_TOKEN_OWN/u);

    const runtime = await apply(r, await preview(r, runtimeTarget()), { ACME_TOKEN: 'ACME_TOKEN_OWN' }, 'runtime');
    const change = r.fleet.proposed.at(-1);
    should(change?.kind).equal('catalog.install');
    if (change?.kind !== 'catalog.install' || change.component.kind !== 'mcp' || !('env' in change.component))
      throw new Error('shape');
    should(change.component.env?.ACME_TOKEN).equal(secretRef('ACME_TOKEN_OWN'));
    should(runtime.install.secretBindings).eql({ ACME_TOKEN: 'ACME_TOKEN_OWN' });
  });

  const UNSET = 'ACME_TOKEN is not set. The program runs without it until you bind one of your secrets to it.';

  it('should leave an unbound placeholder OUT of a project .mcp.json, record it, and say so', async () => {
    const r = rig();
    const done = await apply(r, await preview(r), { ACME_TOKEN: null });
    const file = JSON.parse(r.mcp.text ?? '{}') as { mcpServers: Record<string, { env?: Record<string, string> }> };
    should(Object.keys(file.mcpServers['acme-mcp']?.env ?? {})).eql([]);
    should(r.mcp.text).not.match(/\$\{/u);
    should(done.install.secretBindings).eql({ ACME_TOKEN: null });
    should(done.notes).containEql(UNSET);
  });

  it('should leave an unbound placeholder OUT of a runtime component, never as somebody’s secret', async () => {
    const r = rig();
    r.secrets.add('ACME_TOKEN');
    const done = await apply(r, await preview(r, runtimeTarget()), { ACME_TOKEN: null }, 'runtime');
    const change = r.fleet.proposed.at(-1);
    if (change?.kind !== 'catalog.install' || change.component.kind !== 'mcp') throw new Error('shape');
    should('env' in change.component).be.false();
    should(JSON.stringify(change.component)).not.match(/ACME_TOKEN/u);
    should(done.install.secretBindings).eql({ ACME_TOKEN: null });
    should(done.notes).containEql(UNSET);
  });

  it('should say nothing about a placeholder that is bound', async () => {
    const r = rig();
    const done = await apply(r, await preview(r), { ACME_TOKEN: 'ACME_TOKEN_OWN' });
    should(done.notes.join(' ')).not.match(/is not set/u);
  });

  it('should refuse, for a project, a secret name that is no environment variable', async () => {
    const r = rig();
    r.secrets.add('my-token');
    const error = await refusal(apply(r, await preview(r), { ACME_TOKEN: 'my-token' }));
    should(error.code).equal('catalog_bindings_invalid');
    should(error.message).match(/is not a name one can have/u);
    // The same name is fine for a runtime.
    await apply(r, await preview(r, runtimeTarget()), { ACME_TOKEN: 'my-token' }, 'runtime');
  });

  it('should install an item with no placeholders with an empty set of bindings', async () => {
    const r = rig();
    const item = mcpItem(alice.daemonId, { mcp: { transport: 'url', url: 'https://mcp.example.com/x' } });
    const p = await r.service.preview('project', await request(alice, item, projectTarget()));
    should(p.secrets).eql([]);
    const done = await r.service.apply('project', { previewId: p.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP);
    should(done.notes).eql([]);
    const file = JSON.parse(r.mcp.text ?? '{}') as { mcpServers: Record<string, unknown> };
    should(Object.keys(file.mcpServers)).eql(['acme-mcp']);
    const runtime = await r.service.preview('runtime', await request(alice, item, runtimeTarget()));
    await r.service.apply('runtime', { previewId: runtime.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP);
    const change = r.fleet.proposed.at(-1);
    if (change?.kind !== 'catalog.install' || !('url' in change.component)) throw new Error('shape');
    should(change.component.url).equal('https://mcp.example.com/x');
  });

  it('should keep an oauth runtime server as an oauth sign-in', async () => {
    const r = rig();
    const item = mcpItem(alice.daemonId, {
      mcp: { transport: 'url', url: 'https://mcp.example.com/x', auth: 'oauth' },
    });
    const p = await r.service.preview('runtime', await request(alice, item, runtimeTarget()));
    await r.service.apply('runtime', { previewId: p.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP);
    const change = r.fleet.proposed.at(-1);
    if (change?.kind !== 'catalog.install' || !('url' in change.component)) throw new Error('shape');
    should(change.component.auth).equal('oauth');
  });

  it('should keep the other servers and fields of an existing .mcp.json', async () => {
    const r = rig();
    r.mcp.text = JSON.stringify({ mcpServers: { mine: { command: 'x' } }, other: 1 });
    r.mcp.version = 4;
    await apply(r, await preview(r), { ACME_TOKEN: null });
    const file = JSON.parse(r.mcp.text ?? '{}') as { mcpServers: Record<string, unknown>; other: number };
    should(Object.keys(file.mcpServers).toSorted()).eql(['acme-mcp', 'mine']);
    should(file.other).equal(1);
  });
});

describe('catalog install apply: what is written and what is recorded', () => {
  it('should write a project skill and record the hash of every file under the folder', async () => {
    const r = rig();
    const { installed } = await installSkill(r);
    should(r.folders.folders.get(`${ROOT}/.claude/skills/pdf-tools`)?.get('SKILL.md')).equal('# pdf tools\n');
    should(installed.install.destination).match(/\.claude\/skills\/pdf-tools\//u);
    const record = r.store.state.installs[0];
    should(record?.files[0]?.path).equal('.claude/skills/pdf-tools/SKILL.md');
    should(record?.files[0]?.sha256).match(/^[0-9a-f]{64}$/u);
    should(r.store.state.revisions[CATALOG_ID]).equal(1);
    should(r.store.state.pins[CATALOG_ID]).equal(alice.daemonId);
    should(Object.keys(r.store.state.publishers)).eql([alice.daemonId]);
  });

  it('should record the state only when the install lands', async () => {
    const r = rig();
    r.folders.racing = true;
    const asked = await request(alice, skillItem(alice.daemonId), projectTarget());
    const preview = await r.service.preview('project', asked);
    const error = await refusal(
      r.service.apply('project', { previewId: preview.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP),
    );
    should(error.code).equal('catalog_install_conflict');
    should(r.store.state.installs).eql([]);
    should(r.store.state.pins).eql({});
  });

  it('should keep the highest revision seen', async () => {
    const r = rig();
    await installSkill(r, skillItem(alice.daemonId), projectTarget(), { revision: 5 });
    const next = skillItem(alice.daemonId, { itemVersion: 2 });
    await installSkill(r, next, projectTarget(), { revision: 5 });
    should(r.store.state.revisions[CATALOG_ID]).equal(5);
    should(r.store.state.installs).have.length(1);
  });

  it('should list what is installed', async () => {
    const r = rig();
    should((await r.service.list()).installs).eql([]);
    const { installed } = await installSkill(r);
    const listed = await r.service.list();
    should(listed.installs[0]?.installId).equal(installed.install.installId);
    should(listed.installs[0]?.provenance.name).equal('pdf-tools');
  });

  it('should replace a skill with a newer version, dropping the files it no longer has', async () => {
    const r = rig();
    const v1 = skillItem(alice.daemonId, {
      files: [
        { path: 'SKILL.md', content: '# v1\n' },
        { path: 'old.md', content: 'old' },
      ],
    });
    await installSkill(r, v1);
    const v2 = skillItem(alice.daemonId, { itemVersion: 2, files: [{ path: 'SKILL.md', content: '# v2\n' }] });
    const { preview, installed } = await installSkill(r, v2);
    should(preview.replaces?.version).equal(1);
    const folder = r.folders.folders.get(`${ROOT}/.claude/skills/pdf-tools`);
    should([...(folder?.keys() ?? [])]).eql(['SKILL.md']);
    should(folder?.get('SKILL.md')).equal('# v2\n');
    should(r.store.state.installs).have.length(1);
    should(r.store.state.installs[0]?.installId).equal(installed.install.installId);
  });

  it('should replace a project server in place', async () => {
    const r = rig();
    await installMcp(r);
    const v2 = mcpItem(alice.daemonId, {
      itemVersion: 2,
      mcp: { transport: 'url', url: 'https://mcp.example.com/two' },
    });
    const { preview } = await installMcp(r, {}, projectTarget(), v2);
    should(preview.replaces?.version).equal(1);
    const file = JSON.parse(r.mcp.text ?? '{}') as { mcpServers: Record<string, { url?: string }> };
    should(file.mcpServers['acme-mcp']?.url).equal('https://mcp.example.com/two');
  });
});

describe('catalog install: conflicts', () => {
  it('should refuse a server already in .mcp.json that no install of ours wrote', async () => {
    const r = rig();
    r.mcp.text = JSON.stringify({ mcpServers: { 'acme-mcp': { command: 'mine' } } });
    const error = await refusal(
      r.service.preview('project', await request(alice, mcpItem(alice.daemonId), projectTarget())),
    );
    should(error.code).equal('catalog_install_conflict');
    should(error.message).match(/no install of ours put there/u);
  });

  it('should refuse when .mcp.json cannot be read as one', async () => {
    const r = rig();
    r.mcp.failRead = new McpProjectFileError('.mcp.json is a symbolic link');
    const error = await refusal(
      r.service.preview('project', await request(alice, mcpItem(alice.daemonId), projectTarget())),
    );
    should(error.code).equal('catalog_install_conflict');
    should(error.message).match(/symbolic link/u);
  });

  it('should let an unexpected read failure through as it is', async () => {
    const r = rig();
    r.mcp.failRead = new Error('disk gone');
    await r.service.preview('project', await request(alice, mcpItem(alice.daemonId), projectTarget())).then(
      () => should.fail(undefined, undefined, 'expected a failure'),
      (error: Error) => should(error.message).equal('disk gone'),
    );
  });

  it('should refuse when .mcp.json changed under the write', async () => {
    const r = rig();
    const preview = await r.service.preview('project', await request(alice, mcpItem(alice.daemonId), projectTarget()));
    r.mcp.racing = true;
    const error = await refusal(
      r.service.apply(
        'project',
        { previewId: preview.previewId, secretBindings: { ACME_TOKEN: null } },
        GOVERNANCE,
        STEP_UP,
      ),
    );
    should(error.code).equal('catalog_install_conflict');
  });

  it('should let another write error through as it is', async () => {
    const r = rig();
    const preview = await r.service.preview('project', await request(alice, mcpItem(alice.daemonId), projectTarget()));
    r.mcp.replace = async () => {
      throw new Error('read-only file system');
    };
    await r.service
      .apply('project', { previewId: preview.previewId, secretBindings: { ACME_TOKEN: null } }, GOVERNANCE, STEP_UP)
      .then(
        () => should.fail(undefined, undefined, 'expected a failure'),
        (error: Error) => should(error.message).equal('read-only file system'),
      );
  });

  it('should refuse a skill folder that already holds files nobody of ours wrote', async () => {
    const r = rig();
    r.folders.folders.set(`${ROOT}/.claude/skills/pdf-tools`, new Map([['SKILL.md', 'mine']]));
    const error = await refusal(
      r.service.preview('project', await request(alice, skillItem(alice.daemonId), projectTarget())),
    );
    should(error.code).equal('catalog_install_conflict');
    should(error.message).match(/no install of ours put there/u);
  });

  it('should treat an empty folder as free', async () => {
    const r = rig();
    r.folders.folders.set(`${ROOT}/.claude/skills/pdf-tools`, new Map());
    await installSkill(r);
  });

  it('should refuse a link on the path, as a conflict with the adapter’s sentence', async () => {
    const r = rig();
    r.folders.refuse = '.claude is a symbolic link, so nothing was written there';
    const error = await refusal(
      r.service.preview('project', await request(alice, skillItem(alice.daemonId), projectTarget())),
    );
    should(error.code).equal('catalog_install_conflict');
    should(error.message).match(/symbolic link/u);
  });

  it('should let an unexpected folder error through as it is', async () => {
    const r = rig();
    r.folders.fail = new Error('disk gone');
    await r.service.preview('project', await request(alice, skillItem(alice.daemonId), projectTarget())).then(
      () => should.fail(undefined, undefined, 'expected a failure'),
      (error: Error) => should(error.message).equal('disk gone'),
    );
  });

  it('should refuse two installs that would land in the same place', async () => {
    const r = rig();
    await installSkill(r);
    const same = skillItem(alice.daemonId, { itemId: OTHER_ITEM });
    const error = await refusal(r.service.preview('project', await request(alice, same, projectTarget())));
    should(error.code).equal('catalog_install_conflict');
    should(error.message).match(/Remove that first/u);
  });

  it('should refuse replacing a skill file that was edited on this machine', async () => {
    const r = rig();
    await installSkill(r);
    r.folders.folders.get(`${ROOT}/.claude/skills/pdf-tools`)?.set('SKILL.md', 'edited by hand');
    const v2 = skillItem(alice.daemonId, { itemVersion: 2 });
    const error = await refusal(r.service.preview('project', await request(alice, v2, projectTarget())));
    should(error.code).equal('catalog_install_conflict');
    should(error.message).match(/edited on this machine/u);
  });

  it('should refuse replacing a folder that gained a file we did not write', async () => {
    const r = rig();
    await installSkill(r);
    r.folders.folders.get(`${ROOT}/.claude/skills/pdf-tools`)?.set('mine.md', 'mine');
    const error = await refusal(
      r.service.preview(
        'project',
        await request(alice, skillItem(alice.daemonId, { itemVersion: 2 }), projectTarget()),
      ),
    );
    should(error.message).match(/no install of ours wrote it/u);
  });

  it('should not call a file we wrote that has since gone missing an edit', async () => {
    const r = rig();
    await installSkill(r);
    r.folders.folders.get(`${ROOT}/.claude/skills/pdf-tools`)?.delete('SKILL.md');
    r.folders.folders.get(`${ROOT}/.claude/skills/pdf-tools`)?.set('keep.md', 'x');
    const error = await refusal(
      r.service.preview(
        'project',
        await request(alice, skillItem(alice.daemonId, { itemVersion: 2 }), projectTarget()),
      ),
    );
    should(error.message).match(/keep\.md/u);
  });

  it('should refuse replacing a server that was edited on this machine', async () => {
    const r = rig();
    await installMcp(r);
    r.mcp.text = (r.mcp.text ?? '').replace('acme-mcp"', 'acme-mcp"').replace('--stdio', '--edited');
    const v2 = mcpItem(alice.daemonId, { itemVersion: 2 });
    const error = await refusal(r.service.preview('project', await request(alice, v2, projectTarget())));
    should(error.code).equal('catalog_install_conflict');
    should(error.message).match(/edited on this machine/u);
  });

  it('should install again over a server a person removed from .mcp.json', async () => {
    const r = rig();
    await installMcp(r);
    r.mcp.text = JSON.stringify({ mcpServers: {} });
    await installMcp(r, { ACME_TOKEN: null }, projectTarget(), mcpItem(alice.daemonId, { itemVersion: 2 }));
  });
});

describe('catalog install: removing', () => {
  it('should remove exactly what a project skill install wrote and its record', async () => {
    const r = rig();
    const { installed } = await installSkill(r);
    const removed = await r.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP);
    should(removed.provenance.name).equal('pdf-tools');
    should(r.folders.folders.size).equal(0);
    should(r.store.state.installs).eql([]);
    should(r.store.state.pins[CATALOG_ID]).equal(alice.daemonId);
  });

  it('should remove a project server and keep the others', async () => {
    const r = rig();
    r.mcp.text = JSON.stringify({ mcpServers: { mine: { command: 'x' } } });
    r.mcp.version = 1;
    const { installed } = await installMcp(r);
    await r.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP);
    const file = JSON.parse(r.mcp.text ?? '{}') as { mcpServers: Record<string, unknown> };
    should(Object.keys(file.mcpServers)).eql(['mine']);
  });

  it('should treat a server already gone from .mcp.json as removed', async () => {
    const r = rig();
    const { installed } = await installMcp(r);
    r.mcp.text = JSON.stringify({ mcpServers: {} });
    await r.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP);
    should(r.store.state.installs).eql([]);
  });

  it('should refuse to remove a server that was edited on this machine', async () => {
    const r = rig();
    const { installed } = await installMcp(r);
    r.mcp.text = (r.mcp.text ?? '').replace('--stdio', '--edited');
    const error = await refusal(r.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP));
    should(error.code).equal('catalog_install_conflict');
    should(error.message).match(/so it was not removed/u);
    should(r.store.state.installs).have.length(1);
  });

  it('should refuse to remove a server when .mcp.json changed under the write', async () => {
    const r = rig();
    const { installed } = await installMcp(r);
    r.mcp.racing = true;
    const error = await refusal(r.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP));
    should(error.code).equal('catalog_install_conflict');
  });

  it('should let another write error through when removing a server', async () => {
    const r = rig();
    const { installed } = await installMcp(r);
    r.mcp.replace = async () => {
      throw new Error('read-only file system');
    };
    await r.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP).then(
      () => should.fail(undefined, undefined, 'expected a failure'),
      (error: Error) => should(error.message).equal('read-only file system'),
    );
  });

  it('should refuse to remove a skill file that was edited on this machine', async () => {
    const r = rig();
    const { installed } = await installSkill(r);
    r.folders.folders.get(`${ROOT}/.claude/skills/pdf-tools`)?.set('SKILL.md', 'edited');
    const error = await refusal(r.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP));
    should(error.code).equal('catalog_install_conflict');
    should(error.message).match(/nothing was removed/u);
    should(r.folders.folders.size).equal(1);
  });

  it('should leave a folder alone that holds a file we did not write', async () => {
    const r = rig();
    const { installed } = await installSkill(r);
    r.folders.folders.get(`${ROOT}/.claude/skills/pdf-tools`)?.set('mine.md', 'x');
    const error = await refusal(r.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP));
    should(error.message).match(/folder was left alone/u);
  });

  it('should treat a skill file already deleted as removed', async () => {
    const r = rig();
    const { installed } = await installSkill(r);
    r.folders.folders.delete(`${ROOT}/.claude/skills/pdf-tools`);
    await r.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP);
    should(r.store.state.installs).eql([]);
  });

  it('should refuse a skill removal that races a change', async () => {
    const r = rig();
    const { installed } = await installSkill(r);
    r.folders.racing = true;
    const error = await refusal(r.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP));
    should(error.code).equal('catalog_install_conflict');
  });

  it('should refuse an unknown install, and one asked for under the wrong scope', async () => {
    const r = rig();
    const none = await refusal(r.service.remove('project', `cin_${'z'.repeat(22)}`, GOVERNANCE, STEP_UP));
    should(none.code).equal('catalog_install_unknown');
    const { installed } = await installSkill(r);
    const wrong = await refusal(r.service.remove('runtime', installed.install.installId, GOVERNANCE, STEP_UP));
    should(wrong.code).equal('catalog_install_unknown');
  });
});

describe('catalog install: a runtime', () => {
  it('should install a server as one fleet change, applied under the caller’s governance', async () => {
    const r = rig();
    const { installed } = await installMcp(r, { ACME_TOKEN: null }, runtimeTarget());
    const change = r.fleet.proposed[0];
    should(change?.kind).equal('catalog.install');
    if (change?.kind !== 'catalog.install') throw new Error('shape');
    should(change.name).equal('acme-mcp');
    should(change.profile).equal('work');
    should(change.replace).be.false();
    should(change.installedFrom.name).equal('acme-mcp');
    should(r.fleet.applied).eql(['change-1']);
    should(installed.notes.at(-1)).match(/layer of profile work/u);
    should(r.store.state.installs[0]?.files).eql([]);
  });

  it('should install a skill, recording its files under skills/<name>/', async () => {
    const r = rig();
    await installSkill(r, skillItem(alice.daemonId), runtimeTarget());
    const change = r.fleet.proposed[0];
    if (change?.kind !== 'catalog.install') throw new Error('shape');
    should(change.component).eql({ kind: 'skills', items: ['pdf-tools'] });
    should(change.files).eql([{ path: 'SKILL.md', content: '# pdf tools\n' }]);
    should(r.store.state.installs[0]?.files[0]?.path).equal('skills/pdf-tools/SKILL.md');
  });

  it('should replace an installed skill with a newer version and drop its stale files', async () => {
    const r = rig();
    const v1 = skillItem(alice.daemonId, {
      files: [
        { path: 'SKILL.md', content: '# v1\n' },
        { path: 'old.md', content: 'old' },
      ],
    });
    await installSkill(r, v1, runtimeTarget());
    const v2 = skillItem(alice.daemonId, { itemVersion: 2, files: [{ path: 'SKILL.md', content: '# v2\n' }] });
    const { preview } = await installSkill(r, v2, runtimeTarget());
    should(preview.replaces?.version).equal(1);
    const change = r.fleet.proposed.at(-1);
    if (change?.kind !== 'catalog.install') throw new Error('shape');
    should(change.replace).be.true();
    should([...(r.folders.folders.get('runtime/pdf-tools')?.keys() ?? [])]).eql(['SKILL.md']);
  });

  it('should replace a skill whose files did not change names without removing anything', async () => {
    const r = rig();
    await installSkill(r, skillItem(alice.daemonId), runtimeTarget());
    await installSkill(r, skillItem(alice.daemonId, { itemVersion: 2 }), runtimeTarget());
    should(r.folders.folders.get('runtime/pdf-tools')?.has('SKILL.md')).be.true();
  });

  it('should replace a server', async () => {
    const r = rig();
    await installMcp(r, { ACME_TOKEN: null }, runtimeTarget());
    const v2 = mcpItem(alice.daemonId, { itemVersion: 2 });
    const { preview } = await installMcp(r, { ACME_TOKEN: null }, runtimeTarget(), v2);
    should(preview.replaces?.version).equal(1);
  });

  it('should refuse a name that is already a component of ours that nobody installed from a catalog', async () => {
    const r = rig();
    r.fleet.components.set('mcp', [{ name: 'acme-mcp', detail: {} }]);
    const error = await refusal(
      r.service.preview('runtime', await request(alice, mcpItem(alice.daemonId), runtimeTarget())),
    );
    should(error.code).equal('catalog_install_conflict');
    r.fleet.components.set('skills', [{ name: 'pdf-tools', detail: {} }]);
    const skill = await refusal(
      r.service.preview('runtime', await request(alice, skillItem(alice.daemonId), runtimeTarget())),
    );
    should(skill.message).match(/is already a skill/u);
  });

  it('should refuse replacing a component that was edited since (its provenance is gone)', async () => {
    const r = rig();
    await installMcp(r, { ACME_TOKEN: null }, runtimeTarget());
    r.fleet.components.set('mcp', [{ name: 'acme-mcp', detail: {} }]);
    const v2 = mcpItem(alice.daemonId, { itemVersion: 2 });
    const error = await refusal(r.service.preview('runtime', await request(alice, v2, runtimeTarget())));
    should(error.code).equal('catalog_install_conflict');
    should(error.message).match(/edited on this machine/u);
  });

  it('should refuse a skill folder holding files nobody of ours wrote', async () => {
    const r = rig();
    r.folders.folders.set('runtime/pdf-tools', new Map([['SKILL.md', 'mine']]));
    const error = await refusal(
      r.service.preview('runtime', await request(alice, skillItem(alice.daemonId), runtimeTarget())),
    );
    should(error.code).equal('catalog_install_conflict');
  });

  it('should let a failed fleet change through and record nothing', async () => {
    const r = rig();
    const preview = await r.service.preview(
      'runtime',
      await request(alice, skillItem(alice.daemonId), runtimeTarget()),
    );
    r.fleet.failApply = new Error('step-up needed');
    await r.service.apply('runtime', { previewId: preview.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP).then(
      () => should.fail(undefined, undefined, 'expected a failure'),
      (error: Error) => should(error.message).equal('step-up needed'),
    );
    should(r.store.state.installs).eql([]);
    // The next turn still runs after a failed one.
    r.fleet.failApply = undefined;
    await r.service.apply('runtime', { previewId: preview.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP);
  });

  it('should remove a skill install: the component, then exactly the files it wrote', async () => {
    const r = rig();
    const { installed } = await installSkill(r, skillItem(alice.daemonId), runtimeTarget());
    await r.service.remove('runtime', installed.install.installId, GOVERNANCE, STEP_UP);
    const change = r.fleet.proposed.at(-1);
    should(change).containEql({
      kind: 'component.remove',
      componentKind: 'skills',
      name: 'pdf-tools',
      removeFromProfiles: true,
    });
    should(r.folders.folders.size).equal(0);
    should(r.store.state.installs).eql([]);
  });

  it('should remove a server install without touching any skill folder', async () => {
    const r = rig();
    const { installed } = await installMcp(r, { ACME_TOKEN: null }, runtimeTarget());
    await r.service.remove('runtime', installed.install.installId, GOVERNANCE, STEP_UP);
    should(r.fleet.proposed.at(-1)).containEql({ kind: 'component.remove', componentKind: 'mcp' });
  });

  it('should refuse to remove a component that was edited since it was installed', async () => {
    const r = rig();
    const { installed } = await installMcp(r, { ACME_TOKEN: null }, runtimeTarget());
    r.fleet.components.set('mcp', [{ name: 'acme-mcp', detail: {} }]);
    const error = await refusal(r.service.remove('runtime', installed.install.installId, GOVERNANCE, STEP_UP));
    should(error.code).equal('catalog_install_conflict');
    should(error.message).match(/so it was not removed/u);
  });

  it('should refuse to remove a skill file that was edited on this machine', async () => {
    const r = rig();
    const { installed } = await installSkill(r, skillItem(alice.daemonId), runtimeTarget());
    r.folders.folders.get('runtime/pdf-tools')?.set('SKILL.md', 'edited');
    const error = await refusal(r.service.remove('runtime', installed.install.installId, GOVERNANCE, STEP_UP));
    should(error.code).equal('catalog_install_conflict');
  });

  it('should still clean up when the component was already removed by hand', async () => {
    const r = rig();
    const { installed } = await installSkill(r, skillItem(alice.daemonId), runtimeTarget());
    r.fleet.components.set('skills', []);
    await r.service.remove('runtime', installed.install.installId, GOVERNANCE, STEP_UP);
    should(r.fleet.proposed.filter(change => change.kind === 'component.remove')).have.length(0);
    should(r.folders.folders.size).equal(0);
  });
});

describe('catalog install: previews belong to the caller who asked', () => {
  const BOB = { id: 'device:dev_b', mayListSecrets: true };
  const apply = (as: ReturnType<Rig['as']>, previewId: string) =>
    as.apply('project', { previewId, secretBindings: {} }, GOVERNANCE, STEP_UP);

  it('should refuse another caller’s apply as an unknown preview, and leave it for its owner', async () => {
    const r = rig();
    const preview = await r.service.preview(
      'project',
      await request(alice, skillItem(alice.daemonId), projectTarget()),
    );
    const error = await refusal(apply(r.as(BOB), preview.previewId));
    should(error.code).equal('catalog_preview_unknown');
    should(r.store.state.installs).eql([]);
    await apply(r.service, preview.previewId);
    should(r.store.state.installs).have.length(1);
  });

  it('should give each caller its own bound, so one caller cannot push another’s preview out', async () => {
    const r = rig({ maxKept: 2 });
    const asked = await request(alice, skillItem(alice.daemonId), projectTarget());
    const bobs = await r.as(BOB).preview('project', asked);
    const first = await r.service.preview('project', asked);
    await r.service.preview('project', asked);
    await r.service.preview('project', asked);
    should((await refusal(apply(r.service, first.previewId))).code).equal('catalog_preview_unknown');
    await apply(r.as(BOB), bobs.previewId);
    should(r.store.state.installs).have.length(1);
  });
});

describe('catalog install: secret names are only told to a caller who may list them', () => {
  it('should report whether a secret of that name is held to a caller who may list secrets', async () => {
    const r = rig();
    r.secrets = new Set(['ACME_TOKEN']);
    const preview = await r
      .as({ id: 'host', mayListSecrets: true })
      .preview('project', await request(alice, mcpItem(alice.daemonId), projectTarget()));
    should(preview.secrets).eql([{ placeholder: 'ACME_TOKEN', held: true }]);
  });

  it('should leave `held` out for any other caller, whether or not the secret exists', async () => {
    const r = rig();
    const other = r.as({ id: 'agents', mayListSecrets: false });
    const asked = await request(alice, mcpItem(alice.daemonId), projectTarget());
    for (const names of [['ACME_TOKEN'], []]) {
      r.secrets = new Set(names);
      const preview = await other.preview('project', asked);
      should(preview.secrets).eql([{ placeholder: 'ACME_TOKEN' }]);
      should('held' in (preview.secrets[0] ?? {})).be.false();
    }
  });
});

describe('catalog install: a target is one place however it is spelled', () => {
  it('should remove a project skill installed through a root spelled with a trailing slash', async () => {
    const r = rig();
    const { installed } = await installSkill(r, skillItem(alice.daemonId), projectTarget('claude', '/work/app/'));
    should(r.folders.folders.get(`${ROOT}/.claude/skills/pdf-tools`)?.has('SKILL.md')).be.true();
    const record = r.store.state.installs[0];
    should(record?.root).equal(ROOT);
    should(record?.folder).equal('.claude/skills/pdf-tools');
    await r.service.remove('project', installed.install.installId, GOVERNANCE, STEP_UP);
    should(r.folders.folders.size).equal(0);
    should(r.store.state.installs).eql([]);
  });

  it('should treat two spellings of one project root as the same install to replace', async () => {
    const r = rig();
    await installSkill(r, skillItem(alice.daemonId), projectTarget('claude', '/work/app/'));
    const v2 = skillItem(alice.daemonId, { itemVersion: 2 });
    const preview = await r.service.preview('project', await request(alice, v2, projectTarget('claude', ROOT)));
    should(preview.replaces?.version).equal(1);
  });

  it('should treat a runtime’s id and its name as the same install to replace', async () => {
    const r = rig();
    await installSkill(r, skillItem(alice.daemonId), runtimeTarget('rt-claude'));
    const v2 = skillItem(alice.daemonId, { itemVersion: 2 });
    const preview = await r.service.preview('runtime', await request(alice, v2, runtimeTarget('claude-work')));
    should(preview.replaces?.version).equal(1);
  });

  it('should compare folder files exactly: a file that merely ends the same is not the recorded one', async () => {
    const r = rig();
    await installSkill(r);
    r.folders.folders.get(`${ROOT}/.claude/skills/pdf-tools`)?.set('sub/SKILL.md', '# pdf tools\n');
    const error = await refusal(
      r.service.preview(
        'project',
        await request(alice, skillItem(alice.daemonId, { itemVersion: 2 }), projectTarget()),
      ),
    );
    should(error.code).equal('catalog_install_conflict');
    should(error.message).match(/sub\/SKILL\.md is here but no install of ours wrote it/u);
  });
});

describe('catalog install: a replace is guarded by the reading that was checked', () => {
  const v1 = () =>
    skillItem(alice.daemonId, {
      files: [
        { path: 'SKILL.md', content: '# v1\n' },
        { path: 'old.md', content: 'old' },
      ],
    });
  const v2 = () => skillItem(alice.daemonId, { itemVersion: 2, files: [{ path: 'SKILL.md', content: '# v2\n' }] });

  it('should replace a runtime skill whose stale file a person already deleted', async () => {
    const r = rig();
    await installSkill(r, v1(), runtimeTarget());
    r.folders.folders.get('runtime/pdf-tools')?.delete('old.md');
    await installSkill(r, v2(), runtimeTarget());
    should([...(r.folders.folders.get('runtime/pdf-tools')?.keys() ?? [])]).eql(['SKILL.md']);
  });

  it('should refuse as a conflict when the folder changes under the removal of a stale file', async () => {
    const r = rig();
    await installSkill(r, v1(), runtimeTarget());
    const preview = await r.service.preview('runtime', await request(alice, v2(), runtimeTarget()));
    r.folders.racing = true;
    const error = await refusal(
      r.service.apply('runtime', { previewId: preview.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP),
    );
    should(error.code).equal('catalog_install_conflict');
  });
});

describe('catalog install: a runtime component is judged by what it holds, not by where it says it came from', () => {
  const edited = (r: Rig) => {
    const current = r.fleet.components.get('mcp')?.[0];
    r.fleet.components.set('mcp', [
      { ...current, name: 'acme-mcp', detail: { ...(current?.detail as object), edited: 1 } },
    ]);
  };

  it('should refuse replacing a component edited by hand even though its provenance is kept', async () => {
    const r = rig();
    await installMcp(r, { ACME_TOKEN: null }, runtimeTarget());
    edited(r);
    should(r.fleet.components.get('mcp')?.[0]?.installedFrom).not.be.undefined();
    const error = await refusal(
      r.service.preview('runtime', await request(alice, mcpItem(alice.daemonId, { itemVersion: 2 }), runtimeTarget())),
    );
    should(error.message).match(/edited on this machine/u);
  });

  it('should refuse removing a component edited by hand even though its provenance is kept', async () => {
    const r = rig();
    const { installed } = await installMcp(r, { ACME_TOKEN: null }, runtimeTarget());
    edited(r);
    const error = await refusal(r.service.remove('runtime', installed.install.installId, GOVERNANCE, STEP_UP));
    should(error.message).match(/so it was not removed/u);
  });

  it('should not call a component edited when only the order of its keys changed', async () => {
    const r = rig();
    await installMcp(r, { ACME_TOKEN: null }, runtimeTarget());
    const current = r.fleet.components.get('mcp')?.[0];
    const reordered = Object.fromEntries(Object.entries(current?.detail as object).reverse());
    r.fleet.components.set('mcp', [{ ...current, name: 'acme-mcp', detail: reordered }]);
    const preview = await r.service.preview(
      'runtime',
      await request(alice, mcpItem(alice.daemonId, { itemVersion: 2 }), runtimeTarget()),
    );
    should(preview.replaces?.version).equal(1);
  });
});
