import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

setDefaultTimeout(120_000);

/**
 * THE SESSION FORK OVER A REAL DAEMON (the port of v4's `e2e/session-fork`, which spawned the compiled daemon): a real `fyd` on
 * a port in 7480-7499 over a temp `FY_HOME` and a temp `HOME`, real HTTP admission with the owner's admin token, and the REAL
 * Claude Code harness cutting a SYNTHETIC transcript. No real `~/.claude`, `~/.ferretry` or network is touched, and the
 * `claude` command is a stand-in that only exits (so no real harness is ever launched).
 *
 * What it proves end to end: a selection the daemon never issued is refused stale with nothing cut; a real selection is
 * proved against the conversation as the daemon reads it, the harness writes a NEW conversation holding exactly the source's
 * records under a new id, the source file is byte-identical afterwards, and, because a SIT has no signed-in Claude runtime to
 * start the new ferret on, the person is told so in the launch's own words and that the cut was kept. (The new ferret reading as
 * the source did and its attachments opening are proved in `tests/integration/daemon/fork-route.test.ts`.)
 */

const ROOT = path.resolve(import.meta.dir, '../../../../..');
const STAMP = '2026-11-16T00:00:00.000Z';
const SOURCE_CONVERSATION = '0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21';
const WORKING_CONVERSATION = '5d1c8e2b-3a4f-4b6c-8d7e-9f0a1b2c3d4e';
const spelled = (folder: string) => folder.replaceAll(/[^a-zA-Z0-9]/gu, '-');

let child: ReturnType<typeof Bun.spawn> | undefined;
let root = '';
let home = '';
let project = '';
let url = '';
let admin = '';
let logs = '';

const stamp = (n: number) => `2026-11-01T10:${String(n).padStart(2, '0')}:00.000Z`;
const prompt = (n: number, conversation = SOURCE_CONVERSATION) => ({
  type: 'user',
  uuid: `p${String(n)}`,
  sessionId: conversation,
  timestamp: stamp(n * 2),
  message: { role: 'user', content: `question ${String(n)}` },
});
const answer = (n: number, conversation = SOURCE_CONVERSATION) => ({
  type: 'assistant',
  uuid: `a${String(n)}`,
  sessionId: conversation,
  timestamp: stamp(n * 2 + 1),
  message: { role: 'assistant', content: [{ type: 'text', text: `answer ${String(n)}` }] },
});

const pool = (...parts: string[]) => path.join(home, 'state/claude-code/history-pool', ...parts);
const sourceFile = (conversation = SOURCE_CONVERSATION) => pool('projects', spelled(project), `${conversation}.jsonl`);

