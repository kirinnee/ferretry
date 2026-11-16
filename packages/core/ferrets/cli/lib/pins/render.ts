import type { Pin } from '../../../contract/index.ts';
import type { PinSnapshot } from './gateway.ts';

/** How many leading characters of a pin uuid the listing prints, and therefore accepts back. */
const PIN_SHORT_ID_LENGTH = 8;

/** Longest pin body printed before it is elided; keeps a row inside a conventional terminal. */
const MAX_BODY_WIDTH = 80;

export const shortPinId = (id: string): string => id.slice(0, PIN_SHORT_ID_LENGTH);

const pluralPins = (count: number): string => (count === 1 ? '1 pin' : `${count} pins`);
const singleLine = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim();
const elide = (text: string): string =>
  text.length <= MAX_BODY_WIDTH ? text : `${text.slice(0, MAX_BODY_WIDTH - 1)}…`;

/** Who put the pin there: an agent pin is tagged, a human pin is not, so a reader can always tell. */
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
    rows.reduce((width, row) => Math.max(width, pick(row).length), 0);
  const [idWidth, kindWidth, tagWidth] = [widest(row => row.id), widest(row => row.kind), widest(row => row.tag)];
  const lines = [`${pluralPins(snapshot.pins.length)} in ${snapshot.sessionId}`];
  for (const row of rows) {
    const prefix = `  ${row.id.padEnd(idWidth)}  ${row.kind.padEnd(kindWidth)}`;
    lines.push(tagWidth === 0 ? `${prefix}  ${row.body}` : `${prefix}  ${row.tag.padEnd(tagWidth)}  ${row.body}`);
  }
  return lines.join('\n');
}

/** Confirmation for a change, naming the pin acted on and the board size that resulted. */
export function renderPinChange(verb: string, id: string | undefined, snapshot: PinSnapshot): string {
  return `${id === undefined ? verb : `${verb} ${shortPinId(id)}`} — ${pluralPins(snapshot.pins.length)} in ${snapshot.sessionId}`;
}
