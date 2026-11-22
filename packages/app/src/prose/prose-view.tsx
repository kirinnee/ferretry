import { type ComponentType, Suspense, useMemo, useSyncExternalStore } from 'react';
import type { Standing } from '../client/inventory.ts';
import { registeredProseProvider } from '../connect/provides.ts';
import { useReferenceSurface } from '../references/reference-surface.tsx';
import { useOptionalShell } from '../shell/context.tsx';
import { useViewPlace } from '../shell/view-place.tsx';
import { Markdown, type MarkdownProps } from './markdown.tsx';

const noSubscription = (): (() => void) => () => {};

/** What a surface hands the prose view: the text, and the few ways a surface may shape how it is drawn. */
export type ProseProps = Pick<MarkdownProps, 'text' | 'className' | 'copyable' | 'demoteHeadings'>;

/** What Conversation provides as `ShellProvides.prose`: a view of {@link ProseProps}, which may suspend while it loads. */
export type ProseProvision = ComponentType<ProseProps>;

/**
 * THE ONE VIEW OF A FERRET'S TEXT FOR A SURFACE THAT IS NOT CONVERSATION'S (the agenda). How agent-written text is
 * drawn — Durian hypermedia: parts, tabs, charts, our references — is Conversation's to say, and an app half cannot
 * import another's files, so Conversation provides it to the shell (`shell.prose`) and this draws it. While that view
 * loads, or when it may not draw (this machine's daemon has Conversation off or blocked, there is no machine, or this is
 * not a shell), the text is drawn as the shell's own Markdown, references read through the surface this place has: a card never shows nothing, and never shows a part as
 * code that then jumps.
 */
export function ProseView(props: ProseProps) {
  const runtime = useOptionalShell()?.runtime;
  const daemon = useViewPlace()?.daemon;
  // A shell that holds no registry of surfaces (a bare test shell) registers no provider: the Markdown fallback draws.
  const surfaces = runtime?.surfaces;
  const provider = useMemo(() => (surfaces === undefined ? undefined : registeredProseProvider(surfaces)), [surfaces]);
  // Registered is not allowed: Conversation's half is compiled in even where this machine's daemon has turned it off or
  // blocked it, so its view draws only when that machine's standing for it is `allowed`. On a screen with no machine
  // nothing can say it is on, and the shell's own Markdown draws.
  const read = (): Standing['state'] | undefined =>
    runtime === undefined || provider === undefined || daemon === undefined
      ? undefined
      : runtime.standing(daemon, provider.plugin).state;
  const standing = useSyncExternalStore(runtime?.subscribe ?? noSubscription, read, read);
  const Provided = standing === 'allowed' ? provider?.prose : undefined;
  const plain = <PlainProse {...props} />;
  return Provided === undefined ? (
    plain
  ) : (
    <Suspense fallback={plain}>
      <Provided {...props} />
    </Suspense>
  );
}

function PlainProse({ text, className, copyable, demoteHeadings }: ProseProps) {
  return (
    <Markdown
      text={text}
      className={className}
      copyable={copyable}
      demoteHeadings={demoteHeadings}
      {...useReferenceSurface()}
    />
  );
}
