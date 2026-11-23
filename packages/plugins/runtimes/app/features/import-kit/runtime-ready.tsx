/**
 * "<Tool> is ready": the LAST page of a harness segment (Claude Code's and Codex's first-run steps), which says what the
 * person's pick ended with: the runtime that tool now has, or why it has none and how to add one later. Nothing is written
 * here: a runtime is DERIVED from a ready login at read time (`GET /v1/runtimes`), so this page only reads it, afresh on
 * every visit (the sign-in and the import just before it are what made it).
 *
 *   - ready: at least one runtime of this harness can start now: it is named, with the way to use it.
 *   - blocked: a runtime exists but cannot start: the daemon's own reason, and where to fix it.
 *   - none: no runtime exists: the sign-in was skipped or did not finish, and where to add one later.
 *   - a read that fails says so with Try again; Next still goes on (Later is never held).
 *
 * The page names the tool by the label its plugin hands it (never a list of its own), so a third harness needs no edit here.
 */
import { Button } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { Check, Minus } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { StepActions, StepBody, StepLine } from './step-parts.tsx';

/** The fields of a runtime this page reads (the catalog row is wider; a field not named here is not used). */
const RuntimeRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  harness: z.string().min(1),
  launch: z.discriminatedUnion('available', [
    z.object({ available: z.literal(true) }),
    z.object({ available: z.literal(false), reason: z.string().min(1) }),
  ]),
});
const RuntimeListSchema = z.object({ runtimes: z.array(RuntimeRowSchema) });
export type ReadyRuntime = z.infer<typeof RuntimeRowSchema>;

/** What one tool ended with. */
export type ReadyState =
  | { readonly kind: 'ready'; readonly names: readonly string[] }
  | { readonly kind: 'blocked'; readonly name: string; readonly reason: string }
  | { readonly kind: 'none' };

/** The state of one harness from the machine's runtimes: those that can start now win, then one that cannot, else none. */
export function readyStateOf(runtimes: readonly ReadyRuntime[], harness: string): ReadyState {
  const mine = runtimes.filter(runtime => runtime.harness === harness);
  const names = mine.filter(runtime => runtime.launch.available).map(runtime => runtime.name);
  if (names.length > 0) return { kind: 'ready', names };
  const [first] = mine;
  if (first !== undefined && !first.launch.available)
    return { kind: 'blocked', name: first.name, reason: first.launch.reason };
  return { kind: 'none' };
}

type Read =
  | { readonly kind: 'reading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'done'; readonly state: ReadyState };

const SIGN_IN_LATER = 'Sign in any time in Settings › Logins, and a runtime appears by itself.';

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
  const look = useCallback((): void => {
    setRead({ kind: 'reading' });
    client.call('GET /v1/runtimes', { quiet: true }).then(
      answer => {
        const parsed = RuntimeListSchema.safeParse(answer);
        setRead(
          parsed.success ? { kind: 'done', state: readyStateOf(parsed.data.runtimes, harness) } : { kind: 'failed' },
        );
        host.current?.ready();
      },
      () => {
        setRead({ kind: 'failed' });
        host.current?.ready();
      },
    );
  }, [client, harness]);
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
  const good = state.kind === 'ready';
  const Mark = good ? Check : Minus;
  return (
    <StepBody step={`${harness}.ready`} data-runtime-ready={state.kind}>
      <p className="ob-ready" role="status" data-ready-headline="">
        <span className="ob-ready__mark" data-mark={good ? 'done' : 'none'} aria-hidden="true">
          <Mark size={16} strokeWidth={3} />
        </span>
        <span>
          {state.kind === 'ready'
            ? `${label} is ready`
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
          <StepLine>Pick it when you start a ferret.</StepLine>
        </>
      ) : state.kind === 'blocked' ? (
        <>
          <StepLine data-ready-names="">{`Runtime: ${state.name}. ${state.reason}`}</StepLine>
          <StepLine>Fix it in Settings › Logins, and it can start.</StepLine>
        </>
      ) : (
        <>
          <StepLine>{`Signing in to ${label} was skipped or did not finish, so nothing can start on it yet.`}</StepLine>
          <StepLine data-ready-later="">{SIGN_IN_LATER}</StepLine>
        </>
      )}
    </StepBody>
  );
}
