/**
 * Copy buttons for Markdown code, on the surfaces that ask for them (an attention card's steps).
 *
 * A fence gets one button at its corner; an inline code span gets a small one beside it. A span inside a
 * fence is already covered by the fence's button, so the fence provides `InsideFence` and the span checks it.
 */

import { createContext, type ReactNode, useContext } from 'react';
import { type ClipboardWriter, CopyButton } from '../features/onboarding/copy-button.tsx';

const InsideFence = createContext(false);

export function CopyableFence({
  text,
  write,
  children,
}: {
  readonly text: string;
  readonly write: ClipboardWriter;
  readonly children: ReactNode;
}) {
  return (
    <div className="md-copy-fence relative" data-md-copy="fence">
      <InsideFence.Provider value={true}>{children}</InsideFence.Provider>
      <span className="md-copy-fence-button absolute right-1 top-1">
        <CopyButton text={text} label="Copy command" write={write} />
      </span>
    </div>
  );
}

export function CopyableSpan({
  text,
  write,
  children,
}: {
  readonly text: string;
  readonly write: ClipboardWriter;
  readonly children: ReactNode;
}) {
  const inside = useContext(InsideFence);
  if (inside) return <>{children}</>;
  return (
    <span className="md-copy-span inline-flex items-center gap-1 align-baseline" data-md-copy="span">
      {children}
      <CopyButton text={text} label="Copy command" write={write} />
    </span>
  );
}
