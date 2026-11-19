/** The one sentence a refusal or a failed read says; the daemon's own words when it gave some. */
export const sentenceOf = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : 'That did not work. Try again.';
