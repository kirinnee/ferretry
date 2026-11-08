import type { RedactionScope } from '@ferretry/kernel/contract';

/**
 * A UNIFIED DIFF AS IT LEAVES THE DAEMON, with every secret the read's scope knows replaced.
 *
 * This is the outbound projection and nothing else: the diff bytes the service builds (and the snapshots they
 * come from) are never touched, so nothing that consumes a diff is corrupted. The secrets-policy refusal
 * (denied / ignored → 403) is a gate that runs before this and stays as it is; this adds to it.
 *
 * A secret that spans lines is not one run of text in a diff, because every line carries its marker (`+`, `-` or a
 * space). So the body lines of one hunk are masked in runs of the SAME marker: the markers come off, the run's
 * lines are joined with `\n` and masked as one text, and the markers go back on. A value added over several lines
 * (a key file) is therefore found whole, where masking line by line would not find it. Headers and hunk headers
 * (which can carry a source line) are masked one line at a time.
 */
export function redactedDiffText(diff: string, scope: RedactionScope): string {
  const out: string[] = [];
  let marker: ' ' | '+' | '-' | undefined;
  let run: string[] = [];
  let inHunk = false;

  const flush = (): void => {
    if (marker !== undefined) {
      const masked = scope.text(run.join('\n')).split('\n');
      for (const line of masked) out.push(marker + line);
    }
    marker = undefined;
    run = [];
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) inHunk = false;
    const lead = line.charAt(0);
    if (inHunk && (lead === ' ' || lead === '+' || lead === '-')) {
      if (marker !== lead) flush();
      marker = lead;
      run.push(line.slice(1));
      continue;
    }
    flush();
    if (line.startsWith('@@')) inHunk = true;
    out.push(scope.text(line));
  }
  flush();
  return out.join('\n');
}
