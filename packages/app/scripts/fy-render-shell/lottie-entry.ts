/**
 * The Lottie half of the sandbox shell's trusted library bundle.
 *
 * THE IMPORT SPECIFIER IS A SECURITY DECISION, not a size optimisation. The
 * package's default build registers an expression evaluator, which compiles the
 * `"x"` strings carried inside an animation into running JavaScript — that is,
 * it turns author DATA back into author CODE, which is the one thing this slice
 * exists to prevent. `lottie_light` ships the same player with the evaluator
 * absent: the `getExpressionsPlugin()` hook remains, nothing ever registers a
 * plugin into it, and the build contains no `new Function` at all.
 *
 * The grammar independently refuses a STRING-valued `"x"` key at any depth, and
 * an array containing one at any index (`src/lib/fy-render.ts`) — not every `x`,
 * because the format overloads that key onto bezier easing handles and
 * separated-dimension positions, which are numbers and objects rather than
 * source text. An expression is always source text, so the two refusals overlap
 * exactly where it matters and neither is a single point of failure: the parser
 * could gain a gap, and a dependency bump could quietly restore the evaluator.
 * `build-fy-render-libs.ts` fails the build if this bundle regains a dynamic
 * code primitive.
 *
 * Bundled, never imported by the application — see `mermaid-entry.ts`.
 */
// @ts-expect-error — the light build ships no type declaration under this exact
// path. Only `loadAnimation` is used, and the shell narrows what it calls.
import lottie from 'lottie-web/build/player/esm/lottie_light.min.js';

(globalThis as unknown as Record<string, unknown>).__fyRenderLottie = lottie;
