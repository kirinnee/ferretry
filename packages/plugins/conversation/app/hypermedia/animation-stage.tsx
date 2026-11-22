/**
 * THE ANIMATION ENGINE'S CHUNK (r12 H8 fix): the one module `animation-engine.ts` imports dynamically. Durian's 2D stage, its
 * scene compiler and what they share live behind this import and in no first load. In a Vite build the compiler's module also
 * registers itself with the parser's door (`durian-shims/scene-late.ts`) when this chunk evaluates, which is why the engine is
 * "ready" exactly when this import resolves. The 3D stage stays its own, later, chunk (Durian imports it with `import()`).
 */
export { AnimationPart as AnimationStage } from 'durian-hypermedia/react/strict';
