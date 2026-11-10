import { createContext, useContext } from 'react';

/**
 * The frame's root element, for anything that must be drawn ABOVE every plugin overlay (the shell's machine picker,
 * S10). A plugin's own sheet is a `fixed` overlay inside its screen's subtree; a picker drawn there, or after it in
 * normal flow, would open under that sheet's scrim and outside its focus trap. `null` until the frame has mounted, and
 * where no frame is drawn (a plugin's own suite): callers fall back to `document.body`.
 */
export const FrameRootContext = createContext<HTMLElement | null>(null);

export function useFrameRoot(): HTMLElement {
  return useContext(FrameRootContext) ?? document.body;
}
