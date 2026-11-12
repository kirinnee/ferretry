/**
 * What a runtime's login does to a Claude launch (#1587): a folder that would blank it is refused on `start.decide`,
 * and the SAME checked facts supply its literal environment as a `pin` launch part and its compaction trigger as a
 * `compact` part. The parts source reads nothing again and is required.
 */
import { describe, it } from 'bun:test';
import { LaunchPartsRefusal, type LaunchSpec, type StartDecideInput } from '@ferretry/core-ferrets/contract';
import should from 'should';
import { FolderSettingsUnreadableError } from '../../../daemon/lib/folder-settings.ts';
import { LaunchGate, type RuntimeLaunchFactsSource } from '../../../daemon/lib/launch-gate.ts';

const FACTS = {
  runtime: 'work',
  kind: 'claude' as const,
  secretEnvNames: ['ANTHROPIC_API_KEY'],
  referencedEnv: ['OTHER_KEY'],
  pins: { ANTHROPIC_BASE_URL: 'https://gateway.invalid' },
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
const folderWith = (...names: string[]) => ({
  variables: async () => [{ file: '.claude/settings.local.json', names }],
});
const gate = (facts: typeof FACTS | undefined, ...names: string[]) =>
  new LaunchGate({ source: source(facts), folderSettings: folderWith(...names) });

describe('LaunchGate.decide', () => {
  it('should refuse a folder that sets a key the login leaves to the secret store, naming the file and the key', async () => {
    const answer = await gate(FACTS, 'ANTHROPIC_API_KEY').decide(input());

    should(answer.allow).be.false();
    should((answer as { reason: string }).reason).containEql('.claude/settings.local.json');
    should((answer as { reason: string }).reason).containEql('ANTHROPIC_API_KEY');
  });

  it('should refuse a folder that sets a key the login takes from a bare $OTHER reference', async () => {
    should((await gate(FACTS, 'OTHER_KEY').decide(input())).allow).be.false();
  });

  it('should refuse, with the reason, a folder whose repository layout cannot be proved', async () => {
    const answer = await new LaunchGate({
      source: source(FACTS),
      folderSettings: {
        variables: async () => {
          throw new FolderSettingsUnreadableError('the launch folder /work/a cannot be resolved');
        },
      },
    }).decide(input());

    should(answer.allow).be.false();
    should((answer as { reason: string }).reason).containEql('cannot be resolved');
  });

  it('should refuse when the published runtimes cannot be read', async () => {
    const answer = await new LaunchGate({
      source: {
        facts: async () => {
          throw new Error('damaged');
        },
      },
      folderSettings: folderWith(),
    }).decide(input());

    should(answer.allow).be.false();
    should((answer as { reason: string }).reason).containEql('could not be read');
  });

  it('should let an error that is not a folder refusal fail the decision (the kernel reads a throw as no)', async () => {
    const decide = new LaunchGate({
      source: source(FACTS),
      folderSettings: {
        variables: async () => {
          throw new Error('boom');
        },
      },
    }).decide;

    await should(decide(input())).be.rejectedWith('boom');
  });

  it('should allow a clean folder, a start on another harness, one on no runtime and one on an unpublished runtime', async () => {
    const decide = gate(FACTS, 'UNRELATED').decide;
    const nothing = gate(undefined, 'ANTHROPIC_API_KEY').decide;

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
      folderSettings: folderWith(),
    }).decide(input({ harness: 'codex', compactAt: 200_000 }));

    should(answer.allow).be.false();
    should(refusal(answer)).containEql('compaction trigger cannot be checked');
  });
});

describe('LaunchGate.parts', () => {
  it('should be a required source, so Ferrets refuses a launch it cannot answer', () => {
    should(gate(FACTS).parts.required).be.true();
  });

  it('should contribute the login’s literal environment as one pin part for a Claude launch it checked', async () => {
    const launch = gate(FACTS);
    await launch.decide(input());

    should(await launch.parts.parts(spec())).deepEqual([{ kind: 'pin', env: FACTS.pins }]);
  });

  it('should contribute the login’s compaction trigger as a compact part', async () => {
    const launch = gate({ ...FACTS, compactAt: 200_000 } as never);
    await launch.decide(input());

    should(await launch.parts.parts(spec())).deepEqual([
      { kind: 'pin', env: FACTS.pins },
      { kind: 'compact', at: 200_000 },
    ]);
  });

  it('should read the facts ONCE: the pins written are the ones the folder was judged against', async () => {
    let reads = 0;
    const launch = new LaunchGate({
      source: {
        facts: async () => {
          reads += 1;
          // A second read would find the fixed settings gone: a login that pins nothing.
          if (reads > 1) return { ...FACTS, pins: {} };
          return FACTS;
        },
      },
      folderSettings: folderWith(),
    });
    await launch.decide(input());

    should(await launch.parts.parts(spec())).deepEqual([{ kind: 'pin', env: FACTS.pins }]);
    should(reads).equal(1);
  });

  it('should refuse a launch no decision checked, rather than launch without the pins', async () => {
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

  it('should contribute nothing for an unpublished runtime, a Codex runtime or no pins, once checked', async () => {
    const unpublished = gate(undefined);
    const codex = gate({ ...FACTS, kind: 'codex' as never });
    const bare = gate({ ...FACTS, pins: {} as never });
    for (const launch of [unpublished, codex, bare]) await launch.decide(input());

    should(await unpublished.parts.parts(spec())).deepEqual([]);
    should(await codex.parts.parts(spec())).deepEqual([]);
    should(await bare.parts.parts(spec())).deepEqual([]);
  });
});
