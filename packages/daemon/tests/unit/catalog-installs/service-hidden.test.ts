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

  it.each([
    ['a word before the break', `notes\ngh\np_abcdefghijklmnopqrstuvwxyz0123456789\n`],
    ['an indented continuation', `notes\n    gh\n    p_abcdefghijklmnopqrstuvwxyz0123456789\n`],
  ])('should hide a token split across lines with %s, in the whole answer', async (_label, text) => {
    const r = rig();
    await install(r, skillV(1, '# one\n'), projectTarget());
    r.folders.folders.get(FOLDER)?.set('SKILL.md', text);
    const preview = await r.service.preview(
      'project',
      await request(alice, skillV(2, '# two\n'), projectTarget(), { replaceEdited: true }),
    );
    should(wire(preview)).not.match(/p_abcdefghijkl|abcdefghijklmnopqrstuvwxyz0123456789/u);
  });

  it('should show a hidden change as a change when only a secret differs on disk', async () => {
    const r = rig();
    await install(r, skillV(1, 'API_TOKEN=exampleexample1\n'), projectTarget());
    r.folders.folders.get(FOLDER)?.set('SKILL.md', 'API_TOKEN=myrealtoken99x\n');
    const preview = await r.service.preview(
      'project',
      await request(alice, skillV(2, 'API_TOKEN=exampleexample1\n'), projectTarget(), { replaceEdited: true }),
    );
    should(wire(preview.changes)).not.match(/myrealtoken99x/u);
    should(preview.changes?.entries.length).be.above(0);
  });

  it('should hide a short password under a name that announces a secret', async () => {
    const r = rig();
    await install(r, mcpV(1, { ACME_TOKEN: '${secret:ACME_TOKEN}' }), runtimeTarget(), { ACME_TOKEN: null });
    typedInto(r, { DB_PASSWORD: 'hunter2' });
    const preview = await r.service.preview(
      'runtime',
      await request(alice, mcpV(2, { ACME_TOKEN: '${secret:ACME_TOKEN}' }), runtimeTarget(), { replaceEdited: true }),
    );
    should(wire(preview)).not.match(/hunter2/u);
  });

  it('should hide a password that follows its flag, and one in the user info of an environment address', async () => {
    const r = rig();
    await install(r, mcpV(1, { ACME_TOKEN: '${secret:ACME_TOKEN}' }), runtimeTarget(), { ACME_TOKEN: null });
    const current = r.fleet.components.get('mcp')?.[0];
    const detail = current?.detail as { env?: Record<string, string> };
    r.fleet.components.set('mcp', [
      {
        ...current,
        name: 'acme-mcp',
        detail: {
          ...detail,
          args: ['--stdio', '--password', 'hunter2xyz'],
          env: { ...detail.env, DB_URL: 'postgres://app:pa55word99@db/app' },
        },
      },
    ]);
    const preview = await r.service.preview(
      'runtime',
      await request(alice, mcpV(2, { ACME_TOKEN: '${secret:ACME_TOKEN}' }), runtimeTarget(), { replaceEdited: true }),
    );
    should(wire(preview)).not.match(/hunter2xyz|pa55word99/u);
  });

  it.each([
    ['a trailing space', `notes\ngh \np_abcdefghijklmnopqrstuvwxyz0123456789\n`],
    ['carriage returns only', 'notes\rgh\rp_abcdefghijklmnopqrstuvwxyz0123456789\r'],
    ['a path before the break', `see path/gh\np_abcdefghijklmnopqrstuvwxyz0123456789\n`],
    ['a short password', 'password: hunter2\n'],
    ['a short password on the next line', 'password:\nhunter2\n'],
    ['a space before the separator', 'password =\nhunter2\n'],
    ['a space before a colon', 'password :\nhunter2\n'],
    ['a long value after a spaced separator', 'password =\nhunter2hunter2xyz\n'],
    ['a block value', 'password: |\n  hunter2\n'],
    ['a folded block value', 'password: >-\n  hunter2hunter2xyz\n'],
    ['a nested short pass', 'db:\n  pass: hunter2\n'],
    ['a nested quoted token', 'auth:\n  api_token: "hunter2"\n'],
    ['a nested long password', 'database:\n  password: hunter2hunter2xyz\n'],
    ['a nested pasted token', 'env:\n  GITHUB_TOKEN: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n'],
    ['a digit-led name', '9TOKEN=hunter2hunter2xyz\n'],
    ['separators before the name', '-=TOKEN=hunter2hunter2xyz\n'],
  ])('should hide a secret in a skill file with %s, in the whole answer', async (_label, text) => {
    const r = rig();
    await install(r, skillV(1, '# one\n'), projectTarget());
    r.folders.folders.get(FOLDER)?.set('SKILL.md', text);
    const preview = await r.service.preview(
      'project',
      await request(alice, skillV(2, '# two\n'), projectTarget(), { replaceEdited: true }),
    );
    should(wire(preview)).not.match(/p_abcdefghijkl|abcdefghijklmnopqrstuvwxyz0123456789|hunter2|ghp_abcdefgh/u);
  });

  it('should hide PASS, DB_PASS and --pass typed into a server, in the whole answer', async () => {
    const r = rig();
    await install(r, mcpV(1, { ACME_TOKEN: '${secret:ACME_TOKEN}' }), runtimeTarget(), { ACME_TOKEN: null });
    const current = r.fleet.components.get('mcp')?.[0];
    const detail = current?.detail as { env?: Record<string, string> };
    r.fleet.components.set('mcp', [
      {
        ...current,
        name: 'acme-mcp',
        detail: {
          ...detail,
          args: ['--stdio', '--pass', 'hunter2'],
          env: { ...detail.env, PASS: 'abc1', DB_PASS: 'zz9' },
        },
      },
    ]);
    const preview = await r.service.preview(
      'runtime',
      await request(alice, mcpV(2, { ACME_TOKEN: '${secret:ACME_TOKEN}' }), runtimeTarget(), { replaceEdited: true }),
    );
    should(wire(preview)).not.match(/hunter2|abc1|zz9/u);
  });

  it('should answer a 256 KiB file on disk without reading it, and say it was hidden', async () => {
    const r = rig();
    await install(r, skillV(1, '# one\n'), projectTarget());
    r.folders.folders.get(FOLDER)?.set('SKILL.md', 'a'.repeat(256 * 1024));
    const started = performance.now();
    const preview = await r.service.preview(
      'project',
      await request(alice, skillV(2, '# two\n'), projectTarget(), { replaceEdited: true }),
    );
    should(performance.now() - started).be.below(5000);
    should(wire(preview.changes)).match(/‹hidden›/u);
  });
});
