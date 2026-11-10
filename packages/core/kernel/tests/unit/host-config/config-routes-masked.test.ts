/**
 * CFG-LEAK-R / CFG-LEAK-W at the two routes: `GET /v1/config/file` shows the MASKED text to every caller that may read
 * it (S6: no route returns a secret value), and `PUT /v1/config/file` refuses a text that writes the mask back, or a
 * raw secret given to a flag. The pure mask is `shown-text.test.ts`; the host with a real Gate stand-in and a ferret's
 * door is `config-masked-host.test.ts`.
 *
 * Fake only: every value is shaped like a credential and is none.
 */
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import type { Admission, ConfigAccessJudgement, ConfigAccessVerdict } from '../../../contract/bound.ts';
import { type ApiRequest, headersFrom, queryFrom } from '../../../contract/http.ts';
import type { CallStanding } from '../../../contract/route.ts';
import { runInCall } from '../../../host/call-scope.ts';
import { configRoutes } from '../../../host/config/routes.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { localArrival } from '../../../host/listener.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { captureLog, HOME, manualClock } from './support.ts';
import { HIDDEN, mcpDef, OTHER_VALUE, VALUE } from './masked-support.ts';

const FILE = `${HOME}/config/mcp/srv.yaml`;
const PATH = 'mcp/srv.yaml';
/** Fake only: shaped like a provider key, never one. */
const FAKE_KEY = `sk-ant-api03-${'A'.repeat(90)}`;

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function world(answer: (input: ConfigAccessJudgement) => ConfigAccessVerdict = () => ({ allowed: true })) {
  const fs = createMemoryHostFs();
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [{ plugin: 'mcp', def: mcpDef }],
  });
  const asked: ConfigAccessJudgement[] = [];
  const gate = {
    judgeConfigAccess: (input: ConfigAccessJudgement) => {
      asked.push(input);
      return answer(input);
    },
  } as unknown as Admission;
  const handlers = configRoutes({ writer: () => files.writer(), admission: () => gate, home: HOME, binary: 'fy' });
  return { fs, files, asked, handlers, disk: () => fs.snapshot().get(FILE) };
}

const request = (method: string, query: readonly [string, string][] = [], body?: unknown): ApiRequest => ({
  method,
  path: '/v1/config/file',
  query: queryFrom(query),
  headers: headersFrom({}),
  arrival: localArrival(true),
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});
const call = (r: ApiRequest) => ({ request: r, params: new Map<string, string>() }) as never;
const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

type Handlers = ReturnType<typeof world>['handlers'];
const get = (handlers: Handlers) => handlers['GET /v1/config/file'](call(request('GET', [['path', PATH]])));
const put = (handlers: Handlers, text: string, etag?: string) =>
  handlers['PUT /v1/config/file'](
    call(request('PUT', [], { path: PATH, text, ...(etag === undefined ? {} : { etag }) })),
  );

interface Issue {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly severity: string;
  readonly message: string;
  readonly fix: string;
}
const issuesOf = (response: { body: string }): Issue[] => json(response).issues as Issue[];

const SECRET_FILE = `command: srv\nargs:\n  - --token\n  - ${VALUE}\n`;

