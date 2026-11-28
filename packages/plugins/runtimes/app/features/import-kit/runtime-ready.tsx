/**
 * "<Tool> is ready": the LAST page of a harness segment (Claude Code's and Codex's first-run steps), which says what the
 * person's pick ended with: the runtime that tool now has, or why it has none and how to add one later. Nothing is written
 * here: a runtime is DERIVED from a ready login at read time (`GET /v1/runtimes`), so this page only reads it, afresh on
 * every visit (the sign-in and the import just before it are what made it).
 *
 *   - ready: at least one runtime of this harness can start now: it is named, with the way to use it. A runtime on the
 *     person's own terminal sign-in (`store: host`) is never called "ready": Ferretry cannot see that sign-in, so the page says
 *     it USES it. When the sign-in step handled nothing, or the runtime cannot start, it says once that no sign-in was found
 *     and to sign in in a terminal before starting a ferret (the same words on both pages).
 *   - blocked: a runtime exists but cannot start: the daemon's own reason, and where to fix it (a terminal sign-in: see above).
 *   - none: no runtime exists: the sign-in was skipped or did not finish, and where to add one later.
 *   - a read that fails says so with Try again; Next still goes on (Later is never held).
 *
 * The page names the tool by the label its plugin hands it (never a list of its own), so a third harness needs no edit here.
 */
import { Button, StepDemo } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { Check, Minus } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { CredentialStoreSchema, runtimeDisplayName } from '../../../contract/index.ts';
import { StepActions, StepBody, StepLine } from './step-parts.tsx';

/** The fields of a runtime this page reads (the catalog row is wider; a field not named here is not used). */
const RuntimeRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  harness: z.string().min(1),
  /** Set when the owner typed the name (`runtimeDisplayName`). */
  namedByOwner: z.literal(true).optional(),
  /** The login the runtime is made from: the page matches the login the step just handled on this. */
  credential: z.object({ id: z.string().min(1), store: CredentialStoreSchema, label: z.string().min(1).optional() }),
  /** The profile and the login's provider, which tell two runtimes on one login apart in words. */
  profile: z.string().min(1).optional(),
  models: z.object({ catalog: z.object({ label: z.string().min(1) }) }).optional(),
  launch: z.discriminatedUnion('available', [
    z.object({ available: z.literal(true) }),
    z.object({ available: z.literal(false), reason: z.string().min(1) }),
  ]),
});
const RuntimeListSchema = z.object({ runtimes: z.array(RuntimeRowSchema) });
export type ReadyRuntime = z.infer<typeof RuntimeRowSchema>;

/** What one tool ended with. */
export type ReadyState =
  | { readonly kind: 'ready'; readonly names: readonly string[]; readonly terminal: boolean }
  | { readonly kind: 'blocked'; readonly name: string; readonly reason: string; readonly terminal: boolean }
  | { readonly kind: 'none' };

/**
 * The state of one tool from the machine's runtimes: those that can start now win, then one that cannot, else none. With the
 * login the sign-in step handled (`login`), only THAT login's runtimes count: another ready login of the same tool must not
 * hide a blocked or missing runtime for the one just signed in. Without it (a sign-in that was skipped, or a reload that
 * dropped the run's memory) every runtime of the tool counts.
 */
export function readyStateOf(runtimes: readonly ReadyRuntime[], harness: string, login?: string): ReadyState {
  const mine = runtimes.filter(
    runtime => runtime.harness === harness && (login === undefined || runtime.credential.id === login),
  );
  // Named the way every other screen names a runtime ("Claude · your terminal sign-in"), never by its stored name.
  const startable = mine.filter(runtime => runtime.launch.available);
  const names = startable.map(runtime => runtimeDisplayName(runtime, mine));
  if (names.length > 0)
    return { kind: 'ready', names, terminal: startable.every(runtime => runtime.credential.store === 'host') };
  const [first] = mine;
  if (first !== undefined && !first.launch.available)
    return {
      kind: 'blocked',
      name: runtimeDisplayName(first, mine),
      reason: first.launch.reason,
      terminal: first.credential.store === 'host',
    };
  return { kind: 'none' };
}

