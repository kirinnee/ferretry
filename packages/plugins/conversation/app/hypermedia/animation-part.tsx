import type { AnimationBlock } from 'durian-markdown';
import { type ReactElement, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { animationStage } from './animation-engine.ts';
import { watchStageColours } from './stage-colours.ts';

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
  // The stage is the lazy engine's: a block exists only once the parser had the engine, so it is here whenever this draws.
  const Stage = animationStage();
  // The 3D stage's mixed colours, resolved to plain rgb for three.js (`stage-colours.ts`). A layout effect: it is done before
  // the stage's own module (a lazy chunk) is asked to draw, and so before it reads its colours the first time.
  useLayoutEffect(() => {
    const element = box.current;
    return element === null ? undefined : watchStageColours(element);
  }, []);
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
      {Stage === undefined ? null : <Stage block={block} />}
      {lost ? (
        <p className="fy-hm-note" data-fy-webgl-lost="" role="status">
          The 3D view lost its graphics context, so this is the flat view.
        </p>
      ) : null}
    </div>
  );
}
