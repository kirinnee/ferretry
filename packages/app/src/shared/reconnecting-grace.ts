/**
 * How long an outage stays UNSAID. A stream that drops and is back within a round trip or two is a blip, not
 * news: the reopen has already started, the screen keeps showing the last good frame, and a lamp that flashed
 * "reconnecting" for every one of them taught the owner the app was always reconnecting. Only an outage older
 * than this is shown. Connections' per-daemon health model uses the same number for its own pill.
 */
export const RECONNECTING_GRACE_MS = 1_500;