type Read =
  | { readonly kind: 'reading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'done'; readonly state: ReadyState };

/** The segment-memory key a tool's sign-in page writes (`step.remember({ [SIGNED_LOGIN_KEY]: id })`) and this page reads. */
export const SIGNED_LOGIN_KEY = 'signedLogin';

const SIGN_IN_LATER = 'Sign in any time in Settings › Logins, and a runtime appears by itself.';

/**
 * The picture in the frame's second track (a wide window leaves it empty without one): the runtime picker a ferret starts
 * from, with this tool's answer in it: a tick and the runtime's name when one can start, a dash and why not when one cannot,
 * a dashed empty row when none was made. Decorative (`aria-hidden`): the words are on the page itself.
 */
function ReadyPreview({
  state,
  label,
  good,
}: {
  readonly state: ReadyState;
  readonly label: string;
  readonly good: boolean;
}): ReactNode {
  const Mark = good ? Check : Minus;
  // One row, whatever the count: the frame's box holds a short picture (a stacked one is cut at 140px), and the page lists them all.
  const row =
    state.kind === 'ready'
      ? {
          name:
            state.names.length > 1
              ? `${state.names[0] ?? ''} · +${String(state.names.length - 1)}\u00a0more`
              : (state.names[0] ?? ''),
          state: good ? 'on' : 'off',
        }
      : state.kind === 'blocked'
        ? { name: state.name, state: 'off' }
        : { name: `No ${label} runtime yet`, state: 'none' };
  return (
    <StepDemo>
      <div className="ob-ready-demo" aria-hidden="true" data-ready-demo={state.kind}>
        <p className="ob-ready-demo__head">Start a ferret on</p>
        <p className="ob-ready-demo__row" data-state={row.state}>
          {row.state === 'none' ? null : <Mark size={16} strokeWidth={3} className="shrink-0" />}
          <span>{row.name}</span>
        </p>
      </div>
    </StepDemo>
  );
}

export function RuntimeReadyPage({
  client,
  harness,
  label,
  step,
}: {
  readonly client: Pick<PluginClient, 'call'>;
  /** The harness key the runtimes are matched on (`claude-code`, `codex`). */
  readonly harness: string;
  /** What the tool is called on screen. */
  readonly label: string;
  readonly step?: StepHost | undefined;
}): ReactNode {
  const [read, setRead] = useState<Read>({ kind: 'reading' });
  const host = useRef(step);
  host.current = step;
  const signedLogin = step?.segment[SIGNED_LOGIN_KEY];
  const login = typeof signedLogin === 'string' && signedLogin !== '' ? signedLogin : undefined;
  const look = useCallback((): void => {
    setRead({ kind: 'reading' });
    client.call('GET /v1/runtimes', { quiet: true }).then(
      answer => {
        const parsed = RuntimeListSchema.safeParse(answer);
        setRead(
          parsed.success
            ? { kind: 'done', state: readyStateOf(parsed.data.runtimes, harness, login) }
            : { kind: 'failed' },
        );
        host.current?.ready();
      },
      () => {
        setRead({ kind: 'failed' });
        host.current?.ready();
      },
    );
  }, [client, harness, login]);
  useEffect(() => {
    look();
  }, [look]);

  if (read.kind === 'reading') return null;
  if (read.kind === 'failed')
    return (
      <StepBody step={`${harness}.ready`} data-runtime-ready="unread">
        <StepLine role="alert">{`Ferretry could not read the runtimes on this machine, so it cannot say whether ${label} has one.`}</StepLine>
        <StepActions>
          <Button onClick={look}>Try again</Button>
        </StepActions>
        <StepLine>You can go on: runtimes are listed in Settings › Runtimes.</StepLine>
      </StepBody>
    );
  const { state } = read;
  // One wording for "no sign-in found" on the two pages that can reach it: Claude's (the sign-in step handled nothing) and a
  // Codex one that cannot start. Said once, with the one thing to do.
  const noSignIn =
    (state.kind === 'ready' && state.terminal && login === undefined) || (state.kind === 'blocked' && state.terminal);
  // A terminal sign-in Ferretry never saw is a check only when this run's sign-in step handled it.
  const good = state.kind === 'ready' && (!state.terminal || login !== undefined);
  const Mark = good ? Check : Minus;
  return (
    <StepBody step={`${harness}.ready`} data-runtime-ready={state.kind}>
      <ReadyPreview state={state} label={label} good={good} />
      <p className="ob-ready" role="status" data-ready-headline="">
        <span className="ob-ready__mark" data-mark={good ? 'done' : 'none'} aria-hidden="true">
          <Mark size={16} strokeWidth={3} />
        </span>
        <span>
          {noSignIn
            ? `No ${label} sign-in was found on this machine`
            : state.kind === 'ready'
              ? state.terminal
                ? `${label} uses your terminal sign-in`
                : `${label} is ready`
              : state.kind === 'blocked'
                ? `${label} has a runtime, but it cannot start yet`
                : `No runtime was made for ${label}`}
        </span>
      </p>
      {state.kind === 'ready' ? (
        <>
          <StepLine data-ready-names="">
            {state.names.length === 1 ? `Runtime: ${state.names[0] ?? ''}.` : `Runtimes: ${state.names.join(', ')}.`}
          </StepLine>
          {noSignIn ? (
            <StepLine data-ready-terminal="">{`Sign in to ${label} in a terminal before you start a ferret.`}</StepLine>
          ) : (
            <StepLine>Pick it when you start a ferret.</StepLine>
          )}
        </>
      ) : state.kind === 'blocked' ? (
        noSignIn ? (
          <>
            <StepLine data-ready-names="">{`Runtime: ${state.name}.`}</StepLine>
            <StepLine data-ready-reason="">{state.reason}</StepLine>
            <StepLine data-ready-terminal="">{`Sign in to ${label} in a terminal before you start a ferret.`}</StepLine>
          </>
        ) : (
          <>
            <StepLine data-ready-names="">{`Runtime: ${state.name}. ${state.reason}`}</StepLine>
            <StepLine>Fix it in Settings › Logins, and it can start.</StepLine>
          </>
        )
      ) : (
        <>
          <StepLine>{`Signing in to ${label} was skipped or did not finish, so nothing can start on it yet.`}</StepLine>
          <StepLine data-ready-later="">{SIGN_IN_LATER}</StepLine>
        </>
      )}
    </StepBody>
  );
}
