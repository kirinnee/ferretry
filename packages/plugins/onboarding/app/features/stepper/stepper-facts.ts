/**
 * READING THE FIVE FACTS, cheaply: one batch of reads, each through this machine's own client, each QUIET (a read
 * nobody asked for must never raise a passkey prompt). No timer: a batch runs when the page opens and again only when
 * the machine says a step changed (`OnboardingChanged`), the person comes back to it, or the machine locks or unlocks.
 *
 * EACH FACT SETTLES ON ITS OWN. A locked machine parks four of the five reads behind its unlock (they wait, quietly,
 * for as long as it stays locked), so the batch cannot wait for all of them: every fact reports the moment IT answers,
 * and a fact the machine refused for want of an unlock is `'locked'` (the step shows Unlock), never a guess. While the
 * machine is known to be locked the four parked reads are not even sent: they would only wait; the passkey read is the
 * one the daemon answers while locked, so it alone is.
 *
 * Each parser is strict about the one field it needs and blind to the rest, so a daemon that adds a field changes nothing
 * here, and one that answers something else gives `undefined` rather than a wrong `false`.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import type { StepperFact, StepperFacts } from './stepper-model.ts';

const PasskeysSchema = z.object({ passkeys: z.array(z.unknown()) });
const FileSchema = z.object({ exists: z.boolean(), text: z.string() });
const FerretsSchema = z.array(z.unknown());
const ProjectsSchema = z.array(z.unknown());
const StepsSchema = z.object({
  complete: z.boolean(),
});
const ArchivedSchema = z.object({ count: z.number() });

const NAME_LINE = /^name:/mu;

/** `401` is the machine wanting its unlock (`unlock_required`): the read is refused, not failed. */
const isLockedRefusal = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 401;

/**
 * The plugin is not there: `404` is an `off` plugin's unrouted path, and `plugin_paused` (status 0) is how the generated
 * client refuses, WITHOUT sending, a call to a paused plugin. Either way the question has no answer to give.
 */
const isAbsentPlugin = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 404 || code === 'plugin_paused';
};

/** What one read says as a fact: its answer, `'locked'` for an unlock refusal, `undefined` for any other failure. */
const settled = async (read: () => Promise<StepperFact>): Promise<StepperFact> => {
  try {
    return await read();
  } catch (error) {
    return isLockedRefusal(error) ? 'locked' : undefined;
  }
};

export type FactKey = keyof StepperFacts;

/**
 * Starts the batch and returns once every fact has settled. `onFact` hears each fact as it settles, in whatever order
 * they answer, and is never called after `signal` aborts (an abandoned batch says nothing).
 */
export const readStepperFacts = async (
  client: Pick<PluginClient, 'call'>,
  locked: boolean,
  signal: AbortSignal,
  onFact: (key: FactKey, fact: StepperFact) => void,
): Promise<void> => {
  const base = { quiet: true, signal } as const;
  const report = (key: FactKey, read: () => Promise<StepperFact>): Promise<void> =>
    settled(read).then(fact => {
      if (!signal.aborted) onFact(key, fact);
    });
  /** Any ferret ever made counts: the live list leaves out an archived one, so an empty live list asks the archive. One read per batch. */
  let used: Promise<boolean> | undefined;
  const inUse = (): Promise<boolean> =>
    (used ??= (async () => {
      if (FerretsSchema.parse(await client.call('GET /v1/ferrets', base)).length > 0) return true;
      const archived = await client.call('GET /v1/archived-sessions', { query: { limit: '1' }, ...base });
      return ArchivedSchema.parse(archived).count > 0;
    })());
  /** The machine says its setup is complete: every step the plugins declared has an answer, but a step that only shows something (a tool's Ready page) never counts. */
  const setupAnswered = async (): Promise<boolean> =>
    StepsSchema.parse(await client.call('GET /v1/onboarding', base)).complete;
  const protectedReads: readonly [FactKey, () => Promise<StepperFact>][] = [
    [
      'name',
      async () => {
        const host = FileSchema.parse(
          await client.call('GET /v1/config/file', { query: { path: 'host.yaml' }, ...base }),
        );
        return host.exists && NAME_LINE.test(host.text);
      },
    ],
    // Setup: every step the plugins declared for this machine (Claude Code, Codex, Warden, …) was answered, or this machine
    // already has a conversation (an established machine is not on its first run). One step here: the plugins' own steps
    // are the setup flow's, so the card names no plugin.
    ['setup', async () => (await setupAnswered()) || (await inUse())],
    // A project is registered, or the person already works projectless (any conversation ever made). A Projects plugin
    // that is off has registered nothing and holds no answer to wait for: the step then rests on the conversations alone,
    // so it stays readable (and finishable) with Projects paused.
    [
      'project',
      async () => {
        const registered = await client.call('GET /v1/projects', base).then(
          raw => ProjectsSchema.parse(raw).length > 0,
          (error: unknown) => {
            if (isAbsentPlugin(error)) return false;
            throw error;
          },
        );
        return registered || (await inUse());
      },
    ],
  ];
  await Promise.all([
    report('passkey', async () => {
      const { passkeys } = PasskeysSchema.parse(await client.call('GET /v1/passkeys', base));
      // A passkey that exists on a locked machine is a step still to do ("Unlock"), not a step done.
      return passkeys.length === 0 ? false : locked ? 'locked' : true;
    }),
    ...protectedReads.map(([key, read]) =>
      locked ? Promise.resolve(onLocked(signal, onFact, key)) : report(key, read),
    ),
  ]);
};

const onLocked = (signal: AbortSignal, onFact: (key: FactKey, fact: StepperFact) => void, key: FactKey): void => {
  if (!signal.aborted) onFact(key, 'locked');
};
