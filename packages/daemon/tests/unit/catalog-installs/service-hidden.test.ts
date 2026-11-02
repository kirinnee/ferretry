import { beforeAll, describe, it } from 'bun:test';
import type { CatalogInstallTarget, SharedCatalogItem } from '@ferretry/protocol';
import type { DaemonIdentity } from '@ferretry/relay';
import should from 'should';
import { HIDDEN, HIDDEN_DIFFERENT } from '../../../src/lib/catalog-installs/hide-secrets.ts';
import { mcpItem, newIdentity, skillItem } from '../../support/catalog-fixtures.ts';
import { GOVERNANCE, projectTarget, request, rig, ROOT, runtimeTarget, STEP_UP, type Rig } from './service-support.ts';

let alice: DaemonIdentity;
beforeAll(async () => {
  alice = await newIdentity();
});

const FOLDER = `${ROOT}/.claude/skills/pdf-tools`;
const PASSWORD = 'hunter2xyz';
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
// A token cut in the middle of its own prefix, so no single line holds anything that looks like one.
const SPLIT = ['see gh', 'p_abcdefghijklmnopqrstuvwxyz0123456789', 'for the rest'];

const skillV = (version: number, content: string) =>
  skillItem(alice.daemonId, { itemVersion: version, files: [{ path: 'SKILL.md', content }] });

const mcpV = (version: number, env: Record<string, string>) =>
  mcpItem(alice.daemonId, {
    itemVersion: version,
    mcp: { transport: 'command', command: 'acme-mcp', args: ['--stdio'], env },
  });

async function install(r: Rig, item: SharedCatalogItem, target: CatalogInstallTarget, bindings = {}) {
  const preview = await r.service.preview(target.scope, await request(alice, item, target));
  await r.service.apply(target.scope, { previewId: preview.previewId, secretBindings: bindings }, GOVERNANCE, STEP_UP);
}

/** The whole answer, as a ferret would receive it. */
const wire = (value: unknown): string => JSON.stringify(value);

const typedInto = (r: Rig, env: Record<string, string>) => {
  const current = r.fleet.components.get('mcp')?.[0];
  const detail = current?.detail as { env?: Record<string, string> };
  r.fleet.components.set('mcp', [
    { ...current, name: 'acme-mcp', detail: { ...detail, env: { ...detail.env, ...env } } },
  ]);
};

