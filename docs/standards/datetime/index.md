---
id: datetime
title: Date/Time Handling
---

# Date/Time Handling

Date and time handling is notoriously error-prone, and almost every bug traces back to the same
root cause: a value that does not say what it means. "A date" is at least six different things,
and picking the wrong one produces code that works in one timezone, in one half of the year.

This page defines the types, the choice between them, and the pitfalls. It builds on
[Domain-Driven Design](../domain-driven-design/index.md) and
[Software Design Philosophy](../software-design-philosophy/index.md) — choosing the right
date/time representation is domain modelling, not formatting.

> **No date/time library is vendored in this repository yet.** Nothing in the CLI handles dates
> today. The language guide names the prescribed choice for when that changes; the rules on this
> page are what that choice has to satisfy.

---

## Core Concepts

### Instant

A specific point on the global timeline. Instants are timezone-agnostic — they name the same
moment everywhere on Earth.

**Use for:**

- Timestamping events (`createdAt`, `updatedAt`, log lines)
- Auditing
- Scheduling a one-off future event
- Measuring elapsed time

**Example:** `2024-03-15T14:30:00Z` is the same instant in New York and in Tokyo.

### Date

A calendar date, with no time and no timezone. "What day on the calendar."

**Use for:**

- Birthdays
- Holidays
- Due dates where the time genuinely does not matter
- Reporting periods

**Example:** March 15, 2024 — with no associated time.

### Time

A time of day, with no date and no timezone. "What the clock reads."

**Use for:**

- Opening hours (opens at 09:00)
- Recurring daily schedules (digest at 07:00)
- Time-of-day rules (no deploys before 06:00)

**Example:** 14:30:00 — with no associated date.

### DateTime

A date and a time together. May be timezone-aware or timezone-naive.

**Warning:** A timezone-naive DateTime is ambiguous — it names a wall-clock reading without
saying whose clock. Prefer a timezone-aware type, or a Date/Time pair, and treat a naive
DateTime as an intermediate value only.

**Use for:**

- Events at a specific local time (March 15, 14:00 in Berlin)
- Scheduling that must respect a local context

### Offset

A fixed difference from UTC (`+05:00`, `-08:00`). Unlike a timezone, an offset does not change
with DST.

**Use for:**

- Recording an unambiguous past point in time
- Interoperating with systems that speak offsets

### Timezone

A region with rules for its UTC offset over time, including DST transitions. `America/New_York`,
`Europe/London`, `Asia/Singapore`.

**Use for:**

- Displaying a time in someone's local context
- Recurring events that must follow DST

**Warning:** Never store `EST` or `PST`. Those are offset abbreviations, not timezones — they
cannot express "New York, including whichever side of DST that date falls on". Store IANA
identifiers.

### Duration

An amount of time (2 hours, 30 minutes). Durations are timezone-independent.

**Use for:**

- Timeouts and deadlines
- Elapsed time
- Intervals ("every 15 minutes")

---

## When to Use Each Type

| Scenario                  | Type                | Why                                      |
| ------------------------- | ------------------- | ---------------------------------------- |
| `createdAt` timestamp     | Instant             | Unambiguous point in time                |
| A person's birthday       | Date                | No time component, same everywhere       |
| Daily digest time         | Time                | Recurs daily, has no date                |
| A meeting invitation      | DateTime + Timezone | A specific moment in a specific place    |
| "3 hours from now"        | Instant + Duration  | Computed from a point                    |
| Due date (end of day)     | Date                | The time does not matter                 |
| Request timeout           | Duration            | An amount, not a point                   |
| A process's start and end | Instant             | Precise moments, compared and subtracted |

The failure mode this table prevents is **over-precision**. An Instant where a Date belongs looks
harmless and then produces a birthday that changes date depending on who is looking at it.

---

## Choosing a Representation

The type depends on **what you are representing** and **where the value lives**.

