import { type MouseEvent, type ReactNode, type RefObject, useRef, useState } from 'react';
import { useInputModality } from '../hooks/use-input-modality.ts';
import { type ContextMenuEventLike, textContextMenuEventAllowed } from '../lib/context-menu-policy.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import { quoteSelectionIntoComposer } from '../lib/quote.ts';
import { ContextMenu, type ContextMenuItem } from '../shell/context-menu.tsx';

/** The selection surface needed to decide whether prose is quotable. */
export interface QuoteSelectionLike {
  readonly isCollapsed: boolean;
  readonly rangeCount: number;
  readonly anchorNode: Node | null;
  readonly focusNode: Node | null;
  toString(): string;
}

/**
 * Returns a trimmed selection, or an empty string when the browser selection belongs to another surface. Either
 * endpoint inside is enough: a reader may extend a range from text just above the visible surface.
 */
export const quotableTranscriptSelectionText = (
  selection: QuoteSelectionLike | null,
  contains: (node: Node | null) => boolean,
): string => {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return '';
  if (!contains(selection.anchorNode) && !contains(selection.focusNode)) return '';
  return selection.toString().trim();
};

/** What a surface spreads on the element whose text can be quoted. */
export interface QuoteSurfaceHandlers {
  readonly onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  readonly onPointerDownCapture: (event: { readonly pointerType?: string }) => void;
  readonly onTouchStartCapture: () => void;
}

/**
 * "Quote in composer" for any surface of prose: the chat's transcript and the open agenda item share this one
 * implementation. Selecting text and opening the context menu offers the quote; a phone's long-press is the
 * native selection gesture and is left alone. The quote goes to the composer of `scope` only.
 */
export function useQuoteMenu(
  rootRef: RefObject<HTMLElement | null>,
  scope: DaemonSessionScope | null,
): { readonly handlers: QuoteSurfaceHandlers; readonly menu: ReactNode } {
  const lastPointerType = useRef<string | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState<{ readonly x: number; readonly y: number; readonly text: string } | null>(null);
  const { touchAffected } = useInputModality();

  const onContextMenu = (event: MouseEvent<HTMLElement>): void => {
    const root = rootRef.current;
    if (scope === null || root === null) return;
    const selection = typeof window === 'undefined' ? null : window.getSelection();
    const text = quotableTranscriptSelectionText(
      selection as QuoteSelectionLike | null,
      node => node !== null && root.contains(node),
    );
    const allowed = textContextMenuEventAllowed(event.nativeEvent as ContextMenuEventLike, {
      lastPointerType: lastPointerType.current,
      touchAffected,
      hasSelection: text.length > 0,
    });
    // A phone's long-press is the native text-selection gesture. Leaving this event alone preserves its
    // handles and copy menu; session-row long-press handling remains separate in row-context-gesture.ts.
    if (!allowed || !text) return;
    event.preventDefault();
    trigger.current = event.currentTarget;
    setOpen({ x: event.clientX, y: event.clientY, text });
  };

  const items: readonly ContextMenuItem[] =
    open === null || scope === null
      ? []
      : [{ key: 'quote', label: 'Quote in composer', onSelect: () => quoteSelectionIntoComposer(open.text, scope) }];

  return {
    handlers: {
      onContextMenu,
      onPointerDownCapture: event => {
        lastPointerType.current = event.pointerType || 'unknown';
      },
      // Some WebKit paths expose the later contextmenu as a plain MouseEvent. This is the touch press that
      // began its long-press.
      onTouchStartCapture: () => {
        lastPointerType.current = 'touch';
      },
    },
    menu: (
      <ContextMenu
        anchor={open ?? { x: 0, y: 0 }}
        ariaLabel="Quote menu"
        items={items}
        onClose={() => setOpen(null)}
        open={open !== null}
        touch={touchAffected}
        triggerRef={trigger}
      />
    ),
  };
}