describe('see changes never carries a value typed in by hand', () => {
  it('should hide a short password typed into a runtime server’s environment', async () => {
    const r = rig();
    await install(r, mcpV(1, { ACME_TOKEN: '${secret:ACME_TOKEN}' }), runtimeTarget(), { ACME_TOKEN: null });
    typedInto(r, { DB_PASSWORD: PASSWORD });
    const preview = await r.service.preview(
      'runtime',
      await request(alice, mcpV(2, { ACME_TOKEN: '${secret:ACME_TOKEN}' }), runtimeTarget(), { replaceEdited: true }),
    );
    should(wire(preview)).not.match(new RegExp(PASSWORD, 'u'));
    const entry = preview.changes?.entries.find(candidate => candidate.before === HIDDEN);
    should(entry?.change).equal('removed');
  });

  it('should hide a short password in a project server’s entry', async () => {
    const r = rig();
    await install(r, mcpV(1, { ACME_TOKEN: '${secret:ACME_TOKEN}' }), projectTarget(), { ACME_TOKEN: null });
    const written = JSON.parse(r.mcp.text ?? '{}') as { mcpServers: Record<string, { env?: Record<string, string> }> };
    const server = written.mcpServers['acme-mcp'];
    if (server === undefined) throw new Error('no server');
    server.env = { ...server.env, DB_PASSWORD: PASSWORD };
    r.mcp.text = JSON.stringify(written);
    const preview = await r.service.preview(
      'project',
      await request(alice, mcpV(2, { ACME_TOKEN: '${secret:ACME_TOKEN}' }), projectTarget(), { replaceEdited: true }),
    );
    should(wire(preview)).not.match(new RegExp(PASSWORD, 'u'));
    should(preview.changes?.entries.some(entry => entry.before === HIDDEN)).equal(true);
  });

  it('should hide the offered side with the same rule, and say a hidden value differs', async () => {
    const r = rig();
    await install(r, mcpV(1, { DB_PASSWORD: PASSWORD }), runtimeTarget());
    const preview = await r.service.preview(
      'runtime',
      await request(alice, mcpV(2, { DB_PASSWORD: 'swordfish99' }), runtimeTarget()),
    );
    should(wire(preview.changes)).not.match(/swordfish99|hunter2xyz/u);
    const entry = preview.changes?.entries.find(candidate => candidate.after === HIDDEN_DIFFERENT);
    should(entry?.before).equal(HIDDEN);
  });

  it('should not report a hidden value as changed when it is the same on both sides', async () => {
    const r = rig();
    await install(r, mcpV(1, { DB_PASSWORD: PASSWORD }), runtimeTarget());
    const preview = await r.service.preview(
      'runtime',
      await request(alice, mcpV(2, { DB_PASSWORD: PASSWORD }), runtimeTarget()),
    );
    // The review shows the offered item whole (the publisher's own text); the comparison is what is checked.
    should(wire(preview.changes)).not.match(new RegExp(PASSWORD, 'u'));
    should(preview.changes?.entries).eql([]);
  });

  it('should hide a token pasted into a project skill, wherever the answer carries text', async () => {
    const r = rig();
    await install(r, skillV(1, '# one\nsame\n'), projectTarget());
    r.folders.folders.get(FOLDER)?.set('SKILL.md', `# one\nAPI_TOKEN=${TOKEN}\nsame\n`);
    const preview = await r.service.preview(
      'project',
      await request(alice, skillV(2, '# two\nsame\n'), projectTarget(), { replaceEdited: true }),
    );
    should(wire(preview)).not.match(/ghp_abcdefgh/u);
    should(wire(preview.changes)).match(/API_TOKEN=‹hidden›/u);
  });

  it('should hide a token pasted into a runtime skill', async () => {
    const r = rig();
    await install(r, skillV(1, '# one\n'), runtimeTarget());
    r.folders.folders.get('runtime/pdf-tools')?.set('SKILL.md', `# one\nuse ${TOKEN} here\n`);
    const preview = await r.service.preview(
      'runtime',
      await request(alice, skillV(2, '# two\n'), runtimeTarget(), { replaceEdited: true }),
    );
    should(wire(preview)).not.match(/ghp_abcdefgh/u);
  });

  it('should hide a token split across lines, whole file, in the answer and the edited list', async () => {
    const r = rig();
    await install(r, skillV(1, '# one\n'), projectTarget());
    r.folders.folders.get(FOLDER)?.set('SKILL.md', `# one\n${SPLIT.join('\n')}\n`);
    const preview = await r.service.preview(
      'project',
      await request(alice, skillV(2, '# two\n'), projectTarget(), { replaceEdited: true }),
    );
    const json = wire(preview);
    should(json).not.match(/p_abcdefghijkl/u);
    should(json).not.match(/abcdefghijklmnopqrstuvwxyz0123456789/u);
    should(wire(preview.changes)).match(/‹hidden›/u);
  });

  it('should say a wholly hidden file differs from the offered one that is hidden too', async () => {
    const r = rig();
    await install(r, skillV(1, '# one\n'), projectTarget());
    r.folders.folders.get(FOLDER)?.set('SKILL.md', `# one\n${SPLIT.join('\n')}\n`);
    const other = `# two\n${SPLIT.join('\n')}\nmore\n`;
    const preview = await r.service.preview(
      'project',
      await request(alice, skillV(2, other), projectTarget(), { replaceEdited: true }),
    );
    // The review shows the offered file whole: it is the publisher's own text. The comparison is what must not.
    should(wire(preview.changes)).not.match(/p_abcdefghijkl/u);
    should(wire(preview.changes)).match(/hidden, different/u);
  });

  it('should refuse an edited file without leaking its text in the refusal', async () => {
    const r = rig();
    await install(r, skillV(1, '# one\n'), projectTarget());
    r.folders.folders.get(FOLDER)?.set('SKILL.md', `API_TOKEN=${TOKEN}\n`);
    try {
      await r.service.preview('project', await request(alice, skillV(2, '# two\n'), projectTarget()));
      throw new Error('expected a refusal');
    } catch (error) {
      should((error as Error).message).not.match(/ghp_abcdefgh/u);
    }
  });
});
