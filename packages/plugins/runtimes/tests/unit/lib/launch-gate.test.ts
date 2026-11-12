/**
 * What a runtime's login does to a Claude launch: its compaction trigger, as a `compact` part from the facts `start.decide`
 * checked. The gate never touches the login's ENVIRONMENT: a project's own `.claude` env wins over it (v4 before 4.291.9;
 * owner, !A500), so it reads no folder, pins nothing and refuses no start over a key a folder sets. The parts source reads
 * nothing again and is required.
 */
import { describe, it } from 'bun:test';
import { LaunchPartsRefusal, type LaunchSpec, type StartDecideInput } from '@ferretry/core-ferrets/contract';
import should from 'should';
import { LaunchGate, type RuntimeLaunchFactsSource } from '../../../daemon/lib/launch-gate.ts';

const FACTS = {
  kind: 'claude' as const,
  windows: { defaultModel: 'm', models: [{ id: 'm', context: 1_000_000 }] },
};
const source = (facts: typeof FACTS | undefined): RuntimeLaunchFactsSource => ({ facts: async () => facts });
const input = (more: Partial<StartDecideInput> = {}): StartDecideInput =>
  ({
    ferret: 'f1',
    name: 'a',
    role: 'lead',
    harness: 'claude-code',
    runtime: 'work',
    folder: '/work/a',
    by: 'owner',
    ...more,
  }) as unknown as StartDecideInput;
const spec = (more: Partial<LaunchSpec> = {}): Omit<LaunchSpec, 'parts'> =>
  ({ ferret: 'f1', harness: 'claude-code', runtime: 'work', ...more }) as unknown as Omit<LaunchSpec, 'parts'>;
const gate = (facts: typeof FACTS | undefined) => new LaunchGate({ source: source(facts) });

describe('LaunchGate.decide', () => {
  it('should refuse when the published runtimes cannot be read', async () => {
    const answer = await new LaunchGate({
      source: {
        facts: async () => {
          throw new Error('damaged');
        },
      },
    }).decide(input());

    should(answer.allow).be.false();
    should((answer as { reason: string }).reason).containEql('could not be read');
  });

  it('should allow a Claude start of a published runtime: it needs no folder, so none is ever read or refused', async () => {
    // The gate has no folder reader (a project’s `.claude` env wins over a login’s: owner, !A500), so nothing a folder
    // sets, a `${secret:}` key or a bare $OTHER key included, can be a reason to refuse.
    should((await gate(FACTS).decide(input())).allow).be.true();
  });

  it('should allow a start on another harness, one on no runtime and one on an unpublished runtime', async () => {
    const decide = gate(FACTS).decide;
    const nothing = gate(undefined).decide;

    should((await decide(input())).allow).be.true();
    should((await decide(input({ harness: 'codex' }))).allow).be.true();
    should((await decide(input({ runtime: undefined }))).allow).be.true();
    should((await nothing(input())).allow).be.true();
  });
});

