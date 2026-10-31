/**
 * Small pieces the catalog sheets and the Catalogs panel share: the sheet frame, the Sharing-off
 * explanation and one failure line. Plain words, one idea per line.
 */

import { CircleAlert, Lock } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { Button } from '../../shell/primitives.tsx';
import { SHARING_GRANT_COMMAND, SHARING_OFF_LINES, SHARING_OFF_TITLE } from './catalogs-model.ts';

/** A titled bottom sheet whose body scrolls. */
export function CatalogSheet({
  name,
  title,
  subtitle,
  closeLabel,
  onClose,
  children,
}: {
  readonly name: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const titleId = useId();
  return (
    <BottomSheet
      id={`catalog-${name}-${titleId.replace(/:/gu, '')}`}
      open
      onClose={onClose}
      labelledBy={titleId}
      closeLabel={closeLabel}
      maxHeight="min(92dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))"
      panelClassName="mx-auto max-w-[720px]"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-sm overflow-y-auto p-panel" data-catalog-sheet={name}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id={titleId} className="m-0 break-words text-row font-semibold text-fg">
            {title}
          </h3>
          {subtitle === undefined ? null : <p className="m-0 break-words text-meta text-muted">{subtitle}</p>}
        </div>
        {children}
      </div>
    </BottomSheet>
  );
}

/** Says Sharing is off for this device, and the one command that turns it on. */
export function SharingOffPanel() {
  return (
    <section
      className="flex min-w-0 flex-col gap-xs rounded-control border border-warn-border bg-warn-bg p-control-x py-2 text-warn"
      role="status"
      data-sharing-off=""
    >
      <h4 className="m-0 flex items-center gap-2 text-cell font-semibold">
        <Lock size={16} aria-hidden="true" />
        {SHARING_OFF_TITLE}
      </h4>
      {SHARING_OFF_LINES.map(line => (
        <p key={line} className="m-0 text-cell">
          {line}
        </p>
      ))}
      <code className="block break-all rounded-control bg-surface-2 p-xs font-mono text-2xs text-fg">
        {SHARING_GRANT_COMMAND}
      </code>
    </section>
  );
}

/** One failure, in words, with an icon. `again` adds the button that reads the source again. */
export function FailureLine({
  sentence,
  again,
  onAgain,
  againLabel = 'Preview again',
}: {
  readonly sentence: string;
  readonly again?: boolean;
  readonly onAgain?: () => void;
  readonly againLabel?: string;
}) {
  return (
    <div
      className="flex min-w-0 flex-col items-start gap-xs rounded-control border border-err-border bg-err-bg p-control-x py-2 text-err"
      role="alert"
      data-catalog-failure=""
    >
      <p className="m-0 flex items-start gap-2 break-words text-cell">
        <CircleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
        {sentence}
      </p>
      {again === true && onAgain !== undefined ? (
        <Button type="button" size="sm" onClick={onAgain} data-catalog-preview-again="">
          {againLabel}
        </Button>
      ) : null}
    </div>
  );
}