describe('GET /v1/config/file shows the masked text to every caller', () => {
  test('S6 CFG-LEAK-R R-0072 GET hides the value after --token in mcp args for a ferret, a limited device AND the host admin; the flag stays', async () => {
    const w = world();
    w.fs.seed(FILE, SECRET_FILE);
    await w.files.reload();
    // Three callers Gate lets read: a ferret's own token, a `--limited` device (fleet.use only), the host admin.
    const callers = {
      ferret: { actor: 'ferret', standing: { credential: { tokenClass: 'ferret', ferret: 'wren' } } },
      limited: { actor: 'owner-tools', standing: { governance: { governed: true }, grants: { fleet: { use: true } } } },
      hostAdmin: {
        actor: 'owner-tools',
        standing: { governance: { governed: false }, credential: { tokenClass: 'admin' } },
      },
    } as const;
    for (const [who, scope] of Object.entries(callers)) {
      const response = await runInCall(
        { actor: scope.actor, standing: scope.standing as unknown as CallStanding },
        async () => await get(w.handlers),
      );
      const body = json(response);
      expect([who, response.status]).toEqual([who, 200]);
      expect([who, response.body.includes(VALUE)]).toEqual([who, false]);
      expect([who, body.text]).toEqual([who, `command: srv\nargs:\n  - --token\n  - ${HIDDEN}\n`]);
    }
    // Gate was asked three times, each for `read`, and answered yes each time: the mask is the kernel's, not Gate's.
    expect(w.asked.map(input => input.act)).toEqual(['read', 'read', 'read']);
  });

  test('R-0072 CFG-LEAK-R the etag stays the digest of the disk text, so an editor’s If-Match keeps working', async () => {
    const w = world();
    w.fs.seed(FILE, SECRET_FILE);
    await w.files.reload();
    const body = json(await get(w.handlers));
    expect(body.etag).toBe(digest(SECRET_FILE));
    expect(body.state).toBe('ok');
    expect(body.exists).toBe(true);
  });

  test('CFG-LEAK-R the route says where each value is hidden: one warning per cut, with the fix, never the value', async () => {
    const w = world();
    w.fs.seed(FILE, `args:\n  - --token\n  - ${VALUE}\n  - --api-key=${OTHER_VALUE}\n`);
    await w.files.reload();
    const response = await get(w.handlers);
    expect(issuesOf(response)).toEqual([
      {
        path: PATH,
        line: 3,
        column: 1,
        severity: 'warning',
        message: `a value on this line is hidden from every device and agent (${HIDDEN}); it is kept as it is unless you change it here`,
        fix: `fy secret set NAME, then write \${secret:NAME} in its place — or edit the file at the machine`,
      },
      {
        path: PATH,
        line: 4,
        column: 1,
        severity: 'warning',
        message: `a value on this line is hidden from every device and agent (${HIDDEN}); it is kept as it is unless you change it here`,
        fix: `fy secret set NAME, then write \${secret:NAME} in its place — or edit the file at the machine`,
      },
    ]);
    expect(response.body).not.toContain(VALUE);
    expect(response.body).not.toContain(OTHER_VALUE);
  });

  test('CFG-LEAK-R the warnings are capped, and one sentence counts the rest', async () => {
    const w = world();
    const items = Array.from(
      { length: 60 },
      (_, index) => `  - --token\n  - Qv${String(index).padStart(3, '0')}xLmN7rT\n`,
    );
    w.fs.seed(FILE, `args:\n${items.join('')}`);
    await w.files.reload();
    const issues = issuesOf(await get(w.handlers));
    expect(issues).toHaveLength(51);
    expect(issues.slice(0, 50).every(issue => issue.severity === 'warning')).toBe(true);
    expect(issues[50]).toMatchObject({ path: PATH, message: 'and 10 more problems not listed here' });
  });

  test('R-0072 a file with nothing to hide reads byte-identical, same etag, no extra issues', async () => {
    const w = world();
    const text = '# mine\nargs: [ --verbose,   --port ]\ncommand: srv\n';
    w.fs.seed(FILE, text);
    await w.files.reload();
    const body = json(await get(w.handlers));
    expect(body.text).toBe(text);
    expect(body.etag).toBe(digest(text));
    expect(body.issues).toEqual([]);
  });

  test('R-0072 a file that is not there yet still begins as its schema’s modeline', async () => {
    const w = world();
    await w.files.reload();
    const body = json(await get(w.handlers));
    expect(body).toMatchObject({ exists: false, etag: 'absent' });
    expect(String(body.text)).toStartWith('# yaml-language-server: $schema=');
  });

  test('S6 R-0072 a withheld file answers a comment line + error issue, never ""', async () => {
    const w = world();
    w.fs.seed(FILE, `note: ${FAKE_KEY}\n`);
    await w.files.reload();
    const response = await get(w.handlers);
    const body = json(response);
    expect(body.text).toBe(
      `# ${HIDDEN}: the text of this file is not shown because it holds a raw secret, which the owner must move into the secret store; edit it at the machine\n`,
    );
    expect(body.text).not.toBe('');
    expect(response.body).not.toContain(FAKE_KEY);
    expect(body.state).toBe('invalid');
    expect(body.etag).toBe(digest(`note: ${FAKE_KEY}\n`));
    const issues = issuesOf(response);
    expect(issues.at(-1)).toEqual({
      path: PATH,
      severity: 'error',
      message:
        'the text of this file is not shown because it holds a raw secret, which the owner must move into the secret store',
      fix: 'edit the file at the machine',
    });
  });

  test('CFG-LEAK-R a withheld file says why in plain words: a value the mask cannot prove hidden', async () => {
    const w = world();
    w.fs.seed(FILE, `note: &n ${VALUE}\nargs:\n  - --token\n  - *n\n`);
    await w.files.reload();
    const response = await get(w.handlers);
    const body = json(response);
    expect(body.text).toBe(
      `# ${HIDDEN}: the text of this file is not shown because a value in it could not be hidden safely; edit it at the machine\n`,
    );
    expect(issuesOf(response).at(-1)).toEqual({
      path: PATH,
      severity: 'error',
      message: 'the text of this file is not shown because a value in it could not be hidden safely',
      fix: 'edit the file at the machine',
    });
    expect(response.body).not.toContain(VALUE);
  });
});

describe('a withheld file that does not parse says the cause and the remedy', () => {
  test('S6 CFG-LEAK-R a withheld file that does not parse names the cause (it does not parse, so values cannot be told apart) and the remedy (fix the YAML at the machine); comment line + reason, never ""', async () => {
    const w = world();
    w.fs.seed(FILE, `args: [--token, ${VALUE}]\nnote: a\nnote: b\n`);
    await w.files.reload();
    const response = await get(w.handlers);
    const body = json(response);
    expect(body.text).not.toBe('');
    expect(String(body.text)).toStartWith(`# ${HIDDEN}: `);
    const sentence = String(issuesOf(response).at(-1)?.message);
    expect(sentence).toContain('does not parse');
    expect(sentence).toContain('cannot tell which values to hide');
    expect(sentence).toContain('fix the YAML on disk, at the machine');
    expect(sentence).not.toContain('unmaskable');
    expect(String(body.text)).toContain('does not parse');
    expect(String(body.text)).toContain('fix the YAML on disk, at the machine');
    expect(response.body).not.toContain(VALUE);
  });
});

