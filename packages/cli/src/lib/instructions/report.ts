import { AGENDA_ENV, HYPERMEDIA_ENV, PACK_ENV, PASSIVE_LEARNING_ENV, SESSION_MODE_ENV } from '@ferretry/fleet';

/**
 * WHICH OF ITS OWN SECTIONS A FERRET LAUNCHED WITH (docs/hypermedia.md), read from the launch environment
 * the runtime wrapper composed its appended system prompt from — the same variables, at the same values,
 * so the answer cannot disagree with what the wrapper did. A ferret that says "hypermedia isn't enabled
 * here" can check instead of guessing, and tell the owner the one place that turns it on.
 *
 * Pure: an environment in, the report out.
 */

/** One per-ferret section, in the order the wrapper appends them. */
interface InstructionSection {
  readonly id: 'hypermedia' | 'pack' | 'agenda' | 'lessons';
  readonly label: string;
  readonly on: boolean;
  /** How the owner turns it on; `undefined` when it already is. */
  readonly turnOn?: string;
}

export interface InstructionsReport {
  /** Whether this runs inside a ferret's pane at all: `FY_SESSION_ID` is what every launch hands one. */
  readonly inFerret: boolean;
  readonly sessionId?: string;
  readonly mode?: 'auto' | 'interactive';
  /**
   * Whether this process was handed the switches at all. Every daemon launch hands the pane
   * `FY_HYPERMEDIA`, but Codex gives a stdio tools server only the short list it is told to forward, so
   * the MCP server under Codex sees none — and "all off" would then be a guess presented as a fact.
   */
  readonly known: boolean;
  readonly sections: readonly InstructionSection[];
}

const SECTIONS = [
  { id: 'hypermedia', label: 'Hypermedia', env: HYPERMEDIA_ENV, action: 'Hypermedia', also: '' },
  {
    id: 'pack',
    label: 'Pack mode',
    env: PACK_ENV,
    action: 'Pack mode',
    also: ' Settings › Pack mode, the machine’s switch, must be on too.',
  },
  { id: 'agenda', label: 'Agenda mode', env: AGENDA_ENV, action: 'Agenda mode', also: '' },
  { id: 'lessons', label: 'Lessons', env: PASSIVE_LEARNING_ENV, action: 'Passive learning', also: '' },
] as const;

/** The sentence the owner acts on: the menu entry, and when the change arrives. */
const turnOnSentence = (action: string): string =>
  `The owner turns it on in Ferretry: open this ferret › Actions › ${action}. It takes effect when this ferret next restarts (Actions › Restart).`;

export function instructionsReport(environment: Readonly<Record<string, string | undefined>>): InstructionsReport {
  const sessionId = environment.FY_SESSION_ID;
  const mode = environment[SESSION_MODE_ENV];
  const sections = SECTIONS.map(section => {
    // Exactly the wrapper's own test: a section is in the prompt only when its variable is `1`.
    const on = environment[section.env] === '1';
    return {
      id: section.id,
      label: section.label,
      on,
      ...(on ? {} : { turnOn: `${turnOnSentence(section.action)}${section.also}` }),
    };
  });
  return {
    known: SECTIONS.some(section => environment[section.env] !== undefined),
    inFerret: sessionId !== undefined && sessionId !== '',
    ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
    ...(mode === 'auto' || mode === 'interactive' ? { mode } : {}),
    sections,
  };
}

/** The report as a ferret or a person reads it. */
export function renderInstructionsReport(report: InstructionsReport, binary: string): string {
  if (!report.inFerret)
    return 'This is not running inside a ferret, so no sections were launched here. Run it from a ferret’s own terminal, or open the ferret in Ferretry › Info › Runtime.';
  if (!report.known)
    return `This process was not handed ferret ${report.sessionId ?? ''}'s section switches (a Codex tools server is not). Run \`${binary} instructions\` in your own shell instead.`;
  const heading = `Sections ferret ${report.sessionId ?? ''} launched with${report.mode === undefined ? '' : ` (${report.mode})`}:`;
  const lines = report.sections.map(section =>
    section.on ? `  ✓ ${section.label}: on` : `  ✗ ${section.label}: off. ${section.turnOn ?? ''}`,
  );
  return [
    heading,
    ...lines,
    'These are fixed for this run: a switch changed now is in the system prompt from the next launch.',
  ].join('\n');
}
