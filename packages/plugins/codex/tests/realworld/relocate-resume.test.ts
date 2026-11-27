/**
 * Opt-in real Codex proof of a move to another machine. Two synthetic machines (two temp Ferretry homes) and a REAL Codex
 * binary (`CODEX_RELOCATE_BINARY`): the binary writes a conversation on machine A, the harness packs it, machine B's
 * harness unpacks it into a new ferret's home, and the binary RESUMES it there. Every word and model answer is synthetic;
 * the only server is a loopback stub on one port of the test range; `CODEX_HOME` is always the synthetic home.
 *
 *   CODEX_RELOCATE_BINARY=/path/to/codex bun test tests/realworld/relocate-resume.test.ts
 */
import { expect, test } from 'bun:test';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FerretId } from '@ferretry/kernel/contract';
import { relocationWorld } from '../support/relocation-world.ts';

const binary = process.env.CODEX_RELOCATE_BINARY;
const PORT = 7491;

test.skipIf(binary === undefined)(
  'a conversation the real writer made on machine A is resumed by the real binary on machine B',
  async () => {
    if (binary === undefined) throw new Error('CODEX_RELOCATE_BINARY must name the real program to test');
    const a = await relocationWorld();
    const b = await relocationWorld();
    const workA = join(a.parent, 'work-a');
    // Machine B's folder is DEEP and reached through a symbolic link: the spelling Codex records must be the one a resume uses.
    const realB = join(b.parent, 'real-b');
    const workB = join(b.parent, 'link-b', 'a', 'b', 'c', 'd', 'e', 'work');
    await mkdir(workA);
    await mkdir(join(realB, 'a', 'b', 'c', 'd', 'e', 'work'), { recursive: true });
    await symlink(realB, join(b.parent, 'link-b'));
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
      port: PORT,
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
    const config = `model = "synthetic"
model_provider = "loopback"
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.loopback]
name = "Loopback fixture"
base_url = "http://127.0.0.1:${PORT}/v1"
wire_api = "responses"
requires_openai_auth = false
[features]
responses_websockets = false
responses_websockets_v2 = false
`;
    /** One `codex exec` in `cwd`, in the ferret's own home (the way a launch gives it), never the person's. */
    const run = async (world: typeof a, ferret: string, cwd: string, args: string[]) => {
      const home = world.agent(ferret);
      const child = Bun.spawn(
        [
          binary,
          'exec',
          '--skip-git-repo-check',
          '--json',
          '--add-dir',
          `${home}/codex-correlation/unreachable`,
          ...args,
        ],
        {
          cwd,
          env: {
            HOME: world.parent,
            CODEX_HOME: home,
            CODEX_SQLITE_HOME: world.pool('sqlite'),
            PATH: process.env.PATH ?? '',
            OTEL_SDK_DISABLED: 'true',
            DO_NOT_TRACK: '1',
            NO_PROXY: '127.0.0.1,localhost',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const timeout = setTimeout(() => child.kill(), 25_000);
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
    try {
      // Machine A: the ferret is launched (home pooled, launch bound), then the real binary writes its conversation.
      const specA = a.specOf('f1', workA);
      expect((await a.harness.start(specA, a.runner, {} as never)).ok).toBe(true);
      await writeFile(join(a.agent('f1'), 'config.toml'), config);
      const first = await run(a, 'f1', workA, ['SYNTHETIC_FIRST_PROMPT']);
      const id = first.find(event => event.type === 'thread.started')?.thread_id as string;
      expect(id).toMatch(/^[0-9a-f-]{36}$/u);
      await run(a, 'f1', workA, ['resume', id, 'SYNTHETIC_SECOND_PROMPT']);

      const packed = await a.harness.packConversation?.('f1' as FerretId);
      if (packed?.ok !== true) throw new Error(JSON.stringify(packed));

      // Machine B: a NEW ferret's home gets the conversation, and the real binary resumes it in the new folder.
      const specB = b.specOf('f2', workB);
      const unpacked = await b.harness.unpackConversation?.(specB, packed.value);
      expect(unpacked).toEqual({ ok: true, value: { conversation: id } });
      expect(await b.harness.hasConversation?.(specB, id)).toBe(true);
      await writeFile(join(b.agent('f2'), 'config.toml'), config);
      const requestAt = requests.length;
      const resumed = await run(b, 'f2', workB, ['resume', id, 'SYNTHETIC_RELOCATED_CHECK']);
      expect(resumed.find(event => event.type === 'thread.started')?.thread_id).toBe(id);

      const sent = JSON.stringify(requests.slice(requestAt));
      expect(sent).toContain('SYNTHETIC_FIRST_PROMPT');
      expect(sent).toContain('SYNTHETIC_SECOND_PROMPT');
      expect(sent).toContain('SYNTHETIC_RELOCATED_CHECK');
      // Nothing of machine A reached the model, and nothing of it is in the file the new ferret now owns.
      expect(sent).not.toContain(workA);
      expect(sent).not.toContain(a.agent('f1'));
      const written = await readFile(join(b.agent('f2'), packed.value.relPath), 'utf8');
      expect(written).not.toContain(workA);
      expect(written).toContain(workB);
      // The new ferret's own proof finds the resumed conversation, and its turns carry the new words after the old ones.
      await b.harness.resume(specB, b.runner, {} as never, id);
      const words = (await b.harness.transcript.read('f2' as FerretId)).map(entry => entry.text ?? '');
      expect(words.join('\n')).toContain('SYNTHETIC_FIRST_PROMPT');
      expect(words.join('\n')).toContain('SYNTHETIC_RELOCATED_CHECK');
      // Machine A's own copy is exactly what it was.
      expect(Buffer.from(packed.value.bytes).equals(await readFile(join(a.agent('f1'), packed.value.relPath)))).toBe(
        true,
      );
    } finally {
      await server.stop(true);
      await a.cleanup();
      await b.cleanup();
    }
  },
  120_000,
);
