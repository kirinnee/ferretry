/**
 * The kernel-owned V rows of docs/design/rebuild-parity.tsv that are `fy config …` verbs, each named by its id. They live
 * in the shell's own tests: a kernel test may not import the shell (context-imports). Every verb runs through `runFy`
 * over the fake world: a compiled-in plugin that declares one configuration file, a fake configuration directory, and a
 * recording transport standing in for the daemon. Every secret-looking value in this file is an obvious fake.
 */
import { describe, expect, it } from 'bun:test';
import { defineConfig } from '@ferretry/kernel/contract';
import { definePlugin } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import type { AcceptedRecord, ConfigDiskFile, ConfigFilesPort } from '../../../src/lib/config/ports.ts';
import { runFy } from '../../../src/lib/run.ts';
import { fakeWorld, registryOf, skeletonEntry } from '../fakes.ts';

const LIMITS = defineConfig({
  file: 'limits.yaml',
  schema: z.strictObject({ cap: z.number().int().min(1).default(1) }),
  axis: 'configure',
  loosens: (before, after) =>
    before !== undefined && after.cap > before.cap ? [`raises the cap to ${after.cap}`] : [],
});
const ITEMS = defineConfig({
  collection: 'items',
  name: /^[a-z][a-z0-9-]*$/u,
  schema: z.strictObject({ label: z.string().default('x') }),
  axis: 'configure',
  loosens: () => [],
});
const manifest = definePlugin({
  id: 'limits',
  title: 'Limits',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  data: { config: [LIMITS, ITEMS] },
});
const registry = registryOf(skeletonEntry(manifest));

const DIRECTORY = '/fake-home/config';
const digest = (text: string): string => `etag-of:${text}`;

function directory(
  files: Record<string, string | 'unreadable'>,
  accepted: Record<string, AcceptedRecord> = {},
): ConfigFilesPort {
  return {
    directory: DIRECTORY,
    list: async (): Promise<readonly ConfigDiskFile[]> =>
      Object.entries(files).map(([path, text]) => ({
        path,
        disk: text === 'unreadable' ? { kind: 'unreadable' } : { kind: 'text', text },
      })),
    accepted: async () => accepted,
    digest,
  };
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly sent: readonly { method: string; path: string; body: unknown }[];
  readonly connects: number;
}

async function run(
  argv: string[],
  options: {
    readonly files?: ConfigFilesPort;
    readonly replies?: readonly { status: number; body: unknown }[];
    readonly stdin?: string;
  } = {},
): Promise<Run> {
  const made = fakeWorld({
    registry,
    ...(options.files === undefined ? {} : { config: options.files }),
    ...(options.stdin === undefined
      ? {}
      : {
          host: {
            ...fakeWorld().world.host,
            readText: async (path: string) => {
              if (path !== '-') throw new Error(`unexpected read of ${path}`);
              return options.stdin as string;
            },
          },
        }),
  });
  made.transport.replies.push(...(options.replies ?? []));
  const code = await runFy(argv, made.world);
  return {
    code,
    out: made.io.stdout(),
    err: made.io.stderr(),
    sent: made.transport.sent.map(request => ({
      method: request.method,
      path: request.path,
      body: request.body as unknown,
    })),
    connects: made.connects.length,
  };
}

const RAW_KEY = 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE';

