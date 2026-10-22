/** `3.4s` under ten seconds, `42s` under a minute, then `2m05s` — enough precision to see it is moving. */
export function formatElapsed(milliseconds: number): string {
  const ms = Math.max(0, milliseconds);
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** What a step's clock reads: the elapsed time, or `12s of 60s` for a step that knows its length. */
export function formatClock(elapsedMs: number, expectedSeconds: number | undefined): string {
  if (expectedSeconds === undefined) return formatElapsed(elapsedMs);
  const elapsed = Math.min(Math.floor(Math.max(0, elapsedMs) / 1_000), expectedSeconds);
  return `${String(elapsed)}s of ${String(expectedSeconds)}s`;
}

/** The text of a step line without its marker or clock: `label — detail`. */
export function stepText(label: string, detail: string | undefined): string {
  return detail === undefined || detail === '' ? label : `${label} — ${detail}`;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'gu');

/** A tool's output line with escape sequences and control characters removed, so it is safe to print as detail. */
export function plainLine(text: string): string {
  return text
    .replaceAll(ANSI, '')
    .replaceAll('\t', ' ')
    .replaceAll(/\p{Cc}/gu, '')
    .trim();
}

/** Bytes in the unit a download reads in: whole megabytes while large, one decimal while small. */
export function formatMegabytes(bytes: number): string {
  const megabytes = bytes / 1_000_000;
  return megabytes < 10 ? megabytes.toFixed(1) : String(Math.round(megabytes));
}

/** `48/120 MB`, from two byte counts. */
export function formatByteProgress(done: number, expected: number): string {
  return `${formatMegabytes(done)}/${formatMegabytes(expected)} MB`;
}
