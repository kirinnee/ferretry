import { type AgendaFormField, AgendaFormFieldSchema, type AgendaFieldType } from '@ferretry/protocol';

/**
 * The words `--field` is written in: `id|type|Question|option|option…`, one flag per field, in order.
 *
 * - `id`: the short name the answer is read back by (`1`, `region`); `type`: `one` (pick one), `many` (pick any),
 *   `yesno` or `text` (typed in the reply box). `radio`, `checkbox` and `pick-one`/`pick-many` are read too.
 * - `Question`: what the owner is asked; a leading `Name~` sets the short word the answer line uses
 *   (`Region~Which region?` → `1. Region: EU`).
 * - options (`one`/`many`): `Label` or `Label: what it means`; a leading `*` marks the one you recommend. A `yesno`
 *   may end with `*Yes` or `*No` to recommend it. A trailing `?` segment makes an answer optional (`optional`).
 */
const FIELD_GRAMMAR = 'id|one/many/yesno/text|Question|option|option…';

const TYPES = new Map<string, AgendaFieldType>([
  ['one', 'one'],
  ['pick-one', 'one'],
  ['radio', 'one'],
  ['many', 'many'],
  ['pick-many', 'many'],
  ['checkbox', 'many'],
  ['yesno', 'yesno'],
  ['yes-no', 'yesno'],
  ['text', 'text'],
  ['free', 'text'],
]);

const OPTION_LABEL_SPLIT_MAX = 40;

/** One field as the JSON body writes it: the protocol's own shape, with a number id and plain-string options allowed. */
export interface FieldInput {
  readonly id: string | number;
  readonly type: string;
  readonly label: string;
  readonly name?: string | undefined;
  readonly options?:
    | readonly (string | { readonly label: string; readonly description?: string | undefined })[]
    | undefined;
  readonly recommended?: string | readonly string[] | undefined;
  readonly required?: boolean | undefined;
}

function typeOf(raw: string, where: string): AgendaFieldType {
  const type = TYPES.get(raw.trim().toLowerCase());
  if (type === undefined) {
    throw new Error(`${where}: unknown field type "${raw.trim()}" — use one, many, yesno or text`);
  }
  return type;
}

function optionOf(raw: string): { label: string; description?: string; starred: boolean } {
  const starred = raw.trimStart().startsWith('*');
  const body = starred ? raw.trimStart().slice(1).trim() : raw.trim();
  const at = body.indexOf(': ');
  const label = at < 0 ? '' : body.slice(0, at).trim();
  const description = at < 0 ? '' : body.slice(at + 2).trim();
  if (label === '' || label.length > OPTION_LABEL_SPLIT_MAX || description === '') return { label: body, starred };
  return { label, description, starred };
}

/** One `--field` flag, read into the protocol's field (checked as a whole by `fieldsFrom`). */
export function fieldFromFlag(raw: string): FieldInput {
  const where = `--field "${raw.trim()}"`;
  const parts = raw.split('|').map(part => part.trim());
  const [id, type, question, ...rest] = parts;
  if (id === undefined || id === '' || type === undefined || question === undefined || question === '') {
    throw new Error(`${where} needs ${FIELD_GRAMMAR}`);
  }
  const kind = typeOf(type, where);
  const named = question.indexOf('~');
  const name = named > 0 ? question.slice(0, named).trim() : undefined;
  const label = (named > 0 ? question.slice(named + 1) : question).trim();
  const optional = rest.at(-1)?.toLowerCase() === 'optional';
  const segments = (optional ? rest.slice(0, -1) : rest).filter(part => part !== '');
  const base = {
    id,
    type: kind,
    label,
    ...(name === undefined || name === '' ? {} : { name }),
    ...(optional ? { required: false } : {}),
  };
  if (kind === 'yesno') {
    const pick = segments.find(part => part.startsWith('*'));
    const others = segments.filter(part => !part.startsWith('*'));
    if (others.length > 0) throw new Error(`${where}: a yesno field has no options (only an optional *Yes or *No)`);
    return { ...base, ...(pick === undefined ? {} : { recommended: pick.slice(1).trim() }) };
  }
  if (kind === 'text') {
    if (segments.length > 0) throw new Error(`${where}: a text field has no options: it is answered in the reply box`);
    return base;
  }
  const options = segments.map(optionOf);
  const recommended = options.filter(each => each.starred).map(each => each.label);
  return {
    ...base,
    options: options.map(({ label: each, description }) => ({
      label: each,
      ...(description === undefined ? {} : { description }),
    })),
    ...(recommended.length === 0 ? {} : { recommended }),
  };
}

/** The form's fields, from `--field` flags or the JSON body's `fields` (the flags win), validated with plain errors. */
export function fieldsFrom(
  flags: readonly string[] | undefined,
  file: readonly FieldInput[] | undefined,
): AgendaFormField[] | undefined {
  const inputs = flags !== undefined && flags.length > 0 ? flags.map(fieldFromFlag) : file;
  if (inputs === undefined || inputs.length === 0) return undefined;
  return inputs.map((input, index) => {
    const type = typeOf(input.type, `field ${index + 1}`);
    if ((type === 'one' || type === 'many') && (input.options?.length ?? 0) < 2) {
      throw new Error(`field ${String(input.id)}: a ${type} field needs 2 or more options (${FIELD_GRAMMAR})`);
    }
    const parsed = AgendaFormFieldSchema.safeParse({
      id: String(input.id),
      type,
      label: input.label,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.options === undefined
        ? {}
        : { options: input.options.map(each => (typeof each === 'string' ? optionOf(each) : each)).map(stripStar) }),
      ...(input.recommended === undefined
        ? {}
        : { recommended: typeof input.recommended === 'string' ? [input.recommended] : [...input.recommended] }),
      ...(input.required === undefined ? {} : { required: input.required }),
    });
    if (!parsed.success) {
      const why = parsed.error.issues.map(issue => issue.message).join('; ');
      throw new Error(`field ${String(input.id)}: ${why}`);
    }
    return parsed.data;
  });
}

const stripStar = (option: { label: string; description?: string | undefined; starred?: boolean }) => ({
  label: option.label,
  ...(option.description === undefined ? {} : { description: option.description }),
});
