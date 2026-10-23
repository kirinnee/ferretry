/**
 * What removing a login SAYS and offers — the pure half of `./remove-login-dialog.tsx`
 * (docs/account-model.md "Removing a login").
 *
 * The daemon decides what a removal does — it refuses a runtime left on the login, a switch to a login
 * that cannot drive the runtime, a default runtime that is going — and its dry run lists the ferrets
 * running on the runtimes. This module turns those answers, and what the browser already holds, into
 * the choices on screen and the one change they add up to. Nothing here reads a credential: a login is
 * its id, its scope and its status, never what signs it in.
 */

import type {
  FleetAccountChange,
  FleetAccountChangeView,
  FleetCredentialView,
  FleetMachineView,
  FleetRunningSession,
  FleetRuntimeView,
} from '@ferretry/protocol';
import { plural } from './credentials-model.ts';

/** What happens to one runtime that uses the login. */
export type RuntimeChoice = { readonly kind: 'switch'; readonly to: string } | { readonly kind: 'remove' };

/** The choice for each runtime, by runtime name. */
export type RuntimeChoices = Readonly<Record<string, RuntimeChoice>>;

/** The sentence under the title when nothing uses the login. */
const UNUSED_SENTENCE = 'Not used by any runtime.';

/** The words that tell the two ways of leaving a login apart. */
export const SIGN_OUT_VERSUS_REMOVE = 'Sign out keeps the login but it needs sign-in again. Remove deletes it.';

/** Every runtime on this machine that uses the login, in the order the catalogue lists them. */
export const runtimesOnLogin = (
  credential: FleetCredentialView,
  runtimes: readonly FleetRuntimeView[],
): readonly FleetRuntimeView[] => runtimes.filter(runtime => credential.usedBy.includes(runtime.name));

/** "Used by 2 runtimes: alpha, beta", or that nothing uses it. */
export const usedBySentence = (users: readonly FleetRuntimeView[]): string =>
  users.length === 0
    ? UNUSED_SENTENCE
    : `Used by ${plural(users.length, 'runtime')}: ${users.map(runtime => runtime.name).join(', ')}`;

const driven = (login: FleetCredentialView): readonly string[] => login.harnesses ?? [login.harness];

/**
 * The logins a runtime could move to: every other login that drives the runtime's CLI, the ones that
 * are signed in first because those launch at once. The daemon checks the same thing again.
 */
export const switchTargets = (
  removing: FleetCredentialView,
  runtime: FleetRuntimeView,
  credentials: readonly FleetCredentialView[],
): readonly FleetCredentialView[] => {
  const fits = credentials.filter(login => login.id !== removing.id && driven(login).includes(runtime.harness));
  return [
    ...fits.filter(login => login.status.word === 'ready'),
    ...fits.filter(login => login.status.word !== 'ready'),
  ];
};

/** Switch where a compatible login exists, else the only way left is to remove the runtime. */
export const initialChoices = (
  removing: FleetCredentialView,
  users: readonly FleetRuntimeView[],
  credentials: readonly FleetCredentialView[],
): RuntimeChoices =>
  Object.fromEntries(
    users.map((runtime): [string, RuntimeChoice] => {
      const first = switchTargets(removing, runtime, credentials)[0];
      return [runtime.name, first === undefined ? { kind: 'remove' } : { kind: 'switch', to: first.id }];
    }),
  );

const removedNames = (choices: RuntimeChoices): string[] =>
  Object.entries(choices)
    .filter(([, choice]) => choice.kind === 'remove')
    .map(([name]) => name);

/** The default runtime for new agents is among those the choices remove. */
export const removesDefault = (choices: RuntimeChoices, machine: FleetMachineView | null): boolean =>
  machine?.defaultRuntime !== undefined &&
  machine.defaultRuntime !== null &&
  removedNames(choices).includes(machine.defaultRuntime);

