import { beforeAll, describe, it } from 'bun:test';
import type { CatalogInstallTarget, SharedCatalogItem } from '../../../daemon/lib/boundary.ts';
import type { DaemonIdentity } from '../../../daemon/adapters/relay.ts';
import should from 'should';
import { mayHoldSecret } from '../../../daemon/lib/catalog-installs/conservative-changes.ts';
import { mcpItem, newIdentity, skillItem } from '../../support/catalog-fixtures.ts';
import { GOVERNANCE, projectTarget, request, rig, ROOT, runtimeTarget, STEP_UP, type Rig } from './service-support.ts';

let alice: DaemonIdentity;
beforeAll(async () => {
  alice = await newIdentity();
});

const SOFT_HYPHEN = String.fromCodePoint(0xad);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
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

const typedInto = (r: Rig, env: Record<string, string>, args?: string[]) => {
  const current = r.fleet.components.get('mcp')?.[0];
  const detail = current?.detail as { env?: Record<string, string> };
  r.fleet.components.set('mcp', [
    {
      ...current,
      name: 'acme-mcp',
      detail: { ...detail, ...(args === undefined ? {} : { args }), env: { ...detail.env, ...env } },
    },
  ]);
};

/** Preview replacing a project skill whose file on disk reads `onDisk`, offering `offered`. */
async function skillPreview(onDisk: string, offered = '# two\n') {
  const r = rig();
  await install(r, skillV(1, '# one\n'), projectTarget());
  r.folders.folders.get(FOLDER)?.set('SKILL.md', onDisk);
  return r.service.preview(
    'project',
    await request(alice, skillV(2, offered), projectTarget(), { replaceEdited: true }),
  );
}

const hiddenEntry = (preview: { changes?: { entries: readonly { label: string; hidden?: true }[] } }) =>
  preview.changes?.entries.find(entry => entry.hidden === true);

