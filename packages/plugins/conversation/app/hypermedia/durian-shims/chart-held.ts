/**
 * DURIAN'S CHART READER, AS THE BUNDLE HOLDS IT: absent (r12 H8 fix, review item 1).
 *
 * Durian reads a ```chart fence by evaluating its `let` formulas at parse time (`core/chart.ts`, `core/expr.ts`), work no size
 * cap on our side bounds. r12 H4 therefore holds EVERY chart fence as code before Durian reads it (`held-fences.tsx`), and the
 * evaluator is never reached. Never reached is not the same as not shipped: the parser imports it, so a build that only
 * promised not to call it still carried ~9 KB gzip of evaluator in every first load. `vite-durian.ts` resolves the two imports
 * the parser makes (`./chart`, `./chart-llm`) to THIS file instead, so the expression engine is not in the bundle at all, and
 * a chart that somehow reached the parser would throw (Durian turns a throw into a problem on that part, which is not drawn)
 * rather than run.
 *
 * The names are the ones the parser and its checker import from the two modules. Nothing here is used by a build that does not
 * go through the plugin (a Bun test reads Durian's own source, where the real evaluator is the one the H4 tests prove is
 * never reached).
 */

const held = (): never => {
  throw new Error('a chart is held as code in a message: Durian does not evaluate it');
};

export const chartControls = held;
export const evalChart = held;
export const chartMeta = held;
export const chartCheck = held;
export const chartTable = held;
export const CHART_KINDS: readonly string[] = [];
export const CHART_KEYS: readonly string[] = [];
export const SERIES_KEYS: readonly string[] = [];
