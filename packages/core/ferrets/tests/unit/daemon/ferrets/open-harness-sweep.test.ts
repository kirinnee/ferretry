import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { describe, expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import { harnessLabel, loginScope } from '../../../../app/features/info/info-model.ts';
import { isConvertible } from '../../../../app/features/move/conversion-model.ts';
import {
  byRecordedHarness,
  conversionTargetOf,
  harnessKeyOfRecorded,
  harnessProductName,
  harnessShortName,
  isConvertibleHarness,
  recordedHarnessOf,
  UnsupportedHarnessFamilyError,
} from '../../../../contract/index.ts';
import { conversationFromArguments } from '../../../../contract/conversation-lease.ts';
import {
  emptyChildEnvironment,
  FakeHarness,
  FakeRunner,
  fakeThirdHarness,
  fenced,
  ferretId,
  ferretSummary,
  T0,
  THIRD_HARNESS_KEY,
} from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

/**
 * The closed-harness sweep of Ferrets (runtimes plan U4b): a harness the contract never named (`fake-third`) is started
 * through the real service, and every place that used to read "not Codex, so Claude" now names it or refuses it. Each
 * assertion here was a quiet Claude (or Codex) answer before the sweep. Fixture values only.
 */

const startThird = async () => {
  const registry = new FerretRegistry([]);
  const third = fakeThirdHarness('/fixture-fy/state/fake-third/agent-homes');
  const installed = new Map<string, FakeHarness>([
    ['claude-code', new FakeHarness('claude-code', '/fixture-fy/state/claude-code/agent-homes')],
    [THIRD_HARNESS_KEY, third],
  ]);
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => ferretId('third-one'),
    newName: taken => {
      for (let n = 1; ; n += 1) if (!taken(`fern${n}`)) return `fern${n}`;
    },
    save: async () => {},
    saveTokens: async () => {},
    harness: key => installed.get(key),
    harnessKeys: () => [...installed.keys()],
    runner: () => new FakeRunner(),
    decide: async () => ({ allow: true }),
    launchParts: () => [],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
  };
  const service = new FerretsService(registry, new FerretTokenDirectory(), ports);
  const started = await service.start({ folder: '/work', by: 'owner', harness: THIRD_HARNESS_KEY }, PERSON_ORIGIN);
  if (!started.ok) throw new Error('start refused');
  const listed = await service.list();
  return { summary: listed.find(entry => entry.id === started.value) };
};

describe('a ferret on a harness the contract never named', () => {
  test('is called by its own key in the app, never by Claude Code or Codex', async () => {
    const { summary } = await startThird();

    expect(summary?.harness).toBe(THIRD_HARNESS_KEY);
    if (summary === undefined) return;
    expect(harnessLabel(summary)).toBe(THIRD_HARNESS_KEY);
    expect(loginScope(summary)).toBe(`${THIRD_HARNESS_KEY}-only`);
    expect(isConvertible(summary)).toBe(false);
  });

  test('keeps the two shipped harnesses worded as before', () => {
    expect(harnessLabel(ferretSummary({ id: 'a', harness: 'claude-code' }))).toBe('Claude Code');
    expect(harnessLabel(ferretSummary({ id: 'b', harness: 'codex' }))).toBe('Codex');
    expect(loginScope(ferretSummary({ id: 'c', harness: 'codex' }))).toBe('Codex-only');
    expect(loginScope(ferretSummary({ id: 'd', harness: 'claude-code' }))).toBe('Claude-only');
    expect(harnessShortName('claude')).toBe('Claude');
    expect(harnessProductName('claude')).toBe('Claude Code');
  });

  test('has no converter, and the two shipped ones convert into each other', () => {
    expect(isConvertibleHarness(THIRD_HARNESS_KEY)).toBe(false);
    expect(conversionTargetOf('claude-code')).toBe('codex');
    expect(conversionTargetOf('codex')).toBe('claude-code');
  });

  test('is stamped under its own key in a session document, and the family table round-trips the two', () => {
    expect(recordedHarnessOf(THIRD_HARNESS_KEY)).toBe(THIRD_HARNESS_KEY);
    expect(recordedHarnessOf('claude-code')).toBe('claude');
    expect(harnessKeyOfRecorded('claude')).toBe('claude-code');
    expect(harnessKeyOfRecorded('codex')).toBe('codex');
    expect(harnessKeyOfRecorded(THIRD_HARNESS_KEY)).toBe(THIRD_HARNESS_KEY);
  });

  test('is refused by name where code would have read it as the other family', () => {
    const refusal = new UnsupportedHarnessFamilyError(THIRD_HARNESS_KEY);

    expect(() => byRecordedHarness(THIRD_HARNESS_KEY, { claude: () => 'c', codex: () => 'x' })).toThrow(
      refusal.message,
    );
    expect(() => conversationFromArguments(THIRD_HARNESS_KEY as never, ['resume', 'abc'])).toThrow(refusal.message);
  });
});
