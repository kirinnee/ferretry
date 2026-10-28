import { describe, it } from 'bun:test';
import should from 'should';
import { CliConversionCheck, CliHarnessVersion } from '../../src/adapters/transcript/conversion-check.ts';
import { CliRolloutFormatProbe } from '../../src/adapters/transcript/rollout-format-probe.ts';
import { type ConversionPlace, needsRolloutFormatProbe } from '../../src/lib/migrate/conversation-convert.ts';
import { type ConversionResult, convertConversation } from '../../src/lib/transcript/convert/convert.ts';
import type { RolloutFormatVerdict } from '../../src/lib/transcript/convert/rollout-format.ts';

/**
 * The harness contract for cross-harness conversion: the REAL target CLI accepts what the converter
 * writes, and the validation run would catch it if it did not.
 *
 * Every recorded transcript of the other harness (`tests/fixtures/transcript/convert/`, written by real
 * CLIs) is converted for the CLI under test and resumed by it, non-interactively, in a throwaway home
 * against the loopback model — the exact run a move gates on. The negative controls prove the run
 * discriminates: a rollout with no `session_meta`, and a Claude transcript whose chain is cut, must both
 * be refused. A Codex outside the converter's table is judged the way a move judges it, by probing the
 * format the binary writes: it passes here when that format is the validated one, and fails loudly when
 * it is not or cannot be checked, which is the signal (on the scheduled `latest` run) to record the new
 * version's transcripts and teach the converter what moved.
 *
 * Opt-in like the rest of the guard: `packages/fleet/tests/contract/run.sh` sets `FY_HARNESS_CONTRACT=1`
 * and the binaries; every other test run skips this file.
 */

const enabled = process.env.FY_HARNESS_CONTRACT === '1';
const binaries = { claude: process.env.FY_CONTRACT_CLAUDE_BIN, codex: process.env.FY_CONTRACT_CODEX_BIN };

const fixture = async (name: string): Promise<string> =>
  await Bun.file(new URL(`../fixtures/transcript/convert/${name}`, import.meta.url)).text();

/** A Claude fixture before its compaction, so the whole scripted conversation is in play. */
const beforeCompaction = (text: string): string => {
  const lines = text.split('\n');
  return lines
    .slice(
      0,
      lines.findIndex(line => line.includes('"compact_boundary"')),
    )
    .join('\n');
};

const SOURCES = {
  codex: ['claude-2.1.281.jsonl', 'claude-2.1.304.jsonl'],
  claude: [
    'codex-0.145.0.jsonl',
    'codex-0.156.1.jsonl',
    'codex-0.163.0.jsonl',
    'codex-0.164.0.jsonl',
    'codex-0.165.0.jsonl',
  ],
} as const;

/** The model each target is asked to run: Codex declares its tools per model family. */
const MODEL = { claude: undefined, codex: 'gpt-5.5' } as const;

function binary(target: 'claude' | 'codex'): string {
  const bin = binaries[target];
  if (bin === undefined || bin === '')
    throw new Error(`FY_HARNESS_CONTRACT=1 but FY_CONTRACT_${target.toUpperCase()}_BIN is unset — run run.sh`);
  return bin;
}

/** What a move would learn about this binary's rollouts: only a Codex outside the table is probed. */
async function formatOf(target: 'claude' | 'codex', executable: string, version: string | undefined) {
  return target === 'codex' && needsRolloutFormatProbe('codex', version)
    ? await new CliRolloutFormatProbe().classify(executable, version)
    : undefined;
}

const renderer =
  (
    source: 'claude' | 'codex',
    text: string,
    target: 'claude' | 'codex',
    version: string | undefined,
    format?: RolloutFormatVerdict,
  ) =>
  (place: ConversionPlace): ConversionResult =>
    convertConversation({
      source: { harness: source, text, documents: new Map() },
      target: {
        harness: target,
        version,
        ...(format === undefined ? {} : { format }),
        conversationId: place.conversationId,
        cwd: place.cwd,
        contextWindow: 200_000,
        ...(place.modelProvider === undefined ? {} : { modelProvider: place.modelProvider }),
      },
      attachmentDirectory: '/state/conversions/contract',
      at: new Date().toISOString(),
    });

for (const target of ['codex', 'claude'] as const) {
  const source = target === 'codex' ? 'claude' : 'codex';
  describe.skipIf(!enabled)(`converted conversations, resumed by the real ${target}`, () => {
    for (const name of SOURCES[target])
      it(`should accept ${name} and read its whole history back in order`, async () => {
        // Arrange
        const executable = binary(target);
        const version = await new CliHarnessVersion().version(executable);
        const raw = await fixture(name);
        const text = source === 'claude' ? beforeCompaction(raw) : raw;
        const render = renderer(source, text, target, version, await formatOf(target, executable, version));
        const probe = render({ cwd: '/w', conversationId: '00000000-0000-4000-8000-000000000000' });
        if (probe.kind === 'refused') throw new Error(`the converter refused ${target} ${version}: ${probe.reason}`);

        // Act
        const verdict = await new CliConversionCheck().check({
          harness: target,
          executable,
          ...(MODEL[target] === undefined ? {} : { model: MODEL[target] }),
          render,
        });

        // Assert
        should(verdict).deepEqual({ ok: true });
      }, 180_000);

    it('should refuse a damaged conversation, so the run proves something', async () => {
      // Arrange
      const executable = binary(target);
      const version = await new CliHarnessVersion().version(executable);
      const name = SOURCES[target][0];
      const raw = await fixture(name);
      const text = source === 'claude' ? beforeCompaction(raw) : raw;
      const intact = renderer(source, text, target, version, await formatOf(target, executable, version));
      // Codex: the thread's own header gone. Claude: the chain cut after its first record, so only the
      // opening message is still reachable from the newest one.
      const damage = (transcript: string): string => {
        const lines = transcript.trim().split('\n');
        if (target === 'codex') return `${lines.slice(1).join('\n')}\n`;
        const cut = lines.map((line, index) =>
          index === 2 ? JSON.stringify({ ...JSON.parse(line), parentUuid: null }) : line,
        );
        return `${cut.join('\n')}\n`;
      };
      const damaged = (place: ConversionPlace): ConversionResult => {
        const result = intact(place);
        return result.kind === 'converted' ? { ...result, transcript: damage(result.transcript) } : result;
      };

      // Act
      const verdict = await new CliConversionCheck().check({
        harness: target,
        executable,
        ...(MODEL[target] === undefined ? {} : { model: MODEL[target] }),
        render: damaged,
      });

      // Assert
      should(verdict.ok).be.false();
    }, 180_000);
  });
}

describe.skipIf(!enabled)('the format of the rollouts the real codex writes', () => {
  it('should be the format the converter was validated on, as the probe a move runs finds it', async () => {
    // Arrange
    const executable = binary('codex');

    // Act
    const verdict = await new CliRolloutFormatProbe().classify(executable, 'contract');

    // Assert
    should(verdict).deepEqual({ kind: 'same' });
  }, 180_000);
});
