/**
 * What a runtime's login does to a Claude launch (#1587): a folder that would blank it is refused on `start.decide`,
 * and its literal environment is contributed as a `pin` launch part.
 */
import { describe, it } from 'bun:test';
import type { LaunchSpec, StartDecideInput } from '@ferretry/core-ferrets/contract';
import should from 'should';
import { FolderSettingsUnreadableError } from '../../../daemon/lib/folder-settings.ts';
import { launchPinParts, launchStartDecision, type RuntimeLaunchFactsSource } from '../../../daemon/lib/launch-gate.ts';

const FACTS = {
  runtime: 'work',
  kind: 'claude' as const,
  secretEnvNames: ['ANTHROPIC_API_KEY'],
  referencedEnv: ['OTHER_KEY'],
  pins: { ANTHROPIC_BASE_URL: 'https://gateway.invalid' },
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
const folderWith = (...names: string[]) => ({
  variables: async () => [{ file: '.claude/settings.local.json', names }],
});

describe('launchStartDecision', () => {
  it('should refuse a folder that sets a key the login leaves to the secret store, naming the file and the key', async () => {
    const decide = launchStartDecision({ source: source(FACTS), folderSettings: folderWith('ANTHROPIC_API_KEY') });

    const answer = await decide(input());

    should(answer.allow).be.false();
    should((answer as { reason: string }).reason).containEql('.claude/settings.local.json');
    should((answer as { reason: string }).reason).containEql('ANTHROPIC_API_KEY');
  });

  it('should refuse a folder that sets a key the login takes from a bare $OTHER reference', async () => {
    const decide = launchStartDecision({ source: source(FACTS), folderSettings: folderWith('OTHER_KEY') });

    should((await decide(input())).allow).be.false();
  });

  it('should refuse, with the reason, a folder whose repository layout cannot be proved', async () => {
    const decide = launchStartDecision({
      source: source(FACTS),
      folderSettings: {
        variables: async () => {
          throw new FolderSettingsUnreadableError('the launch folder /work/a cannot be resolved');
        },
      },
    });

    const answer = await decide(input());

    should(answer.allow).be.false();
    should((answer as { reason: string }).reason).containEql('cannot be resolved');
  });

  it('should refuse when the published runtimes cannot be read', async () => {
    const decide = launchStartDecision({
      source: {
        facts: async () => {
          throw new Error('damaged');
        },
      },
      folderSettings: folderWith(),
    });

    const answer = await decide(input());

    should(answer.allow).be.false();
    should((answer as { reason: string }).reason).containEql('could not be read');
  });

  it('should let an error that is not a folder refusal fail the decision (the kernel reads a throw as no)', async () => {
    const decide = launchStartDecision({
      source: source(FACTS),
      folderSettings: {
        variables: async () => {
          throw new Error('boom');
        },
      },
    });

    await should(decide(input())).be.rejectedWith('boom');
  });

  it('should allow a clean folder, a start on another harness, one on no runtime and one on an unpublished runtime', async () => {
    const decide = launchStartDecision({ source: source(FACTS), folderSettings: folderWith('UNRELATED') });
    const nothing = launchStartDecision({ source: source(undefined), folderSettings: folderWith('ANTHROPIC_API_KEY') });

    should((await decide(input())).allow).be.true();
    should((await decide(input({ harness: 'codex' }))).allow).be.true();
    should((await decide(input({ runtime: undefined }))).allow).be.true();
    should((await nothing(input())).allow).be.true();
  });
});

describe('launchPinParts', () => {
  const spec = (more: Partial<LaunchSpec> = {}): Omit<LaunchSpec, 'parts'> =>
    ({ harness: 'claude-code', runtime: 'work', ...more }) as unknown as Omit<LaunchSpec, 'parts'>;

  it('should contribute the login’s literal environment as one pin part for a Claude launch', async () => {
    should(await launchPinParts(source(FACTS)).parts(spec())).deepEqual([{ kind: 'pin', env: FACTS.pins }]);
  });

  it('should contribute nothing for another harness, no runtime, an unpublished runtime, a Codex runtime or no pins', async () => {
    const parts = launchPinParts(source(FACTS));

    should(await parts.parts(spec({ harness: 'codex' }))).deepEqual([]);
    should(await parts.parts(spec({ runtime: undefined }))).deepEqual([]);
    should(await launchPinParts(source(undefined)).parts(spec())).deepEqual([]);
    should(await launchPinParts(source({ ...FACTS, kind: 'codex' as never })).parts(spec())).deepEqual([]);
    should(await launchPinParts(source({ ...FACTS, pins: {} as never })).parts(spec())).deepEqual([]);
  });
});
