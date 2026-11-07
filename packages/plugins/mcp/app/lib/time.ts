/** Humanised time until an instant ("12m", "3h", "2d"), `'now'` once it has passed, or `null` when there is nothing to say. */
export function timeUntil(iso: string | undefined, nowMs: number): string | null {
  if (iso === undefined) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const minutes = Math.round((at - nowMs) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  return `${String(Math.round(hours / 24))}d`;
}
