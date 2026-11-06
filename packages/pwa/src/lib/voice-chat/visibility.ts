/**
 * WHETHER THE PAGE IS ON SCREEN, for Live: a hidden tab or a locked screen pauses it (the browser
 * cancels a recognition session in a hidden tab anyway, `browser-recognition.ts`).
 */

import type { VisibilityPort } from './ports.ts';

export interface VisibilityDocumentLike {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export function documentVisibility(doc: VisibilityDocumentLike): VisibilityPort {
  const visible = (): boolean => doc.visibilityState !== 'hidden';
  return {
    visible,
    watch: onChange => {
      const listener = (): void => onChange(visible());
      doc.addEventListener('visibilitychange', listener);
      return () => doc.removeEventListener('visibilitychange', listener);
    },
  };
}
