/**
 * THE STEPS OF A STEPPED MERMAID DIAGRAM, as Durian 0.6.2 read them and as an old message still has them (U1 review, item 3: decision D2
 * says an old diagram "loses nothing").
 *
 * A line `%% @step <title>` (a Mermaid comment) makes the diagram build up: the lines before the first one are the head every step shares,
 * and step k draws the head and every line up to the end of step k, with that step's title as its caption. At least two steps, or none: a
 * lone marker is a comment. Durian 0.7.0 dropped the part, so this is ours; it reads text and nothing else (no Durian, no React), runs in
 * the parser worker (`held-fence-parse.ts`) to say where each step ends, and on the page (`mermaid-slot.tsx`) to cut the source of a step.
 * The marker lines are never handed to Mermaid.
 */

/** One step: its caption, and how many lines of the diagram's body (markers counted) the step draws, from the first. */
export interface MermaidStep {
  readonly title: string;
  readonly end: number;
}

/** The most steps one diagram may have: a step is a sandbox frame when it is first shown, and a message is text nobody reviewed. More is no steps at all. */
export const MOST_MERMAID_STEPS = 40;

const MARKER = /^\s*%%\s*@step(?:\s+(.*))?$/u;

/** The steps of a diagram's body, or none when it has fewer than two markers (or more than {@link MOST_MERMAID_STEPS}). */
export function mermaidSteps(body: string): readonly MermaidStep[] {
  const lines = body.split('\n');
  const starts: { readonly at: number; readonly title: string }[] = [];
  lines.forEach((line, at) => {
    const marker = MARKER.exec(line);
    if (marker !== null) starts.push({ at, title: (marker[1] ?? '').trim() });
  });
  if (starts.length < 2 || starts.length > MOST_MERMAID_STEPS) return [];
  return starts.map((start, index) => ({ title: start.title, end: starts[index + 1]?.at ?? lines.length }));
}

/** What Mermaid is given for one step: the head and every line up to the end of the step, with no marker line. */
export const stepSource = (body: string, step: MermaidStep): string =>
  body
    .split('\n')
    .slice(0, step.end)
    .filter(line => !MARKER.test(line))
    .join('\n');
