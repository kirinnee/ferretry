#!/usr/bin/env bun
/**
 * Record the real transcripts the cross-harness converter is tested on.
 *
 * Drives a real `claude` and a real `codex` through a short scripted conversation — a shell command,
 * a non-shell tool, an image, a subagent (Claude), reasoning, and a compaction (Claude) — against a
 * scripted model on 127.0.0.1, each in a throwaway home. Nothing reaches the network and no login is
 * read: the model is this script, and every proxy variable points at a closed port.
 *
 * The transcripts are written to `packages/daemon/tests/fixtures/transcript/convert/` with the
 * throwaway paths replaced by placeholders (`@@CWD@@`, `@@HOME@@`) so they are stable to commit.
 *
 *   bun scripts/local/record-conversion-fixtures.ts [--claude <path>] [--codex <path>]
 *
 * Run it once per harness version the converter is gated to, then add the version to the round-trip
 * and acceptance suites (see docs/migration-cross-harness.md › "Adding a harness version").
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

const OUTPUT = resolve(import.meta.dir, '../../packages/daemon/tests/fixtures/transcript/convert');
const CLOSED_PROXY = 'http://127.0.0.1:9';
/** A 1×1 PNG, the smallest image both CLIs accept as an attachment. */
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const flag = (name: string): string | undefined => {
  const at = Bun.argv.indexOf(name);
  return at > 0 ? Bun.argv[at + 1] : undefined;
};

type Body = Record<string, unknown>;
const sse = (events: readonly (readonly [string, unknown])[]): Response =>
  new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

/** The last turn of a request as text, and whether it is a tool result coming back. */
function lastTurn(body: Body): { readonly text: string; readonly toolReturn: boolean } {
  const turns = (Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : []) as Body[];
  const last = turns.at(-1) ?? {};
  const text = JSON.stringify(last);
  const toolReturn = text.includes('"tool_result"') || String(last.type ?? '').endsWith('_output');
  return { text, toolReturn };
}

let serial = 0;