/** The agent runtimes that could be the new default: not one of those going. */
export const defaultChoices = (
  choices: RuntimeChoices,
  runtimes: readonly FleetRuntimeView[],
): readonly FleetRuntimeView[] => {
  const going = removedNames(choices);
  return runtimes.filter(runtime => runtime.agent && !going.includes(runtime.name));
};

/** The one change the choices add up to; `defaultRuntime` only when a removed runtime was the default. */
export const removeChange = (
  credential: FleetCredentialView,
  choices: RuntimeChoices,
  defaultRuntime: string | null,
): FleetAccountChange => {
  const switches = Object.entries(choices).flatMap(([name, choice]) =>
    choice.kind === 'switch' ? [[name, choice.to] as const] : [],
  );
  const removals = removedNames(choices);
  return {
    kind: 'credential.remove',
    id: credential.id,
    ...(switches.length === 0 ? {} : { switchRuntimes: Object.fromEntries(switches) }),
    ...(removals.length === 0 ? {} : { removeRuntimes: removals }),
    ...(defaultRuntime === null || removals.length === 0 ? {} : { defaultRuntime }),
  };
};

/** The ferrets from the dry run that run on a runtime the choices remove: the only ones that could be moved. */
export const ferretsOnRemoved = (
  staged: FleetAccountChangeView | null,
  choices: RuntimeChoices,
): readonly FleetRunningSession[] => {
  if (staged === null || staged.preview.kind !== 'apply') return [];
  const going = removedNames(choices);
  return (staged.preview.runningSessions ?? []).filter(
    session => session.runtime !== undefined && going.includes(session.runtime),
  );
};

/** How many ferrets the dry run found on the login's runtimes, whatever happens to those runtimes. */
export const ferretsOnLogin = (staged: FleetAccountChangeView | null): number =>
  staged === null || staged.preview.kind !== 'apply' ? 0 : (staged.preview.runningSessions ?? []).length;

/** The runtimes the ferrets on a removed runtime could move to: the ones that stay, and can launch. */
export const moveTargetsFor = (
  choices: RuntimeChoices,
  runtimes: readonly FleetRuntimeView[],
): readonly FleetRuntimeView[] => {
  const going = removedNames(choices);
  return runtimes.filter(runtime => !going.includes(runtime.name) && runtime.launch.available);
};

/** The confirm button: exactly what pressing it does. "Switch 2 runtimes to kirin-work and remove kirin-old". */
export const confirmLabel = (
  credential: FleetCredentialView,
  choices: RuntimeChoices,
  moving: { readonly count: number; readonly to: string | null },
  signOutFirst: boolean,
): string => {
  const entries = Object.values(choices);
  const switched = entries.flatMap(choice => (choice.kind === 'switch' ? [choice.to] : []));
  const removed = entries.length - switched.length;
  const targets = [...new Set(switched)];
  const parts: string[] = [];
  if (moving.to !== null && moving.count > 0) {
    parts.push(`move ${plural(moving.count, 'ferret')} to ${moving.to}`);
  }
  if (switched.length > 0) parts.push(`switch ${plural(switched.length, 'runtime')} to ${list(targets)}`);
  if (signOutFirst) parts.unshift('sign out');
  if (removed > 0) parts.push(`remove ${plural(removed, 'runtime')}`);
  parts.push(`remove ${credential.id}`);
  const sentence = list(parts);
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
};

const list = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : items.length === 2
      ? `${items[0]} and ${items[1]}`
      : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** The saved sign-in can be deleted alongside: only a login Ferretry keeps, that can be signed out. */
export const canSignOutFirst = (credential: FleetCredentialView): boolean =>
  credential.store === 'ferretry' && credential.signOut.available;

/** Said beside the sign-out choice, when ferrets are running on the login. */
export const signOutWarning = (ferrets: number): string | null =>
  ferrets === 0
    ? null
    : `${plural(ferrets, 'ferret')} running on it may ask to sign in again, because its sign-in is deleted.`;
