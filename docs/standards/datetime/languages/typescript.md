---
id: datetime-typescript
title: Date/Time in TypeScript
---

# Date/Time in TypeScript

The types, the choice between them, and the pitfalls live in
[Date/Time Handling](../index.md). This page is the implementation guide.

## Library: Temporal

The built-in `Date` cannot express most of the types the doctrine requires. It has no date-only
type, no time-only type, no duration type, no timezone-aware type, a 0-indexed month, and mutable
semantics. Every one of those is a bug waiting to be written.

**Temporal is the prescribed replacement.** Bun 1.3.x does not expose `Temporal` natively yet
(`globalThis.Temporal` is `undefined`), so use the polyfill until it does:

```bash
cd packages/<pkg> && bun add @js-temporal/polyfill
```

```typescript
import { Temporal } from '@js-temporal/polyfill';
```

Install from **inside** the package directory. Running `bun add` at the repository root creates a
root `node_modules` that shadows the workspace packages and breaks their tooling.

> **Not yet a dependency.** Nothing in the CLI handles dates today, so the polyfill is not
> installed. Add it in the same change that introduces the first date/time-handling code — and
> when Bun ships `Temporal` natively, the migration is deleting the import, because the polyfill
> implements the same API.

Do not reach for Moment (deprecated by its own authors), and prefer Temporal over date-fns or
Luxon: those improve the ergonomics of `Date` but do not give you real date-only, time-only, or
duration _types_, which is the part the doctrine depends on.

## Types

### Instant

A point on the global timeline, in UTC.

```typescript
// Now
const now = Temporal.Now.instant();

// From an ISO string
const instant = Temporal.Instant.from('2024-03-15T14:30:00Z');

// From epoch milliseconds (e.g. a legacy value)
const fromEpoch = Temporal.Instant.fromEpochMilliseconds(1710510600000);

// Back to a string — always ISO 8601 UTC, which is the storage format
instant.toString(); // '2024-03-15T14:30:00Z'

// Arithmetic
const later = instant.add({ hours: 2 });

// Comparison
const other = Temporal.Instant.from('2024-03-15T15:00:00Z');
instant.equals(other); // false
Temporal.Instant.compare(instant, other); // -1 | 0 | 1
```

`Temporal.Instant.compare` is the comparator to hand to `Array.prototype.sort`. Do not sort
instants by subtracting them.

### PlainDate

A calendar date. No time, no timezone — so nothing can shift it.

```typescript
const date = Temporal.PlainDate.from('2024-03-15');
const explicit = new Temporal.PlainDate(2024, 3, 15); // month is 1-indexed, unlike Date

date.year; // 2024
date.month; // 3
date.day; // 15
date.dayOfWeek; // 5 (Friday; 1 = Monday)

const tomorrow = date.add({ days: 1 });
const lastMonth = date.subtract({ months: 1 });

// Difference, as a Duration
const diff = date.until(Temporal.PlainDate.from('2024-04-20'));
```

### PlainTime

A time of day. No date, no timezone.

```typescript
const time = Temporal.PlainTime.from('14:30:00');
const explicit = new Temporal.PlainTime(14, 30, 0);

time.hour; // 14
time.minute; // 30

const later = time.add({ hours: 2 });
const floored = time.round({ smallestUnit: 'minute', roundingMode: 'floor' });
```

### PlainDateTime

Date and time, with no timezone. Useful as an intermediate value; ambiguous as a stored one.

```typescript
const dt = Temporal.PlainDateTime.from('2024-03-15T14:30:00');

// Compose from the two halves
const combined = Temporal.PlainDate.from('2024-03-15').toPlainDateTime(Temporal.PlainTime.from('14:30:00'));
```

### ZonedDateTime

Date, time, and timezone. The only type that can answer "what will the clock say there".

```typescript
// Now, in a specific zone
const now = Temporal.Now.zonedDateTimeISO('Asia/Singapore');

// Re-zone (the same instant, a different clock reading)
const inLondon = now.withTimeZone('Europe/London');

// Down to an instant, for storage
const instant = now.toInstant();

// Up from an instant, for display
const zoned = Temporal.Instant.from('2024-03-15T14:30:00Z').toZonedDateTimeISO('Asia/Singapore');
```

`ZonedDateTime` is where DST is handled correctly: `add({ days: 1 })` on a zoned value keeps the
wall-clock time, while `add({ hours: 24 })` adds exactly 24 hours. Both are available, and you
have to choose — which is the point.

### Duration

An amount of time.

