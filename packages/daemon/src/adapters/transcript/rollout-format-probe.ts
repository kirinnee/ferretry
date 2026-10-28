import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { RolloutFormatPort } from '../../lib/migrate/conversation-convert.ts';
import {
  classifyRolloutShape,
  REQUIRED_ROLLOUT_KINDS,
  type RolloutFormatVerdict,
  rolloutShape,
} from '../../lib/transcript/convert/rollout-format.ts';
import { bunCheckSpawn, CLOSED_PROXY, type CheckSpawn } from './conversion-check.ts';
import { LoopbackModel } from './loopback-model.ts';

/**
 * Finds out what rollout format the installed Codex writes by running it once.
 *
 * The converter is gated to the Codex versions it was measured on, but Codex ships almost daily. For a
 * version outside that table the question that matters is not "is it listed" but "does it still write
 * the records the converter reads and writes" — so this runs the binary itself, non-interactively, for
 * one turn in a throwaway `CODEX_HOME` against {@link LoopbackModel} on 127.0.0.1 (every proxy variable
 * points at a closed port, no login is read, nothing reaches the network), and compares the rollout it
 * leaves behind with the validated shape.
 *
 * The answer is remembered per binary path and version. A probe that could not run (timeout, the CLI
 * refusing to start) is NOT remembered: that is a fact about this moment, not about the binary.
 */

const PROBE_TIMEOUT_MS = 30_000;
const PROBE_PROMPT = 'Reply with the single word OK.';
const PROBE_PROVIDER = 'fy_probe';
/** A model whose tool set Codex declares without asking its provider, as in the conversion check. */
const PROBE_MODEL = 'gpt-5.5';

/** Every rollout file under `folder`, newest first. */
async function rollouts(folder: string): Promise<readonly string[]> {
  const found: { readonly file: string; readonly at: number }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.jsonl')) found.push({ file: path, at: (await Bun.file(path).stat()).mtimeMs });
    }
  };
  await walk(folder);
  return found.toSorted((left, right) => right.at - left.at).map(entry => entry.file);
}

export class CliRolloutFormatProbe implements RolloutFormatPort {
  private readonly remembered = new Map<string, Promise<RolloutFormatVerdict>>();

  constructor(
    private readonly spawn: CheckSpawn = bunCheckSpawn,
    private readonly basePath: string = process.env.PATH ?? '/usr/bin:/bin',
    private readonly timeoutMs: number = PROBE_TIMEOUT_MS,
    private readonly temporaryRoot: string = tmpdir(),
  ) {}

  classify(executable: string, version: string): Promise<RolloutFormatVerdict> {
    const key = `${executable}\u0000${version}`;
    const known = this.remembered.get(key);
    if (known !== undefined) return known;
    const probing = this.probe(executable);
    this.remembered.set(key, probing);
    void probing.then(verdict => {
      if (verdict.kind === 'unchecked') this.remembered.delete(key);
    });
    return probing;
  }

  private async probe(executable: string): Promise<RolloutFormatVerdict> {
    const root = await realpath(await mkdtemp(join(this.temporaryRoot, 'fy-format-probe-')));
    const model = new LoopbackModel();
    try {
      const home = join(root, 'codex');
      const work = join(root, 'work');
      await mkdir(home, { recursive: true });
      await mkdir(work, { recursive: true });
      const port = model.start();
      await writeFile(
        join(home, 'config.toml'),
        [
          `model_provider = "${PROBE_PROVIDER}"`,
          `model = "${PROBE_MODEL}"`,
          `[model_providers.${PROBE_PROVIDER}]`,
          'name = "Ferretry format probe"',
          `base_url = "http://127.0.0.1:${port}/v1"`,
          'env_key = "FY_FORMAT_PROBE_KEY"',
          'wire_api = "responses"',
          '',
        ].join('\n'),
      );
      const run = await this.spawn({
        cmd: [executable, 'exec', '--skip-git-repo-check', PROBE_PROMPT],
        cwd: work,
        env: {
          HOME: root,
          PATH: [dirname(executable), this.basePath].join(delimiter),
          CODEX_HOME: home,
          FY_FORMAT_PROBE_KEY: 'not-a-key',
          HTTP_PROXY: CLOSED_PROXY,
          HTTPS_PROXY: CLOSED_PROXY,
          ALL_PROXY: CLOSED_PROXY,
          http_proxy: CLOSED_PROXY,
          https_proxy: CLOSED_PROXY,
          all_proxy: CLOSED_PROXY,
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '127.0.0.1,localhost',
        },
        timeoutMs: this.timeoutMs,
      });
      if (run.exitCode === null) return { kind: 'unchecked', reason: "the probe run didn't finish in time" };
      if (run.exitCode !== 0) return { kind: 'unchecked', reason: 'the probe run exited with an error' };
      const [newest] = await rollouts(join(home, 'sessions'));
      if (newest === undefined) return { kind: 'different', reason: 'it no longer writes a rollout file' };
      return classifyRolloutShape(rolloutShape(await Bun.file(newest).text()), REQUIRED_ROLLOUT_KINDS);
    } catch (error) {
      return { kind: 'unchecked', reason: error instanceof Error ? error.message : 'the probe run failed' };
    } finally {
      model.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
}
