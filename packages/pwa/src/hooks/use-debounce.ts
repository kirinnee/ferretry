import { useEffect, useRef, type EffectCallback } from 'react';

/** Runs the current effect once its dependencies have remained unchanged for `ms`. */
export function useDebouncedEffect(effect: EffectCallback, deps: readonly unknown[], ms: number): void {
  const effectRef = useRef(effect);
  effectRef.current = effect;

  useEffect(() => {
    const timer = setTimeout(() => effectRef.current(), ms);
    return () => clearTimeout(timer);
    // biome-ignore lint/correctness/useExhaustiveDependencies: the caller controls the dynamic dependency list.
  }, [...deps, ms]);
}
