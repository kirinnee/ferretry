import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptProvenance } from '@ferretry/protocol';
import should from 'should';
import bareStart from '../../../fixtures/transcript/codex-rollouts/codex-0.156.1-bare-start.jsonl' with { type: 'text' };
import codex0145 from '../../../fixtures/transcript/codex-rollouts/codex-0.145.0.jsonl' with { type: 'text' };
import codex0156 from '../../../fixtures/transcript/codex-rollouts/codex-0.156.1.jsonl' with { type: 'text' };
import codex0163 from '../../../fixtures/transcript/codex-rollouts/codex-0.163.0.jsonl' with { type: 'text' };
import { FileHarnessWrapperSource, NodeCodexRolloutIndex } from '../../../../src/adapters/index.ts';
import {
  CodexTranscriptParser,
  SessionTranscriptResolver,
  TranscriptProvenanceCapture,
} from '../../../../src/lib/index.ts';

/**
 * THE GUARD PER SUPPORTED CODEX VERSION: can a session this daemon started prove its own rollout?
 *
 * Each fixture is a REAL rollout, recorded from that Codex release's interactive TUI against a local
 * stand-in for the model API, launched with the argument a start puts on the argv and spoken to with
 * one typed line ("hello"). Only absolute paths were replaced with placeholders. A Codex release
 * that moves or drops the recorded workspace root fails here, before an owner's Chat goes empty.
 *
 * Adding a version: record it the same way, add the fixture, and add it to `VERSIONS`.
 */

const VERSIONS: readonly { readonly version: string; readonly rollout: string }[] = [
  { version: '0.145.0', rollout: codex0145 },
  { version: '0.156.1', rollout: codex0156 },
  { version: '0.163.0', rollout: codex0163 },
];

const directories = new Set<string>();

afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.add(directory);
  return directory;
}

interface Host {
  readonly root: string;
  readonly home: string;
  readonly cwd: string;
  readonly wrapper: string;
}

/** A fleet wrapper exporting a private Codex home, as a generated one does. */
async function codexHost(): Promise<Host> {
  const root = await temporaryDirectory('ferretry-codex-version-');
  const home = join(root, 'homes', 'codex-auto');
  const cwd = join(root, 'work');
  const wrapper = join(root, 'bin', 'codex-auto');
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(wrapper, `#!/usr/bin/env bash\nexport CODEX_HOME="${home}"\nexec codex "$@"\n`, { mode: 0o755 });
  return { root, home, cwd, wrapper };
}

/** The rollout's own id, from its `session_meta` header. */
function rolloutId(rollout: string): string {
  const header = JSON.parse(rollout.slice(0, rollout.indexOf('\n'))) as { payload: { id: string } };
  return header.payload.id;
}

/** Writes a recorded rollout under the host's home, where and as Codex names it. */
async function codexWrites(host: Host, rollout: string, correlationRoot: string | undefined): Promise<string> {
  const directory = join(host.home, 'sessions', '2026', '10', '19');
  await mkdir(directory, { recursive: true });
  const file = join(directory, `rollout-2026-10-19T07-12-08-${rolloutId(rollout)}.jsonl`);
  const text = rollout
    .replaceAll('@@CODEX_HOME@@', host.home)
    .replaceAll('@@CWD@@', host.cwd)
    .replaceAll('@@CORRELATION_ROOT@@', correlationRoot ?? '/nowhere');
  await writeFile(file, text, 'utf8');
  return file;
}

/** The resolver with nothing claimed and a store that records what it is told. */
function resolver(recorded: TranscriptProvenance[]): SessionTranscriptResolver {
  return new SessionTranscriptResolver(
    new NodeCodexRolloutIndex(),
    { claimed: async () => [] },
    { record: async (_id, provenance) => void recorded.push(provenance) },
    { now: () => '2026-10-19T07:13:00.000Z' },
  );
}

function capture(host: Host): TranscriptProvenanceCapture {
  const rollouts = new NodeCodexRolloutIndex();
  return new TranscriptProvenanceCapture(new FileHarnessWrapperSource(), { next: () => 'unused' }, rollouts, {
    HOME: host.root,
  });
}

describe('Codex transcript binding, per supported version', () => {
  for (const { version, rollout } of VERSIONS) {
    it(`should prove a ${version} rollout whose only send was one typed line`, async () => {
      // Arrange: an older rollout of another session in the same home, a start, then Codex writing.
      const host = await codexHost();
      await codexWrites(host, bareStart, undefined);
      const token = join(host.root, 'state', 'sessions', 'mvewigk9-8df3c7c0');
      const captured = await capture(host).capture({
        harness: 'codex',
        executable: host.wrapper,
        cwd: host.cwd,
        correlationToken: token,
        at: '2026-10-19T07:12:00.000Z',
      });
      const declared = captured.launchArguments[captured.launchArguments.indexOf('--add-dir') + 1];
      const mine = await codexWrites(host, rollout, declared);
      const recorded: TranscriptProvenance[] = [];

      // Act
      const file = await resolver(recorded).file('mvewigk9-8df3c7c0', captured.provenance);
      const parsed = new CodexTranscriptParser().parse({ text: rollout, source: mine, sessionId: 's' });

      // Assert: the rollout is this session's, persisted, and still reads as a conversation.
      should(file).equal(mine);
      should(recorded).have.length(1);
      should(recorded[0]).containDeep({ identity: 'correlated', harnessSessionId: rolloutId(rollout), file: mine });
      should(parsed.issues).be.empty();
      should(parsed.observedInputs.map(input => input.text)).eql(['hello']);
      should(parsed.events.some(event => event.kind === 'message' && event.role === 'assistant')).be.true();
    });
  }

  it('should prove nothing for a rollout launched without the correlation root — the owner’s bug', async () => {
    // Arrange: what a 0.156 start without the argument wrote — a live session, never provable.
    const host = await codexHost();
    const provenance: TranscriptProvenance = {
      v: 1,
      home: host.home,
      identity: 'undiscovered',
      baseline: [],
      correlationToken: join(host.root, 'state', 'sessions', 'mvewigk9-8df3c7c0'),
    };
    await codexWrites(host, bareStart, undefined);
    const recorded: TranscriptProvenance[] = [];

    // Act
    const file = await resolver(recorded).file('mvewigk9-8df3c7c0', provenance);

    // Assert: refused rather than guessed by cwd or recency.
    should(file).be.undefined();
    should(recorded).be.empty();
  });

  it('should not hand one session a concurrent teammate’s rollout in the same home and cwd', async () => {
    // Arrange: two sessions started together on one account and folder, each with its own token.
    const host = await codexHost();
    const tokens = ['mine', 'peer'].map(name => join(host.root, 'state', 'sessions', name));
    const captures = await Promise.all(
      tokens.map(
        async correlationToken =>
          await capture(host).capture({
            harness: 'codex',
            executable: host.wrapper,
            cwd: host.cwd,
            correlationToken,
            at: '2026-10-19T07:12:00.000Z',
          }),
      ),
    );
    const roots = captures.map(each => each.launchArguments[1]);
    const mine = await codexWrites(host, codex0156, roots[0]);
    const peer = await codexWrites(host, codex0163, roots[1]);

    // Act
    const files = await Promise.all(
      captures.map(async (each, index) => await resolver([]).file(`s-${index}`, each.provenance)),
    );

    // Assert
    should(files).eql([mine, peer]);
  });
});
