import type { AnimationBlock } from 'durian-hypermedia';
import type { ComponentType } from 'react';

/**
 * THE 2D ANIMATION ENGINE'S DOOR (r12 H8 fix, lead decision on size): Durian's scene compiler and its 2D stage are ~36 KB gzip,
 * and a message almost never holds an animation, so they are one lazy chunk (`animation-stage.tsx`) fetched when a message has
 * one, not part of every first load.
 *
 * The parser is synchronous, so the compiler must be here BEFORE a message with an animation is parsed. Until it is, the
 * message is read with that fence held as code (`held-fences.tsx`): the reader sees the animation's source at once, never a
 * blank and never an error, and the message is read again, now drawing the animation, the moment the engine arrives
 * ({@link onAnimationEngine} wakes every message that is showing one). A message with no animation never asks for the chunk.
 */

type Stage = ComponentType<{ readonly block: AnimationBlock }>;

let stage: Stage | undefined;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

/** Whether the engine has arrived: a message read now compiles its animation fences. */
export const animationEngineReady = (): boolean => stage !== undefined;

/** The 2D stage Durian draws an animation with, once the engine has arrived. */
export const animationStage = (): Stage | undefined => stage;

/** Fetch the engine (once; a failed fetch may be asked for again by the next message that needs it). */
export function loadAnimationEngine(): Promise<void> {
  loading ??= import('./animation-stage.tsx').then(
    module => {
      stage = module.AnimationStage;
      for (const listener of [...listeners]) listener();
    },
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
}

/** Called when the engine arrives. */
export function onAnimationEngine(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