describe('LaunchGate.decide: a start’s OWN compaction trigger (v4 checkCompactAt)', () => {
  const SMALL = { ...FACTS, windows: { defaultModel: 'm', models: [{ id: 'm', context: 128_000 }] } };
  const refusal = (answer: Awaited<ReturnType<LaunchGate['decide']>>) => (answer as { reason: string }).reason;

  it('should refuse a number larger than the model’s window with v4’s sentence, before anything is written', async () => {
    const answer = await gate(SMALL).decide(input({ compactAt: 200_000 }));

    should(answer.allow).be.false();
    should(refusal(answer)).equal(
      "200k is larger than this model's 128k window, so it could never trigger. Pick 128k or less.",
    );
  });

  it('should judge the model the start NAMED, and a [1m] selector as 1M', async () => {
    should((await gate(SMALL).decide(input({ compactAt: 400_000, model: 'm[1m]' }))).allow).be.true();
    should((await gate(FACTS).decide(input({ compactAt: 2_000_000 }))).allow).be.false();
  });

  it('should accept a number equal to the window, and auto', async () => {
    should((await gate(SMALL).decide(input({ compactAt: 128_000 }))).allow).be.true();
    should((await gate(SMALL).decide(input({ compactAt: 'auto' }))).allow).be.true();
  });

  it('should judge an unstated window against the 200k default', async () => {
    const unstated = { ...FACTS, windows: { defaultModel: 'm', models: [{ id: 'm' }] } };
    should((await gate(unstated as never).decide(input({ compactAt: 200_000 }))).allow).be.true();
    should((await gate(unstated as never).decide(input({ compactAt: 200_001 }))).allow).be.false();
  });

  it('should refuse on another harness too, where the old gate said nothing', async () => {
    const answer = await gate({ ...SMALL, kind: 'codex' } as never).decide(
      input({ harness: 'codex', compactAt: 500_000 }),
    );

    should(answer.allow).be.false();
    should(refusal(answer)).containEql('larger than this model');
  });

  it('should never refuse a RELAUNCH: a resume carries no explicit trigger, and any other falls back to Auto at launch', async () => {
    should((await gate(SMALL).decide(input({ by: 'resume', compactAt: 500_000 }))).allow).be.true();
    should((await gate(SMALL).decide(input())).allow).be.true();
  });

  it('should judge an EXPLICIT start on no runtime, or an unpublished one, against the conservative 200k window', async () => {
    const sentence = "500k is larger than this model's 200k window, so it could never trigger. Pick 200k or less.";
    const noRuntime = await gate(SMALL).decide(input({ compactAt: 500_000, runtime: undefined }));
    should(noRuntime.allow).be.false();
    should(refusal(noRuntime)).equal(sentence);
    const unpublished = await gate(undefined).decide(input({ compactAt: 500_000 }));
    should(unpublished.allow).be.false();
    should(refusal(unpublished)).equal(sentence);
    // On another harness too, and for the 200k itself, auto and a [1m] selector (which states its own window) it allows.
    should((await gate(undefined).decide(input({ harness: 'codex', compactAt: 500_000 }))).allow).be.false();
    should((await gate(undefined).decide(input({ compactAt: 200_000 }))).allow).be.true();
    should((await gate(undefined).decide(input({ compactAt: 'auto' }))).allow).be.true();
    should((await gate(undefined).decide(input({ compactAt: 500_000, model: 'm[1m]' }))).allow).be.true();
    should((await gate(SMALL).decide(input({ compactAt: 150_000, runtime: undefined }))).allow).be.true();
  });

  it('should still leave a relaunch and a start with no trigger alone when the runtime is unknown', async () => {
    should((await gate(undefined).decide(input({ by: 'resume', compactAt: 500_000 }))).allow).be.true();
    should((await gate(undefined).decide(input())).allow).be.true();
    should((await gate(SMALL).decide(input({ runtime: undefined }))).allow).be.true();
  });

  it('should say so when the published runtimes cannot be read for a codex start that named a trigger', async () => {
    const answer = await new LaunchGate({
      source: {
        facts: async () => {
          throw new Error('damaged');
        },
      },
    }).decide(input({ harness: 'codex', compactAt: 200_000 }));

    should(answer.allow).be.false();
    should(refusal(answer)).containEql('compaction trigger cannot be checked');
  });
});

describe('LaunchGate.parts', () => {
  it('should be a required source, so Ferrets refuses a launch it cannot answer', () => {
    should(gate(FACTS).parts.required).be.true();
  });

  it('should contribute the login’s compaction trigger as a compact part', async () => {
    const launch = gate({ ...FACTS, compactAt: 200_000 } as never);
    await launch.decide(input());

    should(await launch.parts.parts(spec())).deepEqual([{ kind: 'compact', at: 200_000 }]);
  });

  it('should read the facts ONCE: the trigger written is the one the start was judged against', async () => {
    let reads = 0;
    const launch = new LaunchGate({
      source: {
        facts: async () => {
          reads += 1;
          // A second read would find the trigger changed by an apply in between.
          return { ...FACTS, compactAt: reads === 1 ? 200_000 : 100_000 };
        },
      },
    });
    await launch.decide(input());

    should(await launch.parts.parts(spec())).deepEqual([{ kind: 'compact', at: 200_000 }]);
    should(reads).equal(1);
  });

  it('should refuse a launch no decision checked, rather than launch without its trigger', async () => {
    const launch = gate(FACTS);

    await should(launch.parts.parts(spec())).be.rejectedWith(LaunchPartsRefusal);
  });

  it('should use a checked snapshot for one launch only', async () => {
    const launch = gate(FACTS);
    await launch.decide(input());
    await launch.parts.parts(spec());

    await should(launch.parts.parts(spec())).be.rejectedWith(LaunchPartsRefusal);
  });

  it('should refuse a launch whose runtime is not the one that was checked, and one whose decision was superseded', async () => {
    const launch = gate(FACTS);
    await launch.decide(input());
    await should(launch.parts.parts(spec({ runtime: 'other' }))).be.rejectedWith(LaunchPartsRefusal);

    await launch.decide(input());
    await launch.decide(input({ runtime: undefined }));
    await should(launch.parts.parts(spec())).be.rejectedWith(LaunchPartsRefusal);
  });

  it('should contribute nothing for another harness or no runtime (nothing was checked, nothing is owed)', async () => {
    const launch = gate(FACTS);

    should(await launch.parts.parts(spec({ harness: 'codex' }))).deepEqual([]);
    should(await launch.parts.parts(spec({ runtime: undefined }))).deepEqual([]);
  });

  it('should contribute nothing for an unpublished runtime, a Codex runtime or an Auto trigger, once checked', async () => {
    const unpublished = gate(undefined);
    const codex = gate({ ...FACTS, kind: 'codex' as never, compactAt: 200_000 } as never);
    const bare = gate(FACTS);
    for (const launch of [unpublished, codex, bare]) await launch.decide(input());

    should(await unpublished.parts.parts(spec())).deepEqual([]);
    should(await codex.parts.parts(spec())).deepEqual([]);
    should(await bare.parts.parts(spec())).deepEqual([]);
  });
});
