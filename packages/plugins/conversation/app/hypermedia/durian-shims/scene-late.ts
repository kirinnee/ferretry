/**
 * DURIAN'S SCENE COMPILER, REACHED THROUGH A DOOR THAT OPENS WHEN THE ANIMATION ARRIVES (r12 H8 fix, lead decision on size).
 *
 * Durian's parser compiles an animation fence's scene while it parses (`core/dh-lib.ts` `animOf`, `document.ts`), and the
 * compiler is ~23 KB gzip of the 36 KB the 2D animation costs a first load, for a message that almost never has one. The parser
 * stays eager and synchronous; `vite-durian.ts` resolves the scene import the PARSER makes to this module, and the real
 * compiler stays in the animation's own chunk (the 2D stage imports it from there). That chunk, once loaded, registers the
 * compiler here (`bindScene`, appended to the compiler's own module by the plugin), and a message with an animation is parsed
 * only after that (`animation-engine.ts`: until then its fence is shown as code, so nothing is lost and nothing throws).
 *
 * A build that does not go through the plugin (Bun's own bundler, `bun test`) never imports this file: Durian reads its own
 * compiler there and the gate's "ready" simply follows the chunk's load.
 */

interface Scene {
  readonly compileScene: (...args: readonly unknown[]) => unknown;
  readonly sceneLlm: (...args: readonly unknown[]) => unknown;
  readonly KINDS: readonly string[];
}

let bound: Scene | undefined;

/** What the animation's chunk registers when it evaluates. */
export function bindScene(scene: Scene): void {
  bound = scene;
  KINDS = scene.KINDS;
}

const scene = (): Scene => {
  if (bound === undefined) throw new Error('an animation was read before its engine arrived');
  return bound;
};

export const compileScene = (...args: readonly unknown[]): unknown => scene().compileScene(...args);
export const sceneLlm = (...args: readonly unknown[]): unknown => scene().sceneLlm(...args);
/** A live binding: empty until the engine is here. Durian re-exports it for its checker, which a message never runs. */
export let KINDS: readonly string[] = [];
