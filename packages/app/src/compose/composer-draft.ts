/**
 * THE DRAFT A `composer.tools` PANEL WRITES TO. Conversation's composer wraps its `<PanelSlot slot="composer.tools">`
 * in {@link ComposerDraftProvider}; a panel contributed there by another plugin (Voice's dictation, Runtimes' picker)
 * reads the live draft and hands back the next one through {@link useComposerDraft}, without importing Conversation.
 * Outside a composer the binding is `null` and such a panel draws nothing.
 */
import { createContext, createElement, type ReactNode, useContext } from 'react';

/** What the `composer.tools` slot's host (Conversation's composer) hands a panel. */
export interface ComposerDraftBinding {
  /** The live draft, read at insert time so text typed during the flow is kept. */
  readonly draft: string;
  /** The textarea's caret, when it has one. */
  readonly selectionRef?: {
    readonly current: { readonly selectionStart: number; readonly selectionEnd: number } | null;
  };
  /** Receives the COMPLETE next draft and where the caret should sit. */
  readonly onDraftChange: (result: { readonly text: string; readonly caret: number }) => void;
  /** The conversation this page already shows, oldest first. */
  readonly readConversation?: () => readonly string[];
  /** The ferret whose composer this is. */
  readonly ferretId?: string;
  readonly composerRef?: { current: HTMLElement | null };
  /** Whether the composer takes input right now (sending, or the host disabled it): a tool draws itself disabled. */
  readonly disabled?: boolean;
}

const ComposerDraftContext = createContext<ComposerDraftBinding | null>(null);

export function ComposerDraftProvider({
  binding,
  children,
}: {
  readonly binding: ComposerDraftBinding;
  readonly children?: ReactNode;
}) {
  return createElement(ComposerDraftContext.Provider, { value: binding }, children);
}

/** The binding of the composer this panel sits in, or `null` outside one. */
export function useComposerDraft(): ComposerDraftBinding | null {
  return useContext(ComposerDraftContext);
}
