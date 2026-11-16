import { type ArgSpec, type FlagSpec, flag } from '../args.ts';
import type { Plan, PlanContext, Scope, VerbSpec } from '../plan.ts';
import type { Parsed } from '../args.ts';

/** The ferret a person acts on: `--ferret`, and `-s` / `--session` as before. */
const FERRET_FLAG = { ferret: flag.text('ferret', 'session', 's') } as const;

type Flags = Readonly<Record<string, FlagSpec>>;
type Builder = (words: Parsed, context: PlanContext) => Plan | Promise<Plan>;

const verb =
  (scope: Scope, takesFerret: boolean) =>
  (args: readonly ArgSpec[], flags: Flags, plan: Builder): VerbSpec => ({
    scope,
    shape: { args, flags: takesFerret ? { ...FERRET_FLAG, ...flags } : flags },
    plan,
  });

/** A verb on a ferret's pages: as the ferret this runs inside, or as a person with `--ferret <id>`. */
export const onPages = verb('page', true);
/** A verb on a ferret's whole browser, through the per-ferret route. */
export const onBrowser = verb('whole', true);
/** A verb that is only a person's act on a ferret they name. */
export const byPerson = verb('person', true);
/** A verb on the machine's browser: it takes no ferret. */
export const onMachine = verb('machine', false);
/** A verb that asks nothing of the daemon. */
export const onThisHost = verb('local', false);

export const PAGE: ArgSpec = { name: 'page name' };
export const TARGET: ArgSpec = { name: 'target' };
