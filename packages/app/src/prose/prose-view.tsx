import { type ComponentType, Suspense, useMemo } from 'react';
import { registeredProse } from '../connect/provides.ts';
import { useReferenceSurface } from '../references/reference-surface.tsx';
import { useOptionalShell } from '../shell/context.tsx';
import { Markdown, type MarkdownProps } from './markdown.tsx';

/** What a surface hands the prose view: the text, and the few ways a surface may shape how it is drawn. */
export type ProseProps = Pick<MarkdownProps, 'text' | 'className' | 'copyable' | 'demoteHeadings'>;

/** What Conversation provides as `ShellProvides.prose`: a view of {@link ProseProps}, which may suspend while it loads. */
export type ProseProvision = ComponentType<ProseProps>;

/**
 * THE ONE VIEW OF A FERRET'S TEXT FOR A SURFACE THAT IS NOT CONVERSATION'S (the agenda). How agent-written text is
 * drawn — Durian hypermedia: parts, tabs, charts, our references — is Conversation's to say, and an app half cannot
 * import another's files, so Conversation provides it to the shell (`shell.prose`) and this draws it. While that view
 * loads, or when no one provides it (Conversation is off, or this is not a shell), the text is drawn as the shell's own
 * Markdown, references read through the surface this place has: a card never shows nothing, and never shows a part as
 * code that then jumps.
 */
export function ProseView(props: ProseProps) {
  const surfaces = useOptionalShell()?.runtime.surfaces;
  const Provided = useMemo(() => (surfaces === undefined ? undefined : registeredProse(surfaces)), [surfaces]);
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
