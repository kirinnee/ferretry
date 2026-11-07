/** Deterministic bounded backoff used by callers that choose to retry a failed tmux operation. */
export function retryDelays(attempts: number, initialMs = 100, maximumMs = 1_000): readonly number[] {
  if (!Number.isSafeInteger(attempts) || attempts < 0) throw new RangeError('attempts must be a non-negative integer');
  if (!Number.isFinite(initialMs) || initialMs < 0 || !Number.isFinite(maximumMs) || maximumMs < initialMs)
    throw new RangeError('retry delays must be non-negative and ordered');
  return Array.from({ length: attempts }, (_unused, index) => Math.min(maximumMs, initialMs * 2 ** index));
}
