import type { DurationStats, GaugeStats } from '@ferretry/protocol';

/**
 * How many durations a series keeps for its percentiles. Past it, the count, total and maximum stay
 * exact and the percentiles come from a fixed-size sample, so a route called a million times in a
 * window costs the same memory as one called a thousand.
 */
export const SERIES_SAMPLE_LIMIT = 2_048;

/** A set of durations, kept so its distribution can be reported. */
export class DurationSeries {
  #count = 0;
  #total = 0;
  #max = 0;
  readonly #kept: number[] = [];

  add(durationMs: number): void {
    const value = Math.max(0, durationMs);
    this.#count += 1;
    this.#total += value;
    this.#max = Math.max(this.#max, value);
    if (this.#kept.length < SERIES_SAMPLE_LIMIT) this.#kept.push(value);
    // Deterministic replacement rather than a random reservoir: a report must be reproducible from
    // the same inputs, and the order calls arrive in is already arbitrary enough to sample from.
    else this.#kept[this.#count % SERIES_SAMPLE_LIMIT] = value;
  }

  get count(): number {
    return this.#count;
  }

  stats(): DurationStats {
    const sorted = [...this.#kept].sort((a, b) => a - b);
    return {
      totalMs: round(this.#total),
      p50Ms: round(percentile(sorted, 0.5)),
      p95Ms: round(percentile(sorted, 0.95)),
      maxMs: round(this.#max),
    };
  }
}

/** The nearest-rank percentile of an ascending list; zero for an empty one. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank] ?? 0;
}

/** A gauge read several times through a window. */
export class GaugeSeries {
  #count = 0;
  #sum = 0;
  #min = Number.POSITIVE_INFINITY;
  #max = Number.NEGATIVE_INFINITY;

  add(value: number): void {
    this.#count += 1;
    this.#sum += value;
    this.#min = Math.min(this.#min, value);
    this.#max = Math.max(this.#max, value);
  }

  stats(): GaugeStats {
    if (this.#count === 0) return { min: 0, mean: 0, max: 0 };
    return { min: round(this.#min), mean: round(this.#sum / this.#count), max: round(this.#max) };
  }
}

/** Two decimals: enough to tell 0.04 ms from 0.4 ms, few enough to read. */
export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** `count` events over `windowMs`, per `unitMs`. */
export function rate(count: number, windowMs: number, unitMs: number): number {
  return windowMs <= 0 ? 0 : round((count * unitMs) / windowMs);
}
