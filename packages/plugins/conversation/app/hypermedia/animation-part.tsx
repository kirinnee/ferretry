import type { AnimationBlock } from 'durian-hypermedia';
import { AnimationPart } from 'durian-hypermedia/react/strict';
import { type ReactElement, useEffect, useRef, useState } from 'react';

/**
 * AN ANIMATION, WITH THE ONE GRAPHICS FAILURE DURIAN DOES NOT HANDLE. Durian's wrapper falls back to the flat (2D) stage
 * when WebGL is UNAVAILABLE and when the 3D module fails to import or start. It does not handle a context that is LOST
 * after it started (a tab backgrounded on a phone, a GPU reset, too many contexts open): the canvas goes blank and the
 * reader is stuck on it. Owner decision (!A588): a WebGL failure falls back to the flat view.
 *
 * `webglcontextlost` does not bubble, but a CAPTURING listener on an ancestor sees it, so one listener on this part's own
 * box catches the loss of the 3D canvas inside it. It then presses the part's own "show flat (2D)" toggle (the control a
 * reader would press), which unmounts the 3D stage and draws the flat one at the same step, and says so in one line.
 */
export function GuardedAnimation({ block }: { readonly block: AnimationBlock }): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const [lost, setLost] = useState(false);
  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const onLost = (event: Event): void => {
      if (!(event.target instanceof HTMLCanvasElement)) return;
      const toggle = element.querySelector<HTMLButtonElement>('button.scn-mode[aria-pressed="true"]');
      if (toggle === null) return;
      toggle.click();
      setLost(true);
    };
    element.addEventListener('webglcontextlost', onLost, true);
    return () => element.removeEventListener('webglcontextlost', onLost, true);
  }, []);
  return (
    <div data-fy-animation="" ref={box}>
      <AnimationPart block={block} />
      {lost ? (
        <p className="fy-hm-note" data-fy-webgl-lost="" role="status">
          The 3D view lost its graphics context, so this is the flat view.
        </p>
      ) : null}
    </div>
  );
}