| Use case              | What to store                           | Where it lives                                      | Why                                                               |
| --------------------- | --------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| **Birthday**          | `Date` (timezone separately, if at all) | On the entity                                       | A calendar date; timezone is at most context for "start of day"   |
| **Recurring alert**   | `Time` + `DayOfWeek` + `Timezone`       | Time/day on the schedule, **timezone on the owner** | When the owner relocates, the alert fires at the right local time |
| **Event timestamp**   | `Instant`                               | On the event                                        | A point in time: globally unambiguous and sortable                |
| **Scheduled meeting** | `DateTime` + `Timezone`                 | Both on the meeting                                 | A specific date and time at a specific place                      |

---

## Sortability

Every stored date/time value must sort chronologically as stored — whether the store is a
database, a JSON file, or a directory of records. If ordering requires parsing every value first,
the format is wrong.

| Type              | Storage format                                         | Sorts correctly       |
| ----------------- | ------------------------------------------------------ | --------------------- |
| `Instant`         | ISO 8601 in UTC, or an epoch integer                   | ✅ Yes                |
| `Date`            | `YYYY-MM-DD`                                           | ✅ Yes                |
| `Time`            | `HH:MM:SS`                                             | ✅ Yes (within a day) |
| `DateTime` + `TZ` | The instant (UTC) plus the timezone, stored separately | ✅ Yes                |

**Rule:** ISO 8601, zero-padded, UTC for instants. `15/03/2024`, `Mar 15 2024`, and a
locale-formatted string are display formats — they belong nowhere near a stored value.

**Corollary for zoned datetimes:** store the instant _and_ the timezone as two fields. Storing a
formatted local string loses the ability to sort; storing only the instant loses the location the
event was meant to happen in.

---

## Where the Timezone Belongs

This is a modelling decision, and getting it wrong produces bugs that only appear when someone
travels.

| Use case            | Timezone lives on      | Reasoning                                                                   |
| ------------------- | ---------------------- | --------------------------------------------------------------------------- |
| **Recurring alert** | The owner (user/host)  | Owner relocates → timezone updates once → every schedule follows            |
| **Meeting**         | The meeting            | The meeting is at a place; moving the attendee must not move the meeting    |
| **Birthday**        | The entity, or omitted | A calendar date; timezone is optional context for "when does the day start" |
| **Log / audit**     | Omitted — always UTC   | System events are global; there is no user context to respect               |

**Anti-pattern:** stamping a timezone onto every time value when the timezone should be inherited
from its owner. It works until the owner's timezone changes, at which point every stored value is
wrong and there is no single place to fix it.

**Illustrative shape — a recurring alert done right:**

```yaml
Owner {
  id: 'owner-123'
  timezone: 'Asia/Singapore' # ← the timezone lives here, once
}

Schedule {
  id: 'schedule-456'
  ownerId: 'owner-123'
  time: '07:00:00' # ← a Time. No timezone, no date.
  daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI']
}
```

When the owner moves to `Europe/London`, one field changes and every schedule adjusts. Had the
timezone been copied onto each `Schedule`, the same move would be a migration.

---

## Key Principles

1. **Match granularity to the use case.** Do not store an Instant where a Date will do.
2. **Put the timezone at the right level.** On the owner for recurring things, on the entity for
   fixed ones, omitted for system events.
3. **Store sortable.** ISO 8601, UTC, zero-padded.
4. **Separate storage from display.** Store the instant; convert at the moment of rendering, never
   before.
5. **Never read the ambient clock in domain code.** Take a clock as a dependency — that is what
   makes the behaviour testable. See [Testing Conventions](../testing/index.md).

---

## Common Pitfalls

### 1. The ambient clock

Reading the system clock inside domain logic makes the logic untestable and non-deterministic.

```typescript
// WRONG - reads the machine's clock and its local timezone
class Session {
  expire() {
    this.expiredAt = new Date(); // untestable, and locale-dependent
  }
}

// RIGHT - the clock is a dependency
class Session {
  constructor(private readonly clock: IClock) {}

  expire() {
    this.expiredAt = this.clock.now(); // an Instant, injectable, fakeable
  }
}
```

### 2. Local time where an instant was meant

```typescript
// WRONG - a local-time value whose meaning depends on the machine that made it
const createdAt = new Date();

// RIGHT - an explicit instant on the global timeline
const createdAt = clock.instant();
```