describe('PUT /v1/config/file refuses what would write the mask, or a raw secret, into a file', () => {
  test('S6 CFG-LEAK-W R-0419 PUT of a masked text with one more ‹hidden› than disk is 422 config_invalid; disk untouched', async () => {
    const w = world();
    w.fs.seed(FILE, SECRET_FILE);
    await w.files.reload();
    const read = json(await get(w.handlers));
    const response = await put(w.handlers, String(read.text), String(read.etag));
    expect(response.status).toBe(422);
    expect(json(response).code).toBe('config_invalid');
    expect(issuesOf(response)).toEqual([
      {
        path: PATH,
        line: 4,
        column: 1,
        severity: 'error',
        message: `a value hidden from the device or agent that read this file is still ${HIDDEN} here; nothing was written`,
        fix: `type the real value at the machine, or replace ${HIDDEN} with \${secret:NAME}`,
      },
    ]);
    expect(response.body).not.toContain(VALUE);
    expect(w.disk()).toBe(SECRET_FILE);
  });

  test('CFG-LEAK-W a text that replaces the mask with a real reference is written', async () => {
    const w = world();
    w.fs.seed(FILE, SECRET_FILE);
    await w.files.reload();
    const read = json(await get(w.handlers));
    const fixed = String(read.text).replace(HIDDEN, '${secret:SRV_TOKEN}');
    const response = await put(w.handlers, fixed, String(read.etag));
    expect(response.status).toBe(200);
    expect(w.disk()).toBe('command: srv\nargs:\n  - --token\n  - ${secret:SRV_TOKEN}\n');
  });

  test('CFG-LEAK-W a file that already holds ‹hidden› in a comment stays writable', async () => {
    const w = world();
    const start = `# it said ${HIDDEN} once\ncommand: srv\nlimit: 5\n`;
    w.fs.seed(FILE, start);
    await w.files.reload();
    const read = json(await get(w.handlers));
    expect(read.text).toBe(start);
    // The comment stays: the count is not more than the disk's, so a tightening goes through.
    const kept = await put(w.handlers, `# it said ${HIDDEN} once\ncommand: srv\nlimit: 3\n`, String(read.etag));
    expect(kept.status).toBe(200);
    expect(w.disk()).toBe(`# it said ${HIDDEN} once\ncommand: srv\nlimit: 3\n`);
    // A SECOND one is more than the disk holds, and is refused.
    const again = json(await get(w.handlers));
    const more = await put(
      w.handlers,
      `# it said ${HIDDEN} once ${HIDDEN}\ncommand: srv\nlimit: 2\n`,
      String(again.etag),
    );
    expect(more.status).toBe(422);
    expect(w.disk()).toBe(`# it said ${HIDDEN} once\ncommand: srv\nlimit: 3\n`);
  });

  test('S6 CFG-LEAK-W R-0419 a ‹hidden› in a comment on disk does not let the mask be written over a value: 422 config_invalid; disk untouched', async () => {
    const w = world();
    const start = `# keep ${HIDDEN} here\nargs: [--token, ${VALUE}]\n`;
    w.fs.seed(FILE, start);
    await w.files.reload();
    const read = json(await get(w.handlers));
    expect(String(read.text)).not.toContain(VALUE);
    // The reader deletes the comment and saves: one mark, as many as the disk holds, yet it sits where a value was.
    const response = await put(w.handlers, `args: [--token, ${HIDDEN}]\n`, String(read.etag));
    expect(response.status).toBe(422);
    expect(json(response).code).toBe('config_invalid');
    expect(response.body).not.toContain(VALUE);
    expect(w.disk()).toBe(start);
  });

  test('S6 CFG-LEAK-W R-0419 a new --token <v> / --password=<v> / -e API_KEY=<v> is refused raw_secret; the issue never repeats the value', async () => {
    const w = world();
    await w.files.reload();
    const cases = [
      `args:\n  - --token\n  - ${VALUE}\n`,
      `args:\n  - --password=${VALUE}\n`,
      `args:\n  - -e\n  - API_KEY=${VALUE}\n`,
    ];
    for (const text of cases) {
      const response = await put(w.handlers, text, 'absent');
      expect([text, response.status]).toEqual([text, 422]);
      expect(response.body).not.toContain(VALUE);
      const [issue] = issuesOf(response);
      expect(issue?.message).toEndWith('this looks like a raw secret given to a flag (an API key, token or password)');
      expect(issue?.fix).toContain('fy secret set NAME');
      expect(w.disk()).toBeUndefined();
    }
  });
});
