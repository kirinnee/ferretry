import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

/** Where the actions float: under the end of the selection, inside the scope. */
interface Floating<Found> {
  readonly found: Found;
  readonly x: number;
  readonly y: number;
}

/**
 * A region in which selecting text offers actions. `read` turns the live selection into what the region understands (or
 * nothing); the actions float under the selection's end in ONE state change, so the page draws once per selection. The
 * button keeps the selection when it is pressed (`mousedown` is not allowed to move focus), and the selection is read
 * again from the page when the action runs, never from a stale copy.
 */
export function SelectionScope<Found>({
  read,
  actions,
  children,
  name,
}: {
  readonly read: (root: HTMLElement, selection: Selection) => Found | undefined;
  readonly actions: (found: Found, done: () => void) => ReactNode;
  readonly children: ReactNode;
  readonly name: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [floating, setFloating] = useState<Floating<Found> | undefined>(undefined);

  const refresh = useCallback(() => {
    const element = root.current;
    const selection = element === null ? null : window.getSelection();
    if (element === null || selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
      setFloating(previous => (previous === undefined ? previous : undefined));
      return;
    }
    const found = read(element, selection);
    if (found === undefined) {
      setFloating(previous => (previous === undefined ? previous : undefined));
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const box = element.getBoundingClientRect();
    // In line with the START of the selection, never past a third of the region: the bar wraps inside what is left.
    const x = Math.max(0, Math.min(rect.left - box.left, box.width * 0.35));
    // ABOVE the selection: the region can end right under it, and a bar there would be cut off.
    const y = rect.top - box.top - 6;
    setFloating({ found, x, y });
  }, [read]);

  useEffect(() => {
    document.addEventListener('selectionchange', refresh);
    return () => document.removeEventListener('selectionchange', refresh);
  }, [refresh]);

  const done = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setFloating(undefined);
  }, []);

  return (
    <div className="relative min-w-0" data-selection-scope={name} ref={root}>
      {children}
      {floating !== undefined && (
        <div
          className="absolute z-10 flex flex-wrap gap-xs rounded-control border border-border-strong bg-surface p-xs shadow-sm"
          aria-label="Selection actions"
          data-selection-actions={name}
          // The press must not move the selection away from the text it is about.
          onMouseDown={event => event.preventDefault()}
          role="toolbar"
          style={{
            left: floating.x,
            top: floating.y,
            transform: 'translateY(-100%)',
            maxWidth: `calc(100% - ${String(floating.x)}px)`,
          }}
        >
          {actions(floating.found, done)}
        </div>
      )}
    </div>
  );
}
