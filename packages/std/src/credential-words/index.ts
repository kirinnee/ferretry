/**
 * The credential-word rules, owned once: the WORD CUTTER (which part of a command-line word a read may not show) and
 * the WRITE RULE (W: which words a file may not be written with). The kernel's config read mask and Runtimes' views both
 * import this, so a word W refuses is a word the mask cuts by construction, and each consumer runs W on what it is about
 * to show as a fail-closed net.
 */
export * from './words.ts';
export * from './write-rule.ts';
