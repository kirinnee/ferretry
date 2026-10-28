import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { Harness } from '@ferretry/protocol';
import type {
  ConversionCheck,
  ConversionCheckPort,
  ConversionPlace,
  HarnessVersionPort,
} from '../../lib/migrate/conversation-convert.ts';
import { claudeTranscriptFile } from '../../lib/session/transcript/claude-path.ts';
import type { ConversionResult, Converted } from '../../lib/transcript/convert/convert.ts';
import { codexRolloutRelativePath } from '../../lib/transcript/convert/write-codex.ts';
import { LoopbackModel, requestTexts, requestToolNames } from './loopback-model.ts';

/**
 * The validation run a conversion must pass before a session is switched onto it.
 *
 * WHAT IT RUNS. The target harness CLI itself, non-interactively resuming a throwaway rendering of the
 * converted conversation — `claude -p --resume <id>` or `codex exec resume <id>` — in a throwaway home
 * under the system temporary folder, with its model endpoint pointed at {@link LoopbackModel} on
 * 127.0.0.1. The CLI loads the file with its own resume code, rebuilds the history, and sends it; the
 * loopback model records the request and answers "OK".
 *
 * WHAT COUNTS AS ACCEPTED. The CLI exits cleanly, it sent at least one request, the history in its
 * last request contains every sentinel the conversion named, in order, and every native tool the
 * history uses is one the CLI declares. A CLI that rejects the file fails the first test; one that
 * silently drops or reorders it fails the third — which is the failure that matters, because it looks
 * like success from outside.
 *
 * WHAT IT NEVER TOUCHES. The real login's home, its credentials, the network (every proxy variable
 * points at a closed loopback port, so anything but the loopback model fails to connect) and the
 * session's own working directory. The throwaway home is deleted afterwards whatever happened.
 */

/**
 * How long one validation run may take before it is called a failure. A real run takes seconds; the
 * bound keeps two runs (the native rendering and its text-only fallback) plus the relaunch inside the
 * protocol client's 120-second request timeout, so a slow check is a refusal rather than a timeout
 * the caller cannot read.
 */
const CHECK_TIMEOUT_MS = 45_000;

/** What the CLI is asked, so the loopback model has a turn to answer. */
const PROBE_PROMPT = 'Reply with the single word OK.';

/** The provider name the throwaway Codex home declares for the loopback model. */
const CHECK_PROVIDER = 'fy_check';

/** A loopback port nothing listens on: a proxy here refuses every connection immediately. */
export const CLOSED_PROXY = 'http://127.0.0.1:9';

/** What spawning the CLI produced. */
export interface CheckRun {
  readonly exitCode: number | null;
  readonly output: string;
}

/** Runs one command to completion, or kills it at the deadline. Injected so a test can stand in. */
export type CheckSpawn = (request: {
  readonly cmd: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}) => Promise<CheckRun>;

