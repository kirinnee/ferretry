/** A duration a person reads at a glance: `850 ms`, `4.2 s`, `38 s`, `3 m 20 s`, `1 h 05 m`. */
export function formatDuration(ms: number): string {
  const whole = Math.max(0, Math.round(ms));
  if (whole < 1_000) return `${whole} ms`;
  const seconds = whole / 1_000;
  if (seconds < 10) return `${(Math.round(seconds * 10) / 10).toFixed(1)} s`;
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;
  if (total < 3_600) {
    const rest = total % 60;
    return rest === 0 ? `${Math.floor(total / 60)} m` : `${Math.floor(total / 60)} m ${rest} s`;
  }
  const minutes = Math.floor((total % 3_600) / 60);
  return `${Math.floor(total / 3_600)} h ${String(minutes).padStart(2, '0')} m`;
}
