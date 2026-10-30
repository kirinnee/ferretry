/** The tag older notes opened with, before the sender said so as metadata: read for history only. */
const MARK = '[instructions updated]';

/** The part of Ferretry that sends an instructions note; `by.sections` names what it restates. */
const FEATURE = 'Instructions';

/** What the queue says about who sent a message: the part of it this row reads. */
export interface InstructionsSender {
  readonly feature?: string;
  readonly sections?: readonly string[];
}

interface InstructionSection {
  /** What the section is called: the words before its first colon, such as "Board". */
  readonly label: string;
  readonly text: string;
}

export interface InstructionsUpdate {
  readonly sections: readonly InstructionSection[];
  /** One line a person reads: who changed what. */
  readonly headline: string;
}

const SECTION_START = /^([A-Z][^:\n]{1,30}):/u;

/**
 * A note telling an agent its instructions changed, read for DISPLAY only — `null` for any other message.
 * The sender says what it is as metadata (`by.feature`, and the section names in `by.sections`); a note from
 * before that is told by its tag. The note's own lead-in is the agent's, so it is dropped; each paragraph
 * that opens `Label:` starts a section and the paragraphs after it belong to that section.
 */
export function parseInstructionsUpdate(text: string, by?: InstructionsSender): InstructionsUpdate | null {
  const trimmed = text.trimStart();
  const tagged = trimmed.startsWith(MARK);
  if (by?.feature !== FEATURE && !tagged) return null;
  const [, ...paragraphs] = (tagged ? trimmed.slice(MARK.length) : trimmed).trim().split(/\n[^\S\n]*\n/u);
  const sections: { label: string; text: string }[] = [];
  for (const paragraph of paragraphs.map(candidate => candidate.trim()).filter(candidate => candidate !== '')) {
    const label = SECTION_START.exec(paragraph)?.[1];
    const last = sections.at(-1);
    if (label === undefined && last !== undefined) last.text = `${last.text}\n\n${paragraph}`;
    else sections.push({ label: label ?? 'Instructions', text: paragraph });
  }
  const labels = by?.sections ?? sections.map(section => section.label);
  return {
    sections,
    headline: `Ferretry updated this ferret's instructions${labels.length === 0 ? '' : ` · ${labels.join(', ')}`}`,
  };
}
