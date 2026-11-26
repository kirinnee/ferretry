/**
 * DURIAN'S COMPOSED-STAGE COMPILER, AS THE WORKER HOLDS IT: absent (U1 of the DurianMarkdown swap, Durian 0.7.0).
 *
 * 0.7.0 compiles an animation's composed stage (lanes, cards, panels, a time block) while it parses: \`document.ts\` imports
 * \`core/stage\` and \`core/stage-part\`, which are ~16 modules and ~500 KB of source with the scene compiler under them, and the worker
 * is a chunk a phone downloads before it can read its first message. An \`animation\`, \`state\`, \`class\` or \`er\` fence is held as code
 * before Durian reads it (\`held-fence-parse.ts\`), so nothing reaches this compiler. \`vite-durian.ts\` resolves those two imports of
 * \`document.ts\`, and only those, to this module: a stage that somehow reached the parser would throw (Durian turns a throw into a
 * problem on that part, which is not drawn) rather than run unreviewed. The unit that draws animations puts the real one back.
 *
 * The names are the ones \`document.ts\` imports. A Bun test reads Durian's own source, where the real one is the one the held-fence
 * tests prove is never reached.
 */

const held = (): never => {
  throw new Error('an animation is held as code in a message: Durian does not compile its stage');
};

export const compileStage = held;
export const stageOf = held;
export const stageTexts = held;
export const stagePartJson = held;
export const stagePartLlm = held;
export const stagePartTexts = held;
export const stagePartCheck = held;
/** Called once for every page the parser reads; with no stage it has nothing to record. */
export const setStageRoles = (): void => undefined;
/** No part is a composed stage here: an animation never reaches the parser. */
export const isStagePart = (): boolean => false;
