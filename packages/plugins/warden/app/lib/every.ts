/** Runs `run` every `ms` until the answer is called: the one repeating timer this half's polls wait on. */
export const every = (run: () => void, ms: number): (() => void) => {
  const timer = setInterval(run, ms);
  return () => clearInterval(timer);
};
