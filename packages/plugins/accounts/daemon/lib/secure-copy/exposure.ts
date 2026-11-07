/**
 * WHETHER A TRANSCRIPT ALREADY HOLDS A VALUE, as the daemon answers "did the agent see it before it was sealed".
 *
 * A transcript is JSON lines, so a value with a quote, a backslash or a line break rests there escaped: both
 * spellings are looked for. A value the harness rewrote some other way (cut, wrapped, base64) is not found, so
 * `clean` means "not found in what was read", never "the agent never saw it" (docs/secure-copy.md).
 */
export function transcriptExposure(text: string, value: string): 'found' | 'clean' {
  if (value === '') return 'clean';
  const escaped = JSON.stringify(value).slice(1, -1);
  return text.includes(value) || text.includes(escaped) ? 'found' : 'clean';
}
