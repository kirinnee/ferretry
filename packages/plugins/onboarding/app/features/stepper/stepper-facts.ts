/**
 * READING THE SIX FACTS, cheaply: one pass of five reads, each through this machine's own client, each QUIET (a read
 * nobody asked for must never raise a passkey prompt; a refusal is simply "unknown"). No timer: the pass runs when the
 * page opens and again only when the machine says a step changed (`OnboardingChanged`) or the person comes back to it.
 *
 * Each parser is strict about the one field it needs and blind to the rest, so a daemon that adds a field changes nothing
 * here, and one that answers something else gives `undefined` rather than a wrong `false`.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import type { StepperFacts } from './stepper-model.ts';

const PasskeysSchema = z.object({ passkeys: z.array(z.unknown()) });
const FileSchema = z.object({ exists: z.boolean(), text: z.string() });
const LoginsSchema = z.object({ logins: z.array(z.unknown()) });
const SetUpSchema = z.object({ setUp: z.boolean() });
const FerretsSchema = z.array(z.unknown());

const NAME_LINE = /^name:/mu;

/** Runs a read and gives `undefined` for any failure: a refused, locked or unreachable read is not a `false`. */
const quietly = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await read();
  } catch {
    return undefined;
  }
};

/** `locked` joins the passkey fact: a passkey that exists but is not unlocked is a step still to do ("Unlock"). */
export const readStepperFacts = async (client: Pick<PluginClient, 'call'>, locked: boolean): Promise<StepperFacts> => {
  const quiet = { quiet: true } as const;
  const [passkeys, host, logins, onboarding, ferrets] = await Promise.all([
    quietly(async () => PasskeysSchema.parse(await client.call('GET /v1/passkeys', quiet))),
    quietly(async () =>
      FileSchema.parse(await client.call('GET /v1/config/file', { query: { path: 'host.yaml' }, ...quiet })),
    ),
    quietly(async () => LoginsSchema.parse(await client.call('GET /v1/logins', quiet))),
    quietly(async () => SetUpSchema.parse(await client.call('GET /v1/onboarding', quiet))),
    quietly(async () => FerretsSchema.parse(await client.call('GET /v1/ferrets', quiet))),
  ]);
  return {
    passkey: passkeys === undefined ? undefined : passkeys.passkeys.length > 0 && !locked,
    name: host === undefined ? undefined : host.exists && NAME_LINE.test(host.text),
    login: logins === undefined ? undefined : logins.logins.length > 0,
    runtime: onboarding === undefined ? undefined : onboarding.setUp,
    ferret: ferrets === undefined ? undefined : ferrets.length > 0,
  };
};
