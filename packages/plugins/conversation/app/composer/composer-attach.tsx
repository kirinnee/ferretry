/**
 * CONVERSATION'S OWN `composer.tools` PANEL (`panels.attachments`, order 10): the composer's attach entry — the ＋
 * that opens "photo, file, camera, location". The composer owns the entry's state (the hidden file inputs, the menu,
 * the tray), so it hands the drawn button to the slot through {@link ComposerAttachContext}; the panel draws whatever
 * the composer it sits in gave it, and nothing outside a composer.
 */
import { createContext, type ReactNode, useContext } from 'react';

export const ComposerAttachContext = createContext<ReactNode>(null);

/** The `attachments` panel body. */
export function ComposerAttachPanel(): ReactNode {
  return useContext(ComposerAttachContext);
}
