import { describe, it } from 'bun:test';
import should from 'should';
import * as dialog from '../../src/lib/session-dialog.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const ID = '0123456789abcdef';
const DIALOG: dialog.HarnessDialog = {
  id: ID,
  harness: 'codex',
  kind: 'hooks-review',
  title: 'Hooks need review',
  body: '1 hook is new or changed.\nHooks can run outside the sandbox after you trust them.',
  options: [
    { number: 1, label: 'Review hooks', grantsTrust: false },
    { number: 2, label: 'Trust all and continue', grantsTrust: true },
    { number: 3, label: "Continue without trusting (hooks won't run)", grantsTrust: false },
  ],
  selected: 1,
  escape: 'skip',
};
const LIST: dialog.HarnessDialog = {
  id: ID,
  harness: 'codex',
  kind: 'hooks-list',
  title: 'Hooks',
  options: [],
  escape: 'close',
};

const cases: SchemaCase[] = [
  { name: 'kind', schema: dialog.HarnessDialogKindSchema, value: 'mcp-servers' },
  {
    name: 'option',
    schema: dialog.HarnessDialogOptionSchema,
    value: { number: 1, label: 'Sign in with ChatGPT', detail: 'Usage included', grantsTrust: false },
  },
  { name: 'id', schema: dialog.HarnessDialogIdSchema, value: ID },
  { name: 'dialog', schema: dialog.HarnessDialogSchema, value: DIALOG },
  { name: 'dialog with no rows', schema: dialog.HarnessDialogSchema, value: LIST },
  {
    name: 'choice answer',
    schema: dialog.HarnessDialogAnswerRequestSchema,
    value: { kind: 'choice', dialogId: ID, number: 3 },
  },
  { name: 'escape answer', schema: dialog.HarnessDialogAnswerRequestSchema, value: { kind: 'escape', dialogId: ID } },
  { name: 'answer result', schema: dialog.HarnessDialogAnswerResultSchema, value: { dialogId: ID, cleared: false } },
];

const invalid: SchemaCase[] = [
  { name: 'unknown kind', schema: dialog.HarnessDialogKindSchema, value: 'theme' },
  {
    name: 'option without trust',
    schema: dialog.HarnessDialogOptionSchema,
    value: { number: 1, label: 'Skip' },
  },
  { name: 'short id', schema: dialog.HarnessDialogIdSchema, value: 'abc' },
  {
    name: 'options out of order',
    schema: dialog.HarnessDialogSchema,
    value: { ...DIALOG, options: [DIALOG.options[1], DIALOG.options[0]] },
  },
  { name: 'selection past the list', schema: dialog.HarnessDialogSchema, value: { ...DIALOG, selected: 4 } },
  { name: 'rows with no selection', schema: dialog.HarnessDialogSchema, value: { ...DIALOG, selected: undefined } },
  { name: 'selection with no rows', schema: dialog.HarnessDialogSchema, value: { ...LIST, selected: 1 } },
  { name: 'no way out', schema: dialog.HarnessDialogSchema, value: { ...LIST, escape: undefined } },
  { name: 'extra field', schema: dialog.HarnessDialogSchema, value: { ...DIALOG, extra: true } },
  {
    name: 'choice without a number',
    schema: dialog.HarnessDialogAnswerRequestSchema,
    value: { kind: 'choice', dialogId: ID },
  },
  {
    name: 'escape with a number',
    schema: dialog.HarnessDialogAnswerRequestSchema,
    value: { kind: 'escape', dialogId: ID, number: 1 },
  },
];

describe('session dialog schemas', () => {
  it('round-trips every valid shape', () => assertRoundTrips(cases));
  it('rejects malformed shapes', () => assertRejects(invalid));
  it('covers every exported schema', () => assertCoversEverySchema(dialog, cases));
  it('names the reason a dialog with no way out is refused', () => {
    const result = dialog.HarnessDialogSchema.safeParse({ ...LIST, escape: undefined });
    should(result.success).be.false();
    should(JSON.stringify(result.error?.issues)).match(/a way out/);
  });
});
