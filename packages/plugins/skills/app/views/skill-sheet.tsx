/** A titled bottom sheet whose body scrolls, and one failure line: the frame every Skills sheet shares. */
import { BottomSheet, Button } from '@ferretry/app/ui';
import { CircleAlert } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { MarkedText } from './review-view.tsx';

export function SkillSheet({
  name,
  title,
  closeLabel,
  onClose,
  children,
}: {
  readonly name: string;
  readonly title: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const titleId = useId();
  return (
    <BottomSheet
      id={`skill-${name}-${titleId.replace(/:/gu, '')}`}
      open
      onClose={onClose}
      labelledBy={titleId}
      closeLabel={closeLabel}
      maxHeight="min(92dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))"
      panelClassName="mx-auto max-w-[720px]"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-sm overflow-y-auto p-panel" data-skill-sheet={name}>
        <h3 id={titleId} className="m-0 break-words text-row font-semibold text-fg">
          {title}
        </h3>
        {children}
      </div>
    </BottomSheet>
  );
}

/** One failure, in words, with an icon. `again` adds the button that reads the source again. */
export function FailureLine({
  sentence,
  onAgain,
  againLabel = 'Preview again',
}: {
  readonly sentence: string;
  readonly onAgain?: () => void;
  readonly againLabel?: string;
}) {
  return (
    <div
      className="flex min-w-0 flex-col items-start gap-xs rounded-control border border-err-border bg-err-bg p-control-x py-2 text-err"
      role="alert"
      data-skill-failure=""
    >
      <p className="m-0 flex items-start gap-2 break-words text-cell">
        <CircleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>
          <MarkedText text={sentence} />
        </span>
      </p>
      {onAgain === undefined ? null : (
        <Button type="button" size="sm" onClick={onAgain} data-skill-preview-again="">
          {againLabel}
        </Button>
      )}
    </div>
  );
}

/** A label over a value that wraps rather than overflows. */
export function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-b border-border-soft py-xs">
      <span className="text-meta font-semibold text-muted">{label}</span>
      <span className="min-w-0 break-words text-cell text-fg">{children}</span>
    </div>
  );
}