const seedFerret = async (id: string, name: string, state: string, conversation: string) => {
  await mkdir(path.join(home, 'state/ferrets', id), { recursive: true });
  await writeFile(
    path.join(home, 'state/ferrets', id, 'ferret.json'),
    JSON.stringify({
      format: 1,
      id,
      name,
      role: 'lead',
      mode: 'interactive',
      harness: 'claude-code',
      runner: 'tmux',
      folder: project,
      state,
      birth: 'person',
      createdAt: STAMP,
      stateAt: STAMP,
    }),
  );
  const agentHome = path.join(home, 'state/claude-code/agent-homes', id);
  await mkdir(agentHome, { recursive: true });
  await writeFile(
    path.join(agentHome, 'conversation.json'),
    JSON.stringify({ format: 1, id: conversation, cwd: project }),
  );
  // A pooled home reads its transcripts through its `projects` link to the shared pool, as a prepared home does.
  await symlink(pool('projects'), path.join(agentHome, 'projects'));
  await mkdir(path.dirname(sourceFile(conversation)), { recursive: true });
  const records = [1, 2, 3].flatMap(n => [prompt(n, conversation), answer(n, conversation)]);
  await writeFile(sourceFile(conversation), `${records.map(r => JSON.stringify(r)).join('\n')}\n`);
};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'fork-sit-'));
  home = path.join(root, 'fy-home');
  project = path.join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(path.join(root, 'user-home'), { recursive: true });
  await mkdir(path.join(home, 'config'), { recursive: true });
  await writeFile(path.join(home, 'home.json'), JSON.stringify({ format: 1, createdBy: 'fork-sit', createdAt: STAMP }));
  await writeFile(path.join(home, 'config/limits.yaml'), 'enabled: false\n');
  // A stopped Claude Code ferret, and one that is working right now, each with a three-turn conversation in the harness's pool.
  await seedFerret('F1', 'fork-source', 'stopped', SOURCE_CONVERSATION);
  await seedFerret('F2', 'fork-working', 'working', WORKING_CONVERSATION);
  for (const folder of [
    '',
    'state',
    'state/claude-code',
    'state/claude-code/agent-homes',
    'state/claude-code/history-pool',
  ])
    await chmod(path.join(home, folder), 0o700);
  // `claude` is a stand-in that exits at once: this journey never launches a real harness.
  const fake = path.join(root, 'claude');
  await writeFile(fake, '#!/bin/sh\nexit 0\n');
  await chmod(fake, 0o755);

  let port: number | undefined;
  for (let candidate = 7480; candidate <= 7499; candidate++) {
    try {
      const probe = Bun.serve({ hostname: '127.0.0.1', port: candidate, fetch: () => new Response('') });
      await probe.stop(true);
      port = candidate;
      break;
    } catch {
      /* another test owns this port */
    }
  }
  if (port === undefined) throw new Error('no test port in 7480-7499 is available');
  url = `http://127.0.0.1:${port}`;
  child = Bun.spawn([process.execPath, path.join(ROOT, 'packages/core/kernel/host/fyd.ts')], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: path.join(root, 'user-home'),
      FY_HOME: home,
      FY_PORT: String(port),
      FY_URL: url,
      FY_CLAUDE_BIN: fake,
      LANG: 'C.UTF-8',
      FY_MODEL_CATALOG: 'off',
      FY_LOCAL_MODELS: 'off',
      FY_RELAY_DIRECTORY_ORIGIN: 'off',
      FY_UPDATE_CHECK: 'off',
      FYD_BACKGROUND_DELAY_SECONDS: '3600',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let ready = false;
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      logs += new TextDecoder().decode(chunk);
      if (/\bfyd \S+ ready \(/u.test(logs)) ready = true;
    }
  };
  void pump(child.stdout as ReadableStream<Uint8Array>);
  void pump(child.stderr as ReadableStream<Uint8Array>);
  const until = Date.now() + 90_000;
  while (!ready && Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`test daemon exited: ${logs.slice(-2000)}`);
    await Bun.sleep(200);
  }
  if (!ready) throw new Error(`test daemon did not become ready: ${logs.slice(-2000)}`);
  admin = (await readFile(path.join(home, 'state/gate/admin-token'), 'utf8')).trim();
}, 180_000);

