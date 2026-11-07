/** The teaching a ferret that is instructed to learn carries. Short on purpose: it is in every prompt (docs/lessons.md). */
export const LESSONS_INSTRUCTION = (fy: string): string =>
  `Lessons: when the owner corrects you or you learn a lasting preference of theirs, file one imperative rule: \`${fy} lesson suggest "<rule>" --scope global|repo\` (or lessons_suggest); global = every ferret, repo = this project. File each once.`;