Two hosts in different timezones producing "the same" timestamp must produce the same value. If
they do not, the type was wrong.

### 3. DST transitions

Local wall-clock time is not a continuous line. When the clocks spring forward, 02:30 does not
exist that day; when they fall back, 02:30 happens twice.

```typescript
// WRONG - "same time tomorrow" via arithmetic on a UTC instant
const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
// Across a DST boundary this is 23:00 or 01:00 local, not the same wall-clock time.

// RIGHT - decide which one you meant, and say so
const sameInstantPlus24h = instant.add({ hours: 24 }); // exactly 24 hours later
const sameWallClockTomorrow = zoned.add({ days: 1 }); // 07:00 stays 07:00 locally
```

"A day" is 24 hours _or_ one calendar day, and they are not the same thing twice a year. Adding
`86_400_000` picks one silently; calendar arithmetic on a zoned value picks the other explicitly.

### 4. Off-by-one months

```typescript
// WRONG - the legacy Date constructor takes a 0-indexed month
const march = new Date(2024, 2, 15); // March, despite the 2

// RIGHT - a date type where the number means what it says
const march = plainDate(2024, 3, 15);
```

### 5. The birthday timezone problem

A birthday of March 15 must remain March 15 for everyone. The moment it is stored as an instant,
it becomes March 14 or March 16 for somebody.

```typescript
// WRONG - an instant; shifts across timezones
const birthday = new Date('1990-03-15T00:00:00Z');

// RIGHT - a date-only type; no timezone to shift with
const birthday = plainDate(1990, 3, 15);
```

### 6. Durations as bare numbers

```typescript
// WRONG - what unit? The name is the only clue, and names drift.
const timeout = 30;

// RIGHT - the type carries the unit
const timeout = duration({ seconds: 30 });
```

A `number` timeout is the single most common source of "the retry loop waits 30 milliseconds
instead of 30 seconds". If a duration must cross a boundary as a number (a config file, a wire
format), name the field for its unit (`timeoutSeconds`) and convert to a Duration at the parse
boundary — see [Data Validation](../validation/index.md).

---

## Storage vs Display

**Store instants in UTC. Convert to local only to render.**

| Store              | Display                                 |
| ------------------ | --------------------------------------- |
| Instant (UTC, ISO) | Zoned datetime in the viewer's timezone |

Date-only and Time-only values are exempt: a birthday and an opening time have no UTC to convert
to, and putting them through one is the bug in pitfall 5.

Storing UTC buys:

- Consistent ordering regardless of which host wrote the value
- No ambiguity across DST transitions
- Comparison and subtraction that are plain arithmetic

---

## Quick Checklist

**Timestamps:**

- [ ] An Instant type, not a local datetime
- [ ] Stored in UTC, ISO 8601
- [ ] Read from an injected clock, never the ambient one
- [ ] Converted to a local timezone only at render time

**Dates (birthdays, due dates):**

- [ ] A date-only type
- [ ] No time component
- [ ] No timezone component

**Times (daily schedules):**

- [ ] A time-only type
- [ ] Timezone taken from the owner, not stamped on the value

**Durations:**

- [ ] A Duration type, not a bare number
- [ ] If it must serialize as a number, the field name carries the unit
- [ ] Calendar arithmetic for "a day"; duration arithmetic for "24 hours" — chosen deliberately

**Storage:**

- [ ] Sorts chronologically as stored
- [ ] Zoned datetimes stored as instant + timezone, in separate fields
- [ ] No locale-formatted strings anywhere near persisted data

---

## Language Implementations

- [Date/Time in TypeScript](languages/typescript.md) — Temporal types, the prescribed library, and
  the clock port

## Related Articles

- [Domain-Driven Design](../domain-driven-design/index.md) — date/time as domain types
- [Data Validation](../validation/index.md) — parsing date, time, and duration inputs
- [Testing Conventions](../testing/index.md) — why the clock is injected
- [Functional Practices](../functional-practices/index.md) — keeping domain logic free of ambient state