describe('see changes never carries text that may be a secret', () => {
  it('should hide a short password typed into a runtime server’s environment, showing only that it changed', async () => {
    const r = rig();
    await install(r, mcpV(1, { ACME_TOKEN: '${secret:ACME_TOKEN}' }), runtimeTarget(), { ACME_TOKEN: null });
    typedInto(r, { DB_PASSWORD: PASSWORD });
    const preview = await r.service.preview(
      'runtime',
      await request(alice, mcpV(2, { ACME_TOKEN: '${secret:ACME_TOKEN}' }), runtimeTarget(), { replaceEdited: true }),
    );
    should(wire(preview)).not.match(new RegExp(PASSWORD, 'u'));
    should(preview.changes?.entries).eql([
      { label: 'Environment DB_PASSWORD', change: 'changed', document: false, hidden: true, flag: 'command' },
    ]);
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
    should(hiddenEntry(preview)).be.ok();
  });

  it('should never show an environment value, hidden on both sides and different', async () => {
    const r = rig();
    await install(r, mcpV(1, { REGION: 'eu-west-1' }), runtimeTarget());
    const preview = await r.service.preview(
      'runtime',
      await request(alice, mcpV(2, { REGION: 'us-east-2' }), runtimeTarget()),
    );
    should(wire(preview.changes)).not.match(/eu-west-1|us-east-2/u);
    should(preview.changes?.entries).eql([
      { label: 'Environment REGION', change: 'changed', document: false, hidden: true, flag: 'command' },
    ]);
  });

  it('should say a value that is the same on both sides is unchanged, without showing it', async () => {
    const r = rig();
    await install(r, mcpV(1, { DB_PASSWORD: PASSWORD }), runtimeTarget());
    const preview = await r.service.preview(
      'runtime',
      await request(alice, mcpV(2, { DB_PASSWORD: PASSWORD }), runtimeTarget()),
    );
    should(wire(preview.changes)).not.match(new RegExp(PASSWORD, 'u'));
    should(preview.changes?.entries).eql([]);
    should(preview.changes?.unchanged).be.above(0);
  });

  it('should hide a file when only a secret differs on disk, and still call it a change', async () => {
    const r = rig();
    await install(r, skillV(1, 'API_TOKEN=exampleexample1\n'), projectTarget());
    r.folders.folders.get(FOLDER)?.set('SKILL.md', 'API_TOKEN=myrealtoken99x\n');
    const preview = await r.service.preview(
      'project',
      await request(alice, skillV(2, 'API_TOKEN=exampleexample1\n'), projectTarget(), { replaceEdited: true }),
    );
    should(wire(preview.changes)).not.match(/myrealtoken99x|exampleexample1/u);
    should(hiddenEntry(preview)?.label).equal('Skill file SKILL.md');
  });

  it('should still draw a plain file as a normal diff', async () => {
    const preview = await skillPreview('# one\nsame\nold line\n', '# one\nsame\nnew line\n');
    const entry = preview.changes?.entries[0];
    should(entry?.hidden).be.undefined();
    should(entry?.hunks?.[0]?.lines.map(line => `${line.kind}:${line.text}`)).containEql('remove:old line');
    should(entry?.hunks?.[0]?.lines.map(line => `${line.kind}:${line.text}`)).containEql('add:new line');
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
    should(hiddenEntry(preview)).be.ok();
  });

  it('should hide a token split across lines, in the answer and the edited list', async () => {
    const preview = await skillPreview(`# one\n${SPLIT.join('\n')}\n`);
    const json = wire(preview);
    should(json).not.match(/p_abcdefghijkl/u);
    should(json).not.match(/abcdefghijklmnopqrstuvwxyz0123456789/u);
    should(hiddenEntry(preview)).be.ok();
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

  it('should hide a password that follows its flag, and one in the user info of an environment address', async () => {
    const r = rig();
    await install(r, mcpV(1, { ACME_TOKEN: '${secret:ACME_TOKEN}' }), runtimeTarget(), { ACME_TOKEN: null });
    typedInto(r, { DB_URL: 'postgres://app:pa55word99@db/app' }, ['--stdio', '--password', 'hunter2xyz']);
    const preview = await r.service.preview(
      'runtime',
      await request(alice, mcpV(2, { ACME_TOKEN: '${secret:ACME_TOKEN}' }), runtimeTarget(), { replaceEdited: true }),
    );
    should(wire(preview)).not.match(/hunter2xyz|pa55word99/u);
  });

  it('should hide PASS, DB_PASS and --pass typed into a server, in the whole answer', async () => {
    const r = rig();
    await install(r, mcpV(1, { ACME_TOKEN: '${secret:ACME_TOKEN}' }), runtimeTarget(), { ACME_TOKEN: null });
    // Plain words with dots: none trips mayHoldSecret by its value, so only the NAME (PASS, DB_PASS, --pass) can
    // hide them; and no hex digest or id elsewhere in the preview can contain a dot.
    const values = ['plain.word.one', 'plain.word.two', 'plain.word.three'] as const;
    for (const value of values) should(mayHoldSecret(value)).be.false();
    typedInto(r, { PASS: values[0], DB_PASS: values[1] }, ['--stdio', '--pass', values[2]]);
    const preview = await r.service.preview(
      'runtime',
      await request(alice, mcpV(2, { ACME_TOKEN: '${secret:ACME_TOKEN}' }), runtimeTarget(), { replaceEdited: true }),
    );
    const json = wire(preview);
    for (const value of values) should(json.includes(value)).be.false();
  });

  it('should hide a server argument whose name has a line break inside it, in the whole answer', async () => {
    const r = rig();
    await install(r, mcpV(1, { ACME_TOKEN: '${secret:ACME_TOKEN}' }), runtimeTarget(), { ACME_TOKEN: null });
    typedInto(r, {}, ['--stdio', '--pa\nssword', 'hunter2']);
    const preview = await r.service.preview(
      'runtime',
      await request(alice, mcpV(2, { ACME_TOKEN: '${secret:ACME_TOKEN}' }), runtimeTarget(), { replaceEdited: true }),
    );
    should(wire(preview)).not.match(/hunter2/u);
    should(hiddenEntry(preview)?.label).equal('Starts');
  });

  it.each([
    ['a trailing space', `notes\ngh \np_abcdefghijklmnopqrstuvwxyz0123456789\n`],
    ['carriage returns only', 'notes\rgh\rp_abcdefghijklmnopqrstuvwxyz0123456789\r'],
    ['a path before the break', `see path/gh\np_abcdefghijklmnopqrstuvwxyz0123456789\n`],
    ['an indented continuation', `notes\n    gh\n    p_abcdefghijklmnopqrstuvwxyz0123456789\n`],
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
    ['a base64 password on the next line', 'password:\n  c2VjcmV0cGFzc3dvcmQ=\n'],
    ['a base64 token with two paddings', 'api_token:\n  aHVudGVyMmh1bnRlcjI==\n'],
    ['a separator that starts the next line', 'PASSWORD\n= hunter2hunter2xyz\n'],
    ['a separator after a carriage return', 'TOKEN\r:hunter2hunter2xyz\r'],
    ['a name after a slash', 'see /PASSWORD:\nhunter2hunter2xyz\n'],
    ['a name after a dollar sign', 'export $PASSWORD=\nhunter2hunter2xyz\n'],
    ['a name after a bar', '|api_key:\nhunter2hunter2xyz\n'],
    ['a token that starts with the separator of the line before', `${TOKEN}\n=${TOKEN}\n`],
    ['a token glued after a query value', 'x &Q=sk-abcdefghijklmnopqrst<&ghp_zyxwvutsrqponmlkjihg\n'],
    ['a base64 value glued after a query value', '?Q=sk-abcdefghijklmnopqrst<&c2VjcmV0cGFzc3dvcmQ=\n'],
    ['a short value glued after a token', ';Q=ghp_abcdefghijklmnopqrst>&tok3nvalue99\n'],
    ['a short token and a value on the next line', 'Y=\nghp_aaaa{tok3nvalue99\n'],
    ['a short token and a base64 value after a carriage return', 'Q=\rsk-qqqq{c2VjcmV0cGFzc3dvcmQ=\r'],
    ['a short token and a value after a colon line', 'z:\nghp_aaaa>tok3nvalue99\n'],
    ['a token glued after a brace, with no name', 'a{sk-abcdefghijklmnopqrst and x<&ghp_zyxwvutsrqponmlkjihg\n'],
    ['a key id glued after a bar', 'k|AKIAIOSFODNN7EXAMPLE|\n'],
    ['a default in an expansion', 'run=${X:-tok3nvalue99}\n'],
    ['an assigned default in an expansion', 'run=${X:=tok3nvalue99}\n'],
    ['an assignment in an expansion', 'run=${X=tok3nvalue99}\n'],
    ['an alternative in an expansion', 'run=${X:+tok3nvalue99}\n'],
    ['user info with no name', 'git clone https://bob:tok3nvalue99@example.com/r.git\n'],
    ['a soft hyphen inside a name', `pa${SOFT_HYPHEN}ss: hunter2\n`],
    ['a zero-width space inside a name', `to${ZERO_WIDTH_SPACE}ken=hunter2\n`],
    ['a soft hyphen inside a nameless base64 word', `value: c2VjcmV0cGFz${SOFT_HYPHEN}c3dvcmQxMjM0NTY3OA\n`],
    // Deliberately all hex: it tests the nameless hex-word heuristic (a digest could hold it only at odds of about 2^-72).
    ['a zero-width space inside a nameless hex word', `0123456789abcdef01${ZERO_WIDTH_SPACE}23456789abcdef0123\n`],
    ['a lone carriage return inside a name', 'pa\rss: hunter2\n'],
    ['a lone carriage return inside a name, then more text', 'x\npa\rss: hunter2\nmore\n'],
    ['a user and password after curl -u', 'curl -u bob:hunter2 https://example.com/\n'],
    ['a password attached to mysql -p', 'mysql -phunter2 -h db\n'],
    ['a password after redis-cli -a', 'redis-cli -a hunter2\n'],
    ['a private key block', '-----BEGIN OPENSSH PRIVATE KEY-----\ntok3nvalue99\n'],
  ])('should hide a file with %s, in the whole answer', async (_label, text) => {
    const preview = await skillPreview(text);
    should(wire(preview)).not.match(
      /p_abcdefghijkl|abcdefghijklmnopqrst|hunter2|ghp_abcdefgh|c2VjcmV0|aHVudGVy|zyxwvutsrqpon|tok3nvalue99|ghp_aaaa|sk-qqqq|AKIAIOSF|0123456789abcdef01/u,
    );
    should(hiddenEntry(preview)?.label).equal('Skill file SKILL.md');
  });

  it('should hide a file the offered side makes secret-looking, with the same rule', async () => {
    const preview = await skillPreview('# one\nplain\n', `# two\nAPI_TOKEN=${TOKEN}\n`);
    should(hiddenEntry(preview)).be.ok();
    should(wire(preview.changes)).not.match(/ghp_abcdefgh/u);
  });

  it.each([
    ['a 2 MiB single line', 'a'.repeat(2 * 1024 * 1024)],
    ['2 MiB of short lines', 'ab\n'.repeat((2 * 1024 * 1024) / 3)],
    [
      '2 MiB of nested block openers',
      Array.from({ length: (2 * 1024 * 1024) / 16 }, (_, depth) => `${' '.repeat(depth % 8)}pw: |`).join('\n'),
    ],
    ['2 MiB of repeated token prefixes', 'sk-'.repeat((2 * 1024 * 1024) / 3)],
  ])('should answer %s on disk in bounded time, with no text drawn', async (_label, text) => {
    const started = performance.now();
    const preview = await skillPreview(text);
    should(performance.now() - started).be.below(15_000);
    should(wire(preview.changes)).not.match(/pw: \||sk-sk-/u);
  });
});