afterAll(async () => {
  if (child !== undefined) {
    child.kill('SIGTERM');
    await Promise.race([child.exited, Bun.sleep(10_000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
  }
  if (root !== '') await rm(root, { recursive: true, force: true });
});

const call = async (method: string, route: string, body?: unknown) => {
  const response = await fetch(`${url}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${admin}`,
      'content-type': 'application/json',
      'x-fy-request-id': crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) as Record<string, unknown> };
};

const poolFiles = async () =>
  (await readdir(pool('projects'), { recursive: true })).filter(name => name.endsWith('.jsonl')).sort();

describe('session fork over a real daemon (SIT)', () => {
  it('refuses a selection the daemon never issued and cuts nothing, then forks the real one', async () => {
    const attached = await call('POST', '/v1/ferrets/F1/attachments', {
      filename: 'brief.txt',
      mime: 'text/plain',
      base64: Buffer.from('the brief').toString('base64'),
    });
    expect(attached.status, attached.text).toBe(201);
    const page = await call('GET', '/v1/ferrets/F1/messages?tail=1');
    expect(page.status, `${page.text}\n${logs.slice(-1500)}`).toBe(200);
    const messages = page.json().messages as { point: string; role: string; text: string; selectionBinding: string }[];
    expect(messages.map(message => message.text)).toEqual([
      'question 1',
      'answer 1',
      'question 2',
      'answer 2',
      'question 3',
      'answer 3',
    ]);
    const latest = messages.find(message => message.text === 'question 3');
    if (latest === undefined) throw new Error('the fixture has the third question');
    // The chat names a row by the byte its record begins at (the log page's offsets); the picker finds the same message by the
    // byte its point begins at, so a clicked row is forked even when other rows say the same words.
    const log = await call('GET', '/v1/ferrets/F1/log-page');
    expect(log.status, log.text).toBe(200);
    const offsets = log.json().offsets as number[];
    for (const message of messages.filter(each => each.role === 'user'))
      expect(offsets, `the log has a row at ${message.point}`).toContain(Number(message.point.split('.')[0]));
    const before = await readFile(sourceFile());
    const files = await poolFiles();

    const forged = await call('POST', '/v1/ferrets/F1/fork', {
      point: latest.point,
      selectionBinding: `s2.${'A'.repeat(43)}`,
    });
    expect(forged.status, forged.text).toBe(409);
    expect(forged.json().code).toBe('selection_stale');
    expect(await poolFiles()).toEqual(files);

    const forked = await call('POST', '/v1/ferrets/F1/fork', {
      point: latest.point,
      selectionBinding: latest.selectionBinding,
      name: 'other-way',
    });
    // The harness cut a NEW conversation before the launch was tried: the cut is the real harness's.
    const after = await poolFiles();
    expect(after, `${forked.status} ${forked.text}\n${logs.slice(-1500)}`).toHaveLength(files.length + 1);
    const fresh = after.find(name => !files.includes(name)) ?? '';
    const copy = (await readFile(pool('projects', fresh), 'utf8'))
      .split('\n')
      .filter(line => line !== '')
      .map(line => JSON.parse(line) as { uuid: string; sessionId: string });
    expect(copy.map(record => record.uuid)).toEqual(['p1', 'a1', 'p2', 'a2', 'p3', 'a3']);
    expect(copy.every(record => record.sessionId !== SOURCE_CONVERSATION)).toBe(true);
    expect(await readFile(sourceFile())).toEqual(before);
    // A SIT has no signed-in Claude runtime, so Ferrets cannot start the new ferret. The person is told so in the launch's own
    // words, and that the cut was kept (a failed start never deletes a conversation it cannot prove unwritten).
    expect(forked.status, forked.text).toBe(409);
    expect(forked.json().code).toBe('fork_start_failed');
    expect(String(forked.json().error)).toContain(`The forked conversation ${path.basename(fresh, '.jsonl')} was kept`);
  });

  it('refuses a ferret that is working right now before anything is cut', async () => {
    const page = await call('GET', '/v1/ferrets/F2/messages?tail=1');
    expect(page.status, `${page.text}\n${logs.slice(-1500)}`).toBe(200);
    const messages = page.json().messages as { point: string; text: string; selectionBinding: string }[];
    const latest = messages.find(message => message.text === 'question 3');
    if (latest === undefined) throw new Error('the fixture has the third question');
    const before = await readFile(sourceFile(WORKING_CONVERSATION));
    const files = await poolFiles();

    const forked = await call('POST', '/v1/ferrets/F2/fork', {
      point: latest.point,
      selectionBinding: latest.selectionBinding,
    });

    expect(forked.status, `${forked.text}\n${logs.slice(-1500)}`).toBe(409);
    expect(forked.json().code).toBe('fork_running');
    expect(String(forked.json().error)).toContain('working');
    expect(await poolFiles()).toEqual(files);
    expect(await readFile(sourceFile(WORKING_CONVERSATION))).toEqual(before);
  });
});