export const bunCheckSpawn: CheckSpawn = async request => {
  const child = Bun.spawn({
    cmd: [...request.cmd],
    cwd: request.cwd,
    env: { ...request.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), request.timeoutMs);
  // A killed child's pipes can stay open on a grandchild, so the read races the exit.
  const read = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const exitCode = await child.exited;
  clearTimeout(timer);
  const output = await Promise.race([
    read.then(([out, err]) => `${out}\n${err}`),
    new Promise<string>(resolve => setTimeout(() => resolve(''), 2_000)),
  ]);
  return { exitCode: child.signalCode === null ? exitCode : null, output };
};

/** The last few lines of what the CLI printed, for a refusal to quote. */
const tail = (output: string): string =>
  output
    .trim()
    .split('\n')
    .slice(-3)
    .map(line => line.trim())
    .filter(line => line !== '')
    .join(' / ')
    .slice(0, 400);

/** Whether every sentinel occurs in `text`, each after the one before it. */
export function inOrder(text: string, sentinels: readonly string[]): boolean {
  let from = 0;
  for (const sentinel of sentinels) {
    const at = text.indexOf(sentinel, from);
    if (at === -1) return false;
    from = at + sentinel.length;
  }
  return true;
}

export class CliConversionCheck implements ConversionCheckPort {
  constructor(
    private readonly spawn: CheckSpawn = bunCheckSpawn,
    private readonly basePath: string = process.env.PATH ?? '/usr/bin:/bin',
    private readonly timeoutMs: number = CHECK_TIMEOUT_MS,
    private readonly temporaryRoot: string = tmpdir(),
  ) {}

  async check(request: {
    readonly harness: Harness;
    readonly executable: string;
    readonly model?: string;
    readonly render: (place: ConversionPlace) => ConversionResult;
  }): Promise<ConversionCheck> {
    // Resolved, because the CLI resolves its working directory before deriving where a conversation
    // lives: on macOS the temporary folder is `/var/…`, a link to `/private/var/…`, and a file written
    // under the unresolved spelling is one Claude never finds.
    const root = await realpath(await mkdtemp(join(this.temporaryRoot, 'fy-convert-check-')));
    const model = new LoopbackModel();
    try {
      const home = join(root, 'home');
      const work = join(root, 'work');
      await mkdir(home, { recursive: true });
      await mkdir(work, { recursive: true });
      const conversationId = randomUUID();
      const rendered = request.render({ cwd: work, conversationId, modelProvider: CHECK_PROVIDER });
      if (rendered.kind === 'refused') return { ok: false, reason: rendered.reason };
      const port = model.start();
      const plan = await this.prepare(request, home, work, conversationId, rendered, port);
      const run = await this.spawn({ cmd: plan.cmd, cwd: work, env: plan.env, timeoutMs: this.timeoutMs });
      return this.verdict(request.harness, run, model, rendered);
    } finally {
      model.stop();
      await rm(root, { recursive: true, force: true });
    }
  }

  /** The throwaway home, the file in it, and the command that resumes it. */
  private async prepare(
    request: { readonly harness: Harness; readonly executable: string; readonly model?: string },
    home: string,
    work: string,
    conversationId: string,
    rendered: Converted,
    port: number,
  ): Promise<{ readonly cmd: readonly string[]; readonly env: Record<string, string> }> {
    const { harness, executable, model } = request;
    const base = {
      HOME: dirname(home),
      PATH: [dirname(executable), this.basePath].join(delimiter),
      HTTP_PROXY: CLOSED_PROXY,
      HTTPS_PROXY: CLOSED_PROXY,
      ALL_PROXY: CLOSED_PROXY,
      http_proxy: CLOSED_PROXY,
      https_proxy: CLOSED_PROXY,
      all_proxy: CLOSED_PROXY,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    };
    if (harness === 'claude') {
      const file = claudeTranscriptFile(home, work, conversationId);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, rendered.transcript, { mode: 0o600 });
      return {
        cmd: [
          executable,
          '-p',
          '--resume',
          conversationId,
          ...(model === undefined ? [] : ['--model', model]),
          PROBE_PROMPT,
        ],
        env: {
          ...base,
          CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          ANTHROPIC_API_KEY: 'fy-conversion-check-not-a-key',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
      };
    }
    const file = join(home, codexRolloutRelativePath(conversationId, new Date().toISOString()));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, rendered.transcript, { mode: 0o600 });
    await writeFile(
      join(home, 'config.toml'),
      [
        `model_provider = "${CHECK_PROVIDER}"`,
        // The model the runtime will run: a Codex build declares its tools per model family, so the
        // check must ask for the same one or it measures a different tool set.
        ...(model === undefined ? [] : [`model = ${JSON.stringify(model)}`]),
        `[model_providers.${CHECK_PROVIDER}]`,
        'name = "Ferretry conversion check"',
        `base_url = "http://127.0.0.1:${port}/v1"`,
        'env_key = "FY_CONVERSION_CHECK_KEY"',
        'wire_api = "responses"',
        '',
      ].join('\n'),
    );
    return {
      cmd: [executable, 'exec', '--skip-git-repo-check', 'resume', conversationId, PROBE_PROMPT],
      env: { ...base, CODEX_HOME: home, FY_CONVERSION_CHECK_KEY: 'not-a-key' },
    };
  }

  private verdict(harness: Harness, run: CheckRun, model: LoopbackModel, rendered: Converted): ConversionCheck {
    const cli = harness === 'claude' ? 'Claude Code' : 'Codex';
    const said = tail(run.output);
    const quoted = said === '' ? '' : ` It said: ${said}`;
    if (run.exitCode === null)
      return { ok: false, reason: `${cli} didn't finish opening the converted conversation in time.${quoted}` };
    const last = model.requests.at(-1);
    if (run.exitCode !== 0 || last === undefined)
      return { ok: false, reason: `${cli} refused to open the converted conversation.${quoted}` };
    if (!inOrder(requestTexts(last), rendered.sentinels))
      return {
        ok: false,
        reason: `${cli} opened the converted conversation but didn't read its history back in order, so it would lose context.`,
      };
    const declared = requestToolNames(last);
    const missing = rendered.nativeTools.filter(tool => !declared.has(tool));
    if (missing.length > 0)
      return {
        ok: false,
        reason: `The converted history uses ${missing.join(', ')}, which this ${cli} doesn't offer as a tool.`,
        missingTools: missing,
      };
    return { ok: true };
  }
}

/** `<cli> --version`, read once per executable. */
export class CliHarnessVersion implements HarnessVersionPort {
  constructor(private readonly spawn: CheckSpawn = bunCheckSpawn) {}

  async version(executable: string): Promise<string | undefined> {
    const run = await this.spawn({
      cmd: [executable, '--version'],
      cwd: tmpdir(),
      env: { PATH: [dirname(executable), process.env.PATH ?? '/usr/bin:/bin'].join(delimiter), HOME: tmpdir() },
      timeoutMs: 20_000,
    }).catch(() => undefined);
    const line = run?.exitCode === 0 ? run.output.trim().split('\n')[0]?.trim() : undefined;
    return line === undefined || line === '' ? undefined : line;
  }
}