```typescript
const d = Temporal.Duration.from({ hours: 2, minutes: 30 });
const parsed = Temporal.Duration.from('PT2H30M'); // ISO 8601 duration

d.hours; // 2
d.minutes; // 30

const doubled = d.add(d);
const back = d.negated();

// Applied to an instant
const deadline = Temporal.Now.instant().add(d);

// Elapsed time between two instants
const elapsed = Temporal.Instant.from('2024-03-15T10:00:00Z').until(Temporal.Instant.from('2024-03-15T14:30:00Z')); // PT4H30M
```

`Duration` fields are not normalized across units by default — a duration of 90 minutes reports
`minutes === 90`, not `hours === 1`. Use `total({ unit })` when a single number is wanted, and
`round({ largestUnit })` when a normalized duration is:

```typescript
d.total({ unit: 'minutes' }); // 150
d.round({ largestUnit: 'hour' }); // PT2H30M
```

## The Clock Port

Domain code must never read the ambient clock — `src/lib/` is pure by contract, and
`Temporal.Now` is exactly the kind of ambient state that makes tests non-deterministic. The clock
is a port, implemented by an adapter, injected through `CliWorld`.

```typescript
// src/lib/clock.ts — the port lives with the domain that depends on it
export interface IClock {
  /** The current point on the global timeline. */
  now(): Temporal.Instant;
  /** Today's calendar date in the given zone. */
  today(timeZone: string): Temporal.PlainDate;
}
```

```typescript
// src/adapters/system/clock.ts — the only place Temporal.Now is called
import { Temporal } from '@js-temporal/polyfill';
import type { IClock } from '../../lib/clock';

export class SystemClock implements IClock {
  now(): Temporal.Instant {
    return Temporal.Now.instant();
  }

  today(timeZone: string): Temporal.PlainDate {
    return Temporal.Now.plainDateISO(timeZone);
  }
}
```

```typescript
// tests — a fake clock, deterministic and steerable
export class FakeClock implements IClock {
  constructor(private instant: Temporal.Instant) {}

  now(): Temporal.Instant {
    return this.instant;
  }

  today(timeZone: string): Temporal.PlainDate {
    return this.instant.toZonedDateTimeISO(timeZone).toPlainDate();
  }

  advance(duration: Temporal.DurationLike): void {
    this.instant = this.instant.add(duration);
  }
}
```

```typescript
it('should mark the session expired once the deadline passes', () => {
  // Arrange
  const clock = new FakeClock(Temporal.Instant.from('2024-03-15T14:30:00Z'));
  const subject = new Session(clock, Temporal.Duration.from({ minutes: 30 }));

  // Act
  clock.advance({ minutes: 31 });

  // Assert
  should(subject.hasExpired()).be.true();
});
```

The test is instant and it will still pass in five years. A test that slept for 31 minutes, or
that compared against the real clock, would be neither.

Register the adapter alongside the other ports:

```typescript
export interface CliWorld {
  readonly io: ICliIo;
  readonly clock: IClock;
  // ...
}
```

## Best Practices

### Store instants, display zoned

```typescript
// Store: an instant, serialized as ISO 8601 UTC
const createdAt = clock.now();
await store.save({ createdAt: createdAt.toString() }); // '2024-03-15T14:30:00Z'

// Display: converted at the point of rendering, never before
const shown = createdAt.toZonedDateTimeISO(viewerTimeZone);
io.success(shown.toString());
```

### Use PlainDate for dates

```typescript
const birthday = Temporal.PlainDate.from('1990-03-15');

// largestUnit is required to get years — the default unit is days
const age = birthday.until(clock.today('Asia/Singapore'), { largestUnit: 'year' }).years;
```

### Use Duration for timeouts

```typescript
const TIMEOUT = Temporal.Duration.from({ seconds: 30 });
const deadline = clock.now().add(TIMEOUT);

// For APIs that need milliseconds (setTimeout, AbortSignal), convert at the edge
setTimeout(cancel, TIMEOUT.total({ unit: 'milliseconds' }));
```

Keep the `Duration` as the domain representation and convert to a number only where a platform
API demands one. The conversion belongs at that call site, not in a shared constant.

### Never `new Date()` in new code

```typescript
// WRONG - 0-indexed month, mutable, no date-only type, ambient timezone
const d = new Date(2024, 2, 15);

// RIGHT
const d = Temporal.PlainDate.from('2024-03-15');
```

`Date` remains unavoidable at some boundaries — `fs` stat results, HTTP headers, third-party
libraries. Convert at that boundary and keep `Date` out of the domain:

```typescript
const instant = Temporal.Instant.fromEpochMilliseconds(legacyDate.getTime());
const legacy = new Date(instant.epochMilliseconds);
```

