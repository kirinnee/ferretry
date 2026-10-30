import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import type { CheckRun, CheckSpawn } from '../../../src/adapters/transcript/conversion-check.ts';
import { CliRolloutFormatProbe } from '../../../src/adapters/transcript/rollout-format-probe.ts';

/**
 * The probe that learns what rollout format an installed Codex writes, with the CLI stood in by a spawn
 * that leaves a rollout in `CODEX_HOME` as the real one does. The real binary is measured in the harness
 * contract suite (`tests/contract/conversion-acceptance.test.ts`).
 */

type Spawned = Parameters<CheckSpawn>[0];

const fixture = async (name: string): Promise<string> =>
  await Bun.file(new URL(`../../fixtures/transcript/convert/${name}`, import.meta.url)).text();

/** A stand-in Codex: it records how it was run, and leaves `rollout` (when given) where Codex keeps its sessions. */
function codex(rollout: string | undefined, run: CheckRun = { exitCode: 0, output: '' }) {
  const seen: Spawned[] = [];
  const homes: string[] = [];
  const spawn: CheckSpawn = async spawned => {
    seen.push(spawned);
    const home = spawned.env.CODEX_HOME ?? '';
    homes.push(home);
    if (rollout !== undefined) {
      const folder = join(home, 'sessions', '2026', '10', '28');
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'rollout-2026-10-28T00-00-00-x.jsonl'), rollout);
    }
    return run;
  };
  return { spawn, seen, homes };
}

const withRoot = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'fy-probe-test-'));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe('probing the rollout format an installed Codex writes', () => {
  it('should call a rollout of the validated shape the same format, from a throwaway home with no way out', async () => {
    await withRoot(async root => {
      // Arrange
      const stand = codex(await fixture('codex-0.165.0.jsonl'));
      const probe = new CliRolloutFormatProbe(stand.spawn, '/usr/bin', 1000, root);

      // Act
      const verdict = await probe.classify('/opt/codex/bin/codex', '0.170.2');

      // Assert
      should(verdict).deepEqual({ kind: 'same' });
      const [spawned] = stand.seen;
      should(spawned?.cmd.slice(0, 3)).deepEqual(['/opt/codex/bin/codex', 'exec', '--skip-git-repo-check']);
      should(spawned?.env.HTTPS_PROXY).equal('http://127.0.0.1:9');
      should(spawned?.env.CODEX_HOME?.startsWith(root)).be.true();
      should(spawned?.env.PATH?.startsWith('/opt/codex/bin')).be.true();
      should(await readdir(root)).deepEqual([]);
    });
  });

  it('should point the throwaway home at the loopback model and nothing else', async () => {
    await withRoot(async root => {
      // Arrange
      let config = '';
      const spawn: CheckSpawn = async spawned => {
        config = await readFile(join(spawned.env.CODEX_HOME ?? '', 'config.toml'), 'utf8');
        return { exitCode: 0, output: '' };
      };

      // Act
      await new CliRolloutFormatProbe(spawn, '/usr/bin', 1000, root).classify('/bin/codex', '0.170.2');

      // Assert
      should(config).match(/base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/);
      should(config).containEql('wire_api = "responses"');
    });
  });

  it('should name what moved when the rollout lost a key the converter reads', async () => {
    await withRoot(async root => {
      // Arrange
      const damaged = (await fixture('codex-0.165.0.jsonl')).replaceAll('"role":', '"speaker":');
      const probe = new CliRolloutFormatProbe(codex(damaged).spawn, '/usr/bin', 1000, root);

      // Act
      const verdict = await probe.classify('/bin/codex', '0.170.2');

      // Assert
      should(verdict.kind).equal('different');
      should((verdict as { reason: string }).reason).containEql('payload.role');
    });
  });

  it('should call a run that left no rollout a different format', async () => {
    await withRoot(async root => {
      // Act
      const verdict = await new CliRolloutFormatProbe(codex(undefined).spawn, '/usr/bin', 1000, root).classify(
        '/bin/codex',
        '0.170.2',
      );

      // Assert
      should(verdict).deepEqual({ kind: 'different', reason: 'it no longer writes a rollout file' });
    });
  });

  it('should leave a run that timed out, failed or threw unchecked, and not remember it', async () => {
    await withRoot(async root => {
      // Arrange
      const runs: (CheckRun | Error)[] = [
        { exitCode: null, output: '' },
        { exitCode: 2, output: '' },
        new Error('spawn failed'),
      ];
      const spawn: CheckSpawn = async () => {
        const next = runs.shift();
        if (next instanceof Error) throw next;
        return next ?? { exitCode: 0, output: '' };
      };
      const probe = new CliRolloutFormatProbe(spawn, '/usr/bin', 1000, root);

      // Act
      const verdicts = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        verdicts.push(await probe.classify('/bin/codex', '0.170.2'));
        await new Promise(resolve => setImmediate(resolve));
      }

      // Assert
      should(verdicts.map(verdict => verdict.kind)).deepEqual(['unchecked', 'unchecked', 'unchecked']);
      should((verdicts[0] as { reason: string }).reason).containEql("didn't finish");
      should((verdicts[1] as { reason: string }).reason).containEql('exited with an error');
      should((verdicts[2] as { reason: string }).reason).equal('spawn failed');
      should(runs).deepEqual([]);
    });
  });

  it('should probe a binary once per path and version, and again for another path or version', async () => {
    await withRoot(async root => {
      // Arrange
      const stand = codex(await fixture('codex-0.165.0.jsonl'));
      const probe = new CliRolloutFormatProbe(stand.spawn, '/usr/bin', 1000, root);

      // Act
      await Promise.all([probe.classify('/bin/codex', '0.170.2'), probe.classify('/bin/codex', '0.170.2')]);
      await probe.classify('/bin/codex', '0.170.2');
      const afterRepeat = stand.seen.length;
      await probe.classify('/bin/codex', '0.171.0');
      await probe.classify('/other/codex', '0.171.0');

      // Assert
      should(afterRepeat).equal(1);
      should(stand.seen.length).equal(3);
    });
  });
});