describe('fy config (check)', () => {
  it('V-0190 a clean directory checks to a summary and exit 0, with no daemon', async () => {
    const result = await run(['config', 'check'], { files: directory({ 'limits.yaml': 'cap: 2\n' }) });
    expect(result.code).toBe(0);
    expect(result.out).toBe('1 file checked: 0 errors, 0 warnings, 0 waiting for confirmation.\n');
    // It read the files itself: the daemon was neither started nor asked.
    expect(result.connects).toBe(0);
    expect(result.sent).toEqual([]);
  });

  it('V-0189 bare fy config is fy config check', async () => {
    const files = directory({ 'limits.yaml': 'cap: 0\n' });
    const bare = await run(['config'], { files });
    const named = await run(['config', 'check'], { files });
    expect(bare.code).toBe(1);
    expect(bare.out).toBe(named.out);
  });

  it('V-0190 a broken file is located by line and column with the fix, and exits non-zero', async () => {
    const result = await run(['config', 'check'], { files: directory({ 'limits.yaml': 'cap: 0\n' }) });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/^limits\.yaml:1:\d+ error: .*cap/mu);
    expect(result.out).toContain('\n  fix: ');
    expect(result.out).toContain('1 file checked: 1 error, 0 warnings, 0 waiting for confirmation.');
  });

  it('V-0190 a raw secret in a file is refused by its location, and the value is never printed', async () => {
    const result = await run(['config', 'check'], {
      files: directory({ 'items/a.yaml': `label: ${RAW_KEY}\n` }),
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('items/a.yaml');
    expect(result.out).toContain('secret:NAME');
    expect(result.out + result.err).not.toContain(RAW_KEY);
  });

  it('V-0190 an edit that loosens waits for confirmation, says which command confirms it, and is not an error', async () => {
    const result = await run(['config', 'check'], {
      files: directory(
        { 'limits.yaml': 'cap: 5\n' },
        { 'limits.yaml': { etag: digest('cap: 2\n'), text: 'cap: 2\n', plugin: 'limits' } },
      ),
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain('limits.yaml waits for your confirmation: raises the cap to 5');
    expect(result.out).toContain('  confirm: fy config confirm limits.yaml');
    expect(result.out).toContain('1 file checked: 0 errors, 0 warnings, 1 waiting for confirmation.');
  });

  it('V-0190 a record accepted for another plugin counts for nothing, as in the daemon', async () => {
    const result = await run(['config', 'check'], {
      files: directory(
        { 'limits.yaml': 'cap: 5\n' },
        { 'limits.yaml': { etag: digest('cap: 5\n'), text: 'cap: 5\n', plugin: 'someone-else' } },
      ),
    });
    expect(result.out).toContain('0 waiting');
  });

  it('V-0190 a file no plugin declares is a warning, and a link or a huge file is an error', async () => {
    const result = await run(['config', 'check'], {
      files: directory({ 'stray.yaml': 'a: 1\n', 'limits.yaml': 'unreadable' }),
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('stray.yaml warning: no plugin declares this file, so nothing reads it');
    expect(result.out).toContain('limits.yaml error: this file is not read: it is a link, or larger than');
  });

  it('V-0190 a file that was in effect and is gone is judged as an edit to the defaults, and a tightening is not held', async () => {
    const result = await run(['config', 'check'], {
      files: directory({}, { 'limits.yaml': { etag: 'e', text: 'cap: 9\n', plugin: 'limits' } }),
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain('0 files checked');
  });

  it('V-0190 --json prints the report as JSON', async () => {
    const result = await run(['config', 'check', '--json'], { files: directory({ 'limits.yaml': 'cap: 2\n' }) });
    expect(JSON.parse(result.out)).toEqual({ files: 1, issues: [], pending: [] });
  });

  it('V-0190 refuses an option it does not have, and a stray word', async () => {
    expect((await run(['config', 'check', '--fix'], { files: directory({}) })).err).toBe(
      "error: unknown option '--fix'\n",
    );
    const extra = await run(['config', 'check', 'limits.yaml'], { files: directory({}) });
    expect(extra.code).toBe(1);
    expect(extra.err).toContain("too many arguments for 'check'");
  });
});

describe('fy config path', () => {
  it('V-0193 prints the configuration directory', async () => {
    const result = await run(['config', 'path'], { files: directory({}) });
    expect(result.out).toBe(`${DIRECTORY}\n`);
    expect(result.connects).toBe(0);
  });

  it('V-0193 prints one file in it, for a file a plugin declares and for an item of a declared folder', async () => {
    expect((await run(['config', 'path', 'limits.yaml'], { files: directory({}) })).out).toBe(
      `${DIRECTORY}/limits.yaml\n`,
    );
    expect((await run(['config', 'path', 'items/one.yaml'], { files: directory({}) })).out).toBe(
      `${DIRECTORY}/items/one.yaml\n`,
    );
  });

  it('V-0193 refuses a file no plugin declares, naming the ones that are', async () => {
    const result = await run(['config', 'path', 'machine.yaml'], { files: directory({}) });
    expect(result.code).toBe(1);
    expect(result.err).toContain('machine.yaml is not a Ferretry configuration file');
    expect(result.err).toContain('items/<name>.yaml, limits.yaml');
  });
});

describe('fy config schema', () => {
  it('V-0194 lists the kinds one to a line', async () => {
    const result = await run(['config', 'schema']);
    expect(result.out).toBe('items--item\nlimits\n');
    expect(result.connects).toBe(0);
  });

  it('V-0194 prints the JSON Schema of one kind, from the schema the daemon checks with', async () => {
    const result = await run(['config', 'schema', 'limits']);
    const schema = JSON.parse(result.out) as { properties: { cap: { type: string } } };
    expect(schema.properties.cap.type).toBe('integer');
    expect(result.code).toBe(0);
    expect((await run(['config', 'schema', 'limits.json'])).out).toBe(result.out);
  });

  it('V-0194 names the kinds there are when asked for one there is not', async () => {
    const result = await run(['config', 'schema', 'nope']);
    expect(result.code).toBe(1);
    expect(result.err).toBe('no kind nope — one of items--item, limits\n');
  });
});

describe('fy config guide', () => {
  it('V-0192 prints the Set up Ferretry skill as a SKILL.md for this binary, with the files these plugins declare', async () => {
    const result = await run(['config', 'guide']);
    expect(result.code).toBe(0);
    expect(result.out.startsWith('---\nname: set-up-ferretry\ndescription: ')).toBe(true);
    expect(result.out).toContain('`fy config check` after every edit');
    expect(result.out).toContain('`fy secret set NAME`');
    expect(result.out).toContain(`\`\${secret:NAME}\``);
    expect(result.out).toContain('waits for the owner');
    expect(result.out).toContain('| `limits.yaml` | Limits | `limits` |');
    expect(result.out).toContain('| `items/<name>.yaml` | Limits | `items--item` |');
    expect(result.connects).toBe(0);
  });
});

const STATUS = {
  directory: DIRECTORY,
  files: [{ path: 'limits.yaml', kind: 'limits', schema: 'limits.json', state: 'ok' }],
  issues: [{ path: 'items/a.yaml', line: 2, column: 3, severity: 'error', message: 'label: wrong', fix: 'fix it' }],
  pending: [{ path: 'limits.yaml', etag: 'e-held', changes: ['raises the cap to 5'] }],
  checkedAt: '2026-11-13T10:00:00.000Z',
};

describe('fy config status', () => {
  it('V-0196 prints what the daemon has in effect, its problems and what waits, asking the daemon', async () => {
    const result = await run(['config', 'status'], { replies: [{ status: 200, body: STATUS }] });
    expect(result.code).toBe(0);
    expect(result.sent.map(request => `${request.method} ${request.path}`)).toEqual(['GET /v1/config/status']);
    expect(result.out).toBe(
      [
        DIRECTORY,
        'items/a.yaml:2:3 error: label: wrong',
        '  fix: fix it',
        'limits.yaml waits for your confirmation: raises the cap to 5',
        '  confirm: fy config confirm limits.yaml',
        '1 file checked: 1 error, 0 warnings, 1 waiting for confirmation.',
        '',
      ].join('\n'),
    );
  });

  it('V-0196 --json prints the payload as JSON', async () => {
    const result = await run(['config', 'status', '--json'], { replies: [{ status: 200, body: STATUS }] });
    expect(JSON.parse(result.out)).toMatchObject({ directory: DIRECTORY, pending: STATUS.pending });
  });
});

const VIEW = {
  path: 'limits.yaml',
  absolutePath: `${DIRECTORY}/limits.yaml`,
  kind: 'limits',
  schema: 'limits.json',
  exists: true,
  text: 'cap: 2\n',
  etag: 'e-1',
  state: 'ok',
  issues: [],
};

describe('fy config show', () => {
  it('V-0195 shows one file as the daemon holds it: where it stands, its etag, its issues and its text', async () => {
    const result = await run(['config', 'show', 'limits.yaml'], { replies: [{ status: 200, body: VIEW }] });
    expect(result.sent).toEqual([{ method: 'GET', path: '/v1/config/file?path=limits.yaml', body: undefined }]);
    expect(result.out).toBe(`${DIRECTORY}/limits.yaml (ok)\netag: e-1\n\ncap: 2\n\n`);
  });

  it('V-0195 says a file that does not exist yet is the starter a new one begins with', async () => {
    const result = await run(['config', 'show', 'limits.yaml'], {
      replies: [{ status: 200, body: { ...VIEW, exists: false, etag: 'absent', text: '# yaml-language-server\n' } }],
    });
    expect(result.out).toContain('(does not exist yet — this is the starter a new one begins with)');
  });

  it('V-0195 --json prints the payload, wherever the switch sits', async () => {
    for (const argv of [
      ['config', 'show', 'limits.yaml', '--json'],
      ['config', 'show', '--json', 'limits.yaml'],
    ]) {
      const result = await run(argv, { replies: [{ status: 200, body: VIEW }] });
      expect(JSON.parse(result.out)).toMatchObject({ path: 'limits.yaml', etag: 'e-1' });
      expect(result.sent[0]?.path).toBe('/v1/config/file?path=limits.yaml');
    }
  });

  it('V-0195 needs the file', async () => {
    const result = await run(['config', 'show']);
    expect(result.code).toBe(1);
    expect(result.err).toBe("error: missing required argument 'file'\n");
    expect(result.sent).toEqual([]);
  });
});

describe('fy config write', () => {
  it('V-0197 sends standard input whole, with the etag it was edited against, and says it is in effect', async () => {
    const text = '# keep this\ncap: 3\n';
    const result = await run(['config', 'write', 'limits.yaml', '--if-match', 'e-1'], {
      stdin: text,
      replies: [{ status: 200, body: { path: 'limits.yaml', etag: 'e-2', outcome: 'applied' } }],
    });
    expect(result.code).toBe(0);
    expect(result.sent).toEqual([
      { method: 'PUT', path: '/v1/config/file', body: { path: 'limits.yaml', text, etag: 'e-1' } },
    ]);
    expect(result.out).toBe('Wrote limits.yaml; it is in effect (etag e-2).\n');
  });

  it('V-0197 says a loosening waits for the owner, and how to confirm it', async () => {
    const result = await run(['config', 'write', 'limits.yaml'], {
      stdin: 'cap: 9\n',
      replies: [
        {
          status: 200,
          body: {
            path: 'limits.yaml',
            etag: 'e-3',
            outcome: 'pending',
            pending: { path: 'limits.yaml', etag: 'e-3', changes: ['raises the cap to 9'] },
          },
        },
      ],
    });
    expect(result.code).toBe(0);
    expect(result.sent[0]?.body).toEqual({ path: 'limits.yaml', text: 'cap: 9\n' });
    expect(result.out).toBe(
      'Wrote limits.yaml; it waits for your confirmation: raises the cap to 9.\n  confirm: fy config confirm limits.yaml\n',
    );
  });

  it('V-0197 prints every located problem, then the sentence, and exits 1 when the file does not check', async () => {
    const result = await run(['config', 'write', 'limits.yaml'], {
      stdin: 'cap: 0\n',
      replies: [
        {
          status: 422,
          body: {
            error: 'the file does not check (1 problem); nothing was written',
            code: 'config_invalid',
            issues: [
              {
                path: 'limits.yaml',
                line: 1,
                column: 6,
                severity: 'error',
                message: 'cap: too small',
                fix: 'raise it',
              },
            ],
          },
        },
      ],
    });
    expect(result.code).toBe(1);
    expect(result.out).toBe('limits.yaml:1:6 error: cap: too small\n  fix: raise it\n');
    expect(result.err).toBe('the file does not check (1 problem); nothing was written\n');
  });

  it('V-0197 says a conflict in the daemon’s own words and exits 1', async () => {
    const result = await run(['config', 'write', 'limits.yaml', '--if-match', 'stale'], {
      stdin: 'cap: 3\n',
      replies: [
        {
          status: 409,
          body: {
            error: 'limits.yaml changed since it was read; read it again and redo the edit',
            code: 'config_conflict',
          },
        },
      ],
    });
    expect(result.code).toBe(1);
    expect(result.err).toBe('limits.yaml changed since it was read; read it again and redo the edit\n');
  });

  it('V-0197 needs the file and a value for --if-match, before reading standard input or asking the daemon', async () => {
    expect((await run(['config', 'write'], { stdin: 'x' })).err).toBe("error: missing required argument 'file'\n");
    const bare = await run(['config', 'write', 'limits.yaml', '--if-match'], { stdin: 'x' });
    expect(bare.code).toBe(1);
    expect(bare.err).toContain("option '--if-match <if-match>' argument missing");
    expect(bare.sent).toEqual([]);
  });
});

describe('fy config confirm', () => {
  it('V-0191 lists what waits, with the command that confirms each', async () => {
    const result = await run(['config', 'confirm'], { replies: [{ status: 200, body: STATUS }] });
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      'limits.yaml waits for your confirmation: raises the cap to 5\n  confirm: fy config confirm limits.yaml\n',
    );
    expect(result.sent).toHaveLength(1);
  });

  it('V-0191 says nothing waits when nothing does', async () => {
    const result = await run(['config', 'confirm'], {
      replies: [{ status: 200, body: { ...STATUS, pending: [] } }],
    });
    expect(result.out).toBe('Nothing is waiting for your confirmation.\n');
  });

  it('V-0191 confirms the held edit by the etag it listed, so an edit nobody saw is never put into effect', async () => {
    const result = await run(['config', 'confirm', 'limits.yaml'], {
      replies: [
        { status: 200, body: STATUS },
        { status: 200, body: { path: 'limits.yaml', confirmed: true } },
      ],
    });
    expect(result.code).toBe(0);
    expect(result.sent[1]).toEqual({
      method: 'POST',
      path: '/v1/config/confirm',
      body: { path: 'limits.yaml', etag: 'e-held' },
    });
    expect(result.out).toBe('Confirmed limits.yaml: raises the cap to 5. It is in effect now.\n');
  });

  it('V-0191 refuses a file with nothing waiting, and an edit that moved again', async () => {
    const none = await run(['config', 'confirm', 'items/a.yaml'], { replies: [{ status: 200, body: STATUS }] });
    expect(none.code).toBe(1);
    expect(none.err).toBe('items/a.yaml has no change waiting for your confirmation\n');
    expect(none.sent).toHaveLength(1);
    const moved = await run(['config', 'confirm', 'limits.yaml'], {
      replies: [
        { status: 200, body: STATUS },
        { status: 200, body: { path: 'limits.yaml', confirmed: false } },
      ],
    });
    expect(moved.code).toBe(1);
    expect(moved.err).toBe('limits.yaml changed again before it could be confirmed; run fy config confirm again\n');
  });
});
