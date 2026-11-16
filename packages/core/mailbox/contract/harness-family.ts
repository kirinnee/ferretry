/**
 * Ferrets' harness key as the send policy and the transcript readers name the family: `claude-code` is `claude`. A
 * harness this build knows nothing about is NO family: it gets no inline paste and no transcript evidence, so nothing is
 * pasted whole or typed again on a guess.
 */
export const harnessFamily = (key: string): 'claude' | 'codex' | undefined =>
  key === 'claude-code' ? 'claude' : key === 'codex' ? 'codex' : undefined;