/** Anthropic Messages: a scripted reply chosen by the keyword in the newest user turn. */
function anthropic(body: Body): Response {
  serial += 1;
  const { text, toolReturn } = lastTurn(body);
  const blocks: Body[] = [];
  let stop = 'end_turn';
  const tool = (name: string, input: Body): void => {
    blocks.push({ type: 'text', text: `Using ${name}.` });
    blocks.push({ type: 'tool_use', id: `toolu_fixture_${serial}`, name, input });
    stop = 'tool_use';
  };
  if (toolReturn) blocks.push({ type: 'text', text: `Done after the tool (reply ${serial}).` });
  else if (text.includes('SUBTASK')) blocks.push({ type: 'text', text: 'Subagent finished its look-around.' });
  else if (text.includes('RUNTOOL')) tool('Bash', { command: 'echo fixture-output', description: 'Echo a marker' });
  else if (text.includes('READFILE')) tool('Read', { file_path: 'notes.txt' });
  else if (text.includes('SUBAGENT'))
    tool('Agent', {
      description: 'Look around',
      prompt: 'SUBTASK: list what is here',
      subagent_type: 'general-purpose',
    });
  else if (text.includes('THINK')) {
    blocks.push({ type: 'thinking', thinking: 'Private reasoning that must not cross.', signature: 'c2lnbmF0dXJl' });
    blocks.push({ type: 'text', text: 'Thought about it.' });
  } else blocks.push({ type: 'text', text: `Plain reply ${serial}.` });
  const events: [string, unknown][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: `msg_fixture_${serial}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
  ];
  blocks.forEach((block, index) => {
    if (block.type === 'tool_use') {
      events.push([
        'content_block_start',
        { type: 'content_block_start', index, content_block: { ...block, input: {} } },
      ]);
      events.push([
        'content_block_delta',
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        },
      ]);
    } else if (block.type === 'thinking') {
      events.push([
        'content_block_start',
        { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
      ]);
      events.push([
        'content_block_delta',
        { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } },
      ]);
      events.push([
        'content_block_delta',
        { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } },
      ]);
    } else {
      events.push([
        'content_block_start',
        { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      ]);
      events.push([
        'content_block_delta',
        { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } },
      ]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 1 } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return sse(events);
}

/** OpenAI Responses: a scripted reply chosen by the keyword in the newest user turn. */
function responses(body: Body): Response {
  serial += 1;
  const { text, toolReturn } = lastTurn(body);
  const id = `resp_fixture_${serial}`;
  const items: Body[] = [];
  const message = (said: string): void => {
    items.push({
      type: 'message',
      role: 'assistant',
      id: `msg_${id}_${items.length}`,
      content: [{ type: 'output_text', text: said, annotations: [] }],
    });
  };
  const call = (name: string, args: Body): void => {
    message(`Using ${name}.`);
    items.push({ type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(args) });
  };
  if (toolReturn) message(`Done after the tool (reply ${serial}).`);
  else if (text.includes('RUNTOOL')) call('exec_command', { cmd: 'echo fixture-output' });
  else if (text.includes('PLAN')) call('update_plan', { plan: [{ step: 'Look around', status: 'completed' }] });
  else if (text.includes('THINK')) {
    items.push({
      type: 'reasoning',
      id: `rs_${id}`,
      summary: [{ type: 'summary_text', text: 'Private reasoning.' }],
      encrypted_content: 'ZW5jcnlwdGVk',
    });
    message('Thought about it.');
  } else message(`Plain reply ${serial}.`);
  const events: [string, unknown][] = [['response.created', { type: 'response.created', response: { id } }]];
  items.forEach((item, index) => {
    events.push(['response.output_item.added', { type: 'response.output_item.added', output_index: index, item }]);
    events.push(['response.output_item.done', { type: 'response.output_item.done', output_index: index, item }]);
  });
  events.push([
    'response.completed',
    {
      type: 'response.completed',
      response: {
        id,
        output: items,
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 2,
        },
      },
    },
  ]);
  return sse(events);
}

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = (await request.json().catch(() => ({}))) as Body;
    if (path.endsWith('/messages')) return anthropic(body);
    if (path.endsWith('/responses')) return responses(body);
    return Response.json({ data: [], models: [] });
  },
});
const base = `http://127.0.0.1:${server.port}`;

const proxies = Object.fromEntries(
  ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].map(name => [
    name,
    CLOSED_PROXY,
  ]),
);

async function run(cmd: readonly string[], cwd: string, env: Record<string, string>, stdin?: string): Promise<void> {
  const child = Bun.spawn({
    cmd: [...cmd],
    cwd,
    env: { ...proxies, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', ...env },
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const code = await child.exited;
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(' ')} exited ${code}: ${out.slice(-400)} ${err.slice(-400)}`);
}

async function newest(folder: string): Promise<string> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.jsonl') && !path.includes('/subagents/')) files.push(path);
    }
  };
  await walk(folder);
  const stats = await Promise.all(files.map(async file => ({ file, at: (await Bun.file(file).stat()).mtimeMs })));
  const found = stats.toSorted((left, right) => right.at - left.at)[0];
  if (found === undefined) throw new Error(`no transcript under ${folder}`);
  return found.file;
}

const version = async (bin: string): Promise<string> => {
  const child = Bun.spawn({
    cmd: [bin, '--version'],
    stdout: 'pipe',
    stderr: 'ignore',
    env: { PATH: Bun.env.PATH ?? '' },
  });
  return (/\d+\.\d+\.\d+/u.exec(await new Response(child.stdout).text()) ?? ['unknown'])[0];
};

async function recordClaude(bin: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'fy-fixture-claude-'));
  try {
    const home = join(root, 'config');
    const work = join(root, 'work');
    await mkdir(home, { recursive: true });
    await mkdir(work, { recursive: true });
    await writeFile(join(work, 'notes.txt'), 'fixture notes\n');
    const env = {
      HOME: root,
      PATH: [dirname(bin), Bun.env.PATH ?? ''].join(delimiter),
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_API_KEY: 'fixture-not-a-key',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    const id = crypto.randomUUID();
    const common = ['--permission-mode', 'bypassPermissions', '--model', 'claude-sonnet-4-5'];
    await run([bin, '-p', '--session-id', id, ...common, 'RUNTOOL show me a marker'], work, env);
    await run([bin, '-p', '--resume', id, ...common, 'READFILE what is in notes.txt?'], work, env);
    await run([bin, '-p', '--resume', id, ...common, 'SUBAGENT take a look around'], work, env);
    const image = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'IMAGE what is in this picture?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXEL_PNG } },
        ],
      },
    });
    await run(
      [
        bin,
        '-p',
        '--resume',
        id,
        ...common,
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
      ],
      work,
      env,
      `${image}\n`,
    );
    await run([bin, '-p', '--resume', id, ...common, 'THINK about what we found'], work, env);
    await run([bin, '-p', '--resume', id, ...common, '/compact'], work, env);
    await run([bin, '-p', '--resume', id, ...common, 'After the compaction, anything else?'], work, env);
    await save('claude', await version(bin), await newest(join(home, 'projects')), { work, home: root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function recordCodex(bin: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'fy-fixture-codex-'));
  try {
    const home = join(root, 'codex');
    const work = join(root, 'work');
    await mkdir(home, { recursive: true });
    await mkdir(work, { recursive: true });
    await writeFile(join(work, 'pixel.png'), Buffer.from(PIXEL_PNG, 'base64'));
    await writeFile(
      join(home, 'config.toml'),
      [
        'model_provider = "fixture"',
        'model = "gpt-5.5"',
        '[model_providers.fixture]',
        'name = "Fixture"',
        `base_url = "${base}/v1"`,
        'env_key = "FIXTURE_KEY"',
        'wire_api = "responses"',
        '',
      ].join('\n'),
    );
    const env = {
      HOME: root,
      PATH: [dirname(bin), Bun.env.PATH ?? ''].join(delimiter),
      CODEX_HOME: home,
      FIXTURE_KEY: 'x',
    };
    const exec = [bin, 'exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
    await run([...exec, 'RUNTOOL show me a marker'], work, env);
    const file = await newest(join(home, 'sessions'));
    const thread = (/([0-9a-f-]{36})\.jsonl$/u.exec(file) ?? [])[1] as string;
    await run([...exec, 'resume', thread, 'PLAN make a plan'], work, env);
    await run([...exec, 'resume', thread, '-i', join(work, 'pixel.png'), 'IMAGE what is in this picture?'], work, env);
    await run([...exec, 'resume', thread, 'THINK about what we found'], work, env);
    await save('codex', await version(bin), file, { work, home: root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A string over this length inside a Claude bookkeeping record is trimmed: they carry whole system prompts. */
const BOOKKEEPING_STRING_MAX = 160;
/** The records a conversion reads, which are kept byte for byte. */
const CONVERSATION_RECORDS = new Set(['user', 'assistant', 'system']);

/** Long strings inside a value shortened, keeping every key and the record's shape. */
function trimmed(value: unknown): unknown {
  if (typeof value === 'string')
    return value.length > BOOKKEEPING_STRING_MAX ? `${value.slice(0, 80)}…[trimmed by the fixture recorder]` : value;
  if (Array.isArray(value)) return value.map(trimmed);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trimmed(item)]));
  return value;
}

/**
 * Claude's bookkeeping records (`attachment`, `api-request-shape`, …) hold its whole system prompt
 * and tool listings — hundreds of KB per fixture. The converter only has to recognise and drop them,
 * so their long strings are trimmed; the conversation's own records are kept byte for byte.
 */
function compact(text: string): string {
  return text
    .split('\n')
    .map(line => {
      try {
        const record = JSON.parse(line) as { readonly type?: unknown };
        return CONVERSATION_RECORDS.has(String(record.type)) ? line : JSON.stringify(trimmed(record));
      } catch {
        return line;
      }
    })
    .join('\n');
}

async function save(harness: string, at: string, file: string, paths: { work: string; home: string }): Promise<void> {
  const raw = (await Bun.file(file).text()).replaceAll(paths.work, '@@CWD@@').replaceAll(paths.home, '@@HOME@@');
  const text = harness === 'claude' ? compact(raw) : raw;
  await mkdir(OUTPUT, { recursive: true });
  const out = join(OUTPUT, `${harness}-${at}.jsonl`);
  await writeFile(out, text);
  console.log(`wrote ${out}`);
}

try {
  const claude = flag('--claude');
  const codex = flag('--codex');
  if (claude === undefined && codex === undefined) throw new Error('pass --claude <path> and/or --codex <path>');
  if (claude !== undefined) await recordClaude(claude);
  if (codex !== undefined) await recordCodex(codex);
} finally {
  await server.stop(true);
}
