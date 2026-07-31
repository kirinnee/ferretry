import type { Pin, PinSnapshot } from '@ferretry/protocol';
import { shortPinId } from './pin-id.ts';

/** Longest pin body printed before it is elided; keeps a row inside a conventional terminal. */
const MAX_BODY_WIDTH = 80;

const pluralPins = (count: number): string => (count === 1 ? '1 pin' : `${count} pins`);

const singleLine = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim();

const elide = (text: string): string =>
  text.length <= MAX_BODY_WIDTH ? text : `${text.slice(0, MAX_BODY_WIDTH - 1)}…`;

const pad = (text: string, width: number): string => text.padEnd(width, ' ');

/** Who put the pin there — an agent pin is tagged, a human pin is not, so a reader can always tell. */
function provenance(pin: Pin): string {
  if (pin.by !== 'agent') return '';
  return pin.createdByName === null ? '[agent]' : `[agent ${pin.createdByName}]`;
}

/** The pin's content, flattened to one line. */
function body(pin: Pin): string {
  if (pin.kind === 'note') return elide(singleLine(pin.text));
  const preview = singleLine(pin.preview);
  return elide(`${pin.blockKind}: ${preview === '' ? '(empty message)' : preview}`);
}

/** The pin board as a human reads it. Columns are sized from the rows, never from a fixed guess. */
export function renderPinList(snapshot: PinSnapshot): string {
  if (snapshot.pins.length === 0) return `No pins in ${snapshot.sessionId}.`;

  const rows = snapshot.pins.map(pin => ({
    id: shortPinId(pin.id),
    kind: pin.kind,
    tag: provenance(pin),
    body: body(pin),
  }));
  const widest = (pick: (row: (typeof rows)[number]) => string): number =>
    rows.reduce((widest, row) => Math.max(widest, pick(row).length), 0);
  const idWidth = widest(row => row.id);
  const kindWidth = widest(row => row.kind);
  const tagWidth = widest(row => row.tag);

  const lines = [`${pluralPins(snapshot.pins.length)} in ${snapshot.sessionId}`];
  for (const row of rows) {
    const prefix = `  ${pad(row.id, idWidth)}  ${pad(row.kind, kindWidth)}`;
    lines.push(tagWidth === 0 ? `${prefix}  ${row.body}` : `${prefix}  ${pad(row.tag, tagWidth)}  ${row.body}`);
  }
  return lines.join('\n');
}

/** Confirmation for a mutation, naming the pin acted on and the board size that resulted. */
export function renderPinMutation(verb: string, id: string | undefined, snapshot: PinSnapshot): string {
  const subject = id === undefined ? verb : `${verb} ${shortPinId(id)}`;
  return `${subject} — ${pluralPins(snapshot.pins.length)} in ${snapshot.sessionId}`;
}