## Serialization

Every Temporal type round-trips through its own ISO 8601 string, which is exactly the storage
format the doctrine calls for. Each type implements `toJSON()`, so writing is automatic:

```typescript
// Out — toJSON() emits the ISO string for each value
const json = JSON.stringify({
  at: clock.now(), // '2024-03-15T14:30:00Z'
  due: Temporal.PlainDate.from('2024-03-20'), // '2024-03-20'
  every: Temporal.Duration.from({ hours: 6 }), // 'PT6H'
});

// In — never automatic. Reconstruct with the type you meant.
const raw = JSON.parse(json);
const at = Temporal.Instant.from(raw.at);
const due = Temporal.PlainDate.from(raw.due);
const every = Temporal.Duration.from(raw.every);
```

Reading is the asymmetric half and the one that bites: `JSON.parse` hands back strings, and
nothing checks that the string you got is the type you expected. `Temporal.Instant.from` will
happily reject a `'2024-03-20'`, but a field that _should_ be a `PlainDate` and was written as an
`Instant` deserializes without complaint into the wrong precision. Parse persisted date/time
fields through a schema for the same reason external input goes through one — see
[Parsing at the Boundary](#parsing-at-the-boundary) below.

Where a field's serialized format is load-bearing (a filename, a sort key, a wire contract), call
`.toString()` explicitly rather than relying on `toJSON`, so the format is visible at the call
site.

## Parsing at the Boundary

External input arrives as a string, so date parsing is a schema concern. Validate the ISO shape
with Zod, then construct the Temporal type from the parsed value — see
[Validation in TypeScript](../../validation/languages/typescript.md).

```typescript
import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';

// The canonical IANA zone list. Excludes the legacy abbreviation zones and is case-sensitive.
const ZONES = new Set(Intl.supportedValuesOf('timeZone'));

function isIanaTimeZone(value: string): boolean {
  return ZONES.has(value);
}

const ScheduleArgsSchema = z.strictObject({
  due: z.iso.date().transform(s => Temporal.PlainDate.from(s)),
  every: z.iso.duration().transform(s => Temporal.Duration.from(s)),
  timeZone: z.string().refine(isIanaTimeZone, 'must be an IANA timezone identifier'),
});

type ScheduleArgs = z.infer<typeof ScheduleArgsSchema>;
// { due: Temporal.PlainDate; every: Temporal.Duration; timeZone: string }
```

The `transform` is what makes this a parse rather than a validate: the controller hands the domain
a `PlainDate`, so no downstream function can be given the string.

Reject timezone abbreviations here, at the only place that can. By the time the value reaches the
domain, the chance to say so is gone.

Check membership in `Intl.supportedValuesOf('timeZone')` rather than "does a formatter accept it".
A formatter is more permissive than the doctrine: `Intl.DateTimeFormat` constructs happily for
`'EST'` and `'+08:00'` — both are legal tz-database entries with fixed offsets, and neither
follows DST, which is precisely the bug the rule exists to prevent. The canonical list excludes
them.

## Formatting

Formatting is display, and display happens at the edge — never in `src/lib/`.

```typescript
import { Intl, Temporal } from '@js-temporal/polyfill';

const instant = Temporal.Instant.from('2024-03-15T14:30:00Z');
const timeZone = 'Asia/Singapore';

// Reuse a formatter when formatting many values — construction is the expensive part
const formatter = new Intl.DateTimeFormat('en-SG', {
  timeZone,
  dateStyle: 'medium',
  timeStyle: 'short',
});
formatter.format(instant);

// One-off: toLocaleString is simpler
instant.toLocaleString('en-SG', { timeZone, dateStyle: 'medium', timeStyle: 'short' });
```

Import `Intl` from the polyfill, not the global one — the global `Intl.DateTimeFormat` does not
accept Temporal objects.

Two rules for terminal output specifically:

- **Pass the timezone explicitly.** Defaulting to the host's zone makes output depend on the
  machine, which makes it untestable and inconsistent between an operator and a CI log.
- **Machine-readable output stays ISO.** `--json` and any parseable format emit `.toString()`;
  locale formatting is for prose output only.

## Related Articles

- [Date/Time Handling](../index.md) — the doctrine these snippets implement
- [Data Validation](../../validation/index.md) — parsing date, time, and duration inputs
- [Validation in TypeScript](../../validation/languages/typescript.md) — the schema boundary above
- [Testing in TypeScript](../../testing/languages/typescript.md) — doubles, including the fake clock
- [Stateless OOP and Dependency Injection](../../stateless-oop-di/index.md) — why the clock is a port
