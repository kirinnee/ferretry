/** Opt-in real Codex proof. All conversation words and model responses are synthetic; the only server is loopback. */
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cutRollout, rolloutName } from '../../daemon/lib/fork.ts';

const binary = process.env.CODEX_FORK_BINARY;

test.skipIf(binary === undefined)(
  'a real writer makes two turns, the fork resumes only turn 1 under its new identity and folder',
  async () => {
    if (binary === undefined) throw new Error('CODEX_FORK_BINARY must name the real program to test');
    const home = await mkdtemp(join(tmpdir(), 'codex-fork-loopback-'));
    const work = join(home, 'source');
    const forkWork = join(home, 'fork');
    const nativeHome = join(home, '.codex');
    await mkdir(work);
    await mkdir(forkWork);
    await mkdir(nativeHome);
    const requests: Record<string, unknown>[] = [];
    const message = {
      type: 'message',
      id: 'msg_synthetic',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Synthetic loopback answer.', annotations: [] }],
    };
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 7496,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe('/v1/responses');
        requests.push((await request.json()) as Record<string, unknown>);
        const response = {
          id: 'resp_synthetic',
          object: 'response',
          created_at: 1,
          model: 'synthetic',
          status: 'completed',
          output: [message],
          usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
        };
        const events = [
          { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
          {
            type: 'response.output_text.delta',
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            delta: 'Synthetic loopback answer.',
          },
          { type: 'response.output_item.done', output_index: 0, item: message },
          { type: 'response.completed', response },
        ];
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    // This is a synthetic harness config, never a real user's config or credentials.
    await writeFile(
      join(nativeHome, 'config.toml'),
      `model = "synthetic"
model_provider = "loopback"
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.loopback]
name = "Loopback fixture"
base_url = "http://127.0.0.1:7496/v1"
wire_api = "responses"
requires_openai_auth = false
[features]
responses_websockets = false
responses_websockets_v2 = false
`,
    );
    const environment = {
      HOME: home,
      FY_HOME: join(home, 'fy'),
      PATH: process.env.PATH ?? '',
      OTEL_SDK_DISABLED: 'true',
      DO_NOT_TRACK: '1',
      NO_PROXY: '127.0.0.1,localhost',
    };
    const run = async (cwd: string, args: string[]) => {
      const child = Bun.spawn([binary, 'exec', '--skip-git-repo-check', '--json', ...args], {
        cwd,
        env: environment,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timeout = setTimeout(() => child.kill(), 20_000);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ code, stderr: code === 0 ? '' : stderr }).toEqual({ code: 0, stderr: '' });
        return stdout
          .trim()
          .split('\n')
          .map(line => JSON.parse(line) as Record<string, unknown>);
      } finally {
        clearTimeout(timeout);
      }
    };
    const files = async (): Promise<string[]> =>
      (await readdir(join(nativeHome, 'sessions'), { recursive: true }))
        .filter(file => file.endsWith('.jsonl'))
        .map(file => join(nativeHome, 'sessions', file));
    try {
      const first = await run(work, ['SYNTHETIC_FIRST_PROMPT']);
      const sourceId = first.find(event => event.type === 'thread.started')?.thread_id as string;
      expect(sourceId).toMatch(/^[0-9a-f-]{36}$/u);
      await run(work, ['resume', sourceId, 'SYNTHETIC_SECOND_PROMPT']);
      const sourceFile = (await files()).find(file => file.includes(sourceId));
      if (sourceFile === undefined) throw new Error('the real writer made no rollout');
      const source = await readFile(sourceFile, 'utf8');
      const before = await stat(sourceFile);
      const id = crypto.randomUUID();
      // session_id is also a supported self-id location; real readers must never see the source id in it.
      const records = source
        .trimEnd()
        .split('\n')
        .map(line => JSON.parse(line));
      records.find(record => record.type === 'session_meta').payload.session_id = sourceId;
      const cut = cutRollout(
        `${records.map(record => JSON.stringify(record)).join('\n')}\n`,
        { turn: 1 },
        {
          id,
          folder: forkWork,
          marker: join(home, 'codex-correlation/unreachable'),
        },
      );
      expect(cut.kind).toBe('cut');
      if (cut.kind !== 'cut') throw new Error(cut.reason);
      expect(cut.text).not.toContain('SYNTHETIC_SECOND_PROMPT');
      const file = join(nativeHome, rolloutName(id, new Date()));
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, cut.text, { flag: 'wx' });
      const requestAt = requests.length;
      const resumed = await run(forkWork, ['resume', id, 'SYNTHETIC_FORK_CHECK']);
      expect(resumed.find(event => event.type === 'thread.started')?.thread_id).toBe(id);
      const request = JSON.stringify(requests.slice(requestAt));
      expect(request).toContain('SYNTHETIC_FIRST_PROMPT');
      expect(request).toContain('SYNTHETIC_FORK_CHECK');
      expect(request).not.toContain('SYNTHETIC_SECOND_PROMPT');
      const forked = (await readFile(file, 'utf8'))
        .trimEnd()
        .split('\n')
        .map(line => JSON.parse(line));
      for (const record of forked) {
        if (record.type === 'session_meta') expect(record.payload).toMatchObject({ id, session_id: id, cwd: forkWork });
        if (record.type === 'turn_context') {
          expect(record.payload.cwd).toBe(forkWork);
          if (record.payload.workspace_roots !== undefined) expect(record.payload.workspace_roots).toEqual([forkWork]);
        }
      }
      expect(await readFile(sourceFile, 'utf8')).toBe(source);
      expect((await stat(sourceFile)).ino).toBe(before.ino);
    } finally {
      await server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  },
  70_000,
);
