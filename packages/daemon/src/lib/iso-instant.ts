/**
 * Whether a string is the offset-bearing ISO instant the protocol's `InstantSchema` accepts, decided
 * WITHOUT zod.
 *
 * WHY A SECOND SPELLING. The session observer runs, from stage 3b on, inside a per-session worker that
 * must not load zod (`docs/design/session-workers.md` §3.4: a worker that drags zod in costs 15 MB, a
 * lean one 4 MB). The observed-runtime projection checks each transcript timestamp before it lands in
 * the session document, so the check has to exist without the schema library.
 *
 * ONE ACCEPTED SET, two spellings: this is zod v4's `z.iso.datetime({ offset: true })` pattern — the
 * calendar-aware date (leap days included), `T`, `hh:mm` with optional seconds and fraction, then `Z`
 * or a `±hh:mm` offset. `tests/unit/iso-instant.test.ts` holds the two to the same answers over a corpus,
 * so a zod upgrade that moves the schema fails a test rather than splitting what the document accepts.
 */
const DATE =
  '(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))';
const TIME = '(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?';
const OFFSET = '(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d))';
const ISO_INSTANT = new RegExp(`^${DATE}T(?:${TIME}${OFFSET})$`);

export const isIsoInstant = (value: string): boolean => ISO_INSTANT.test(value);
