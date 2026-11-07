import type { FerretId } from '@ferretry/kernel/contract';
import type {
  ClearJob,
  ClearOutcome,
  InputShot,
  InputTarget,
  InputTargetAdapter,
  InputTargetFacts,
  InputTargetKind,
} from '../../../contract/index.ts';
import type {
  InputFieldValue,
  InputTargetField,
  InputTargetPort,
  ObserveResult,
  TerminalInputTargetPort,
  TypeOptions,
  TypeResult,
} from '../../lib/inputs/ports.ts';
import { INPUT_SINGLE_FIELD_ID } from '../../lib/inputs/wire.ts';

/** The `input.targets:<kind>` provider in effect now, or nothing when that plugin is off (§4.7). */
export type TargetProvider = (kind: InputTargetKind) => InputTargetAdapter | undefined;

const ferretOf = (sessionId: string): FerretId => sessionId as FerretId;

/**
 * A page, through Browsers' `input.targets:page` adapter. Looked up on every call: a Browsers that was turned off
 * since the card was raised answers `unsupported` / `target_gone`, so nothing is typed.
 */
export class PageTargetThroughHook implements InputTargetPort {
  constructor(private readonly provider: TargetProvider) {}

  async observe(sessionId: string, target: InputTarget, fields: readonly InputTargetField[]): Promise<ObserveResult> {
    const page = this.provider('page');
    return page === undefined
      ? { ok: false, reason: 'unsupported' }
      : await page.observe(ferretOf(sessionId), target, fields);
  }

  async refind(
    sessionId: string,
    target: InputTarget,
    fields: readonly InputTargetField[],
    expected: InputTargetFacts,
  ): Promise<ObserveResult> {
    const page = this.provider('page');
    return page?.refind === undefined
      ? { ok: false, reason: 'unsupported' }
      : await page.refind(ferretOf(sessionId), target, fields, expected);
  }

  async type(
    sessionId: string,
    target: InputTarget,
    values: readonly InputFieldValue[],
    submit: boolean,
    expected: InputTargetFacts,
    options?: TypeOptions,
  ): Promise<TypeResult> {
    const page = this.provider('page');
    return page === undefined
      ? 'target_gone'
      : await page.type(ferretOf(sessionId), target, values, submit, expected, options);
  }

  async shoot(sessionId: string, target: InputTarget, facts: InputTargetFacts): Promise<InputShot | undefined> {
    return await this.provider('page')?.shoot?.(ferretOf(sessionId), target, facts);
  }

  async document(sessionId: string, key: string): Promise<string | undefined> {
    return await this.provider('page')?.document?.(ferretOf(sessionId), key);
  }

  async probe(
    sessionId: string,
    target: InputTarget,
    facts: InputTargetFacts,
    fieldIds: readonly string[],
  ): Promise<'hidden' | 'shown' | 'aborted'> {
    const page = this.provider('page');
    return page?.probe === undefined ? 'aborted' : await page.probe(ferretOf(sessionId), target, facts, fieldIds);
  }

  async clear(sessionId: string, target: InputTarget, job: ClearJob): Promise<ClearOutcome> {
    const page = this.provider('page');
    return page?.arm === undefined ? 'unknown' : await page.arm(ferretOf(sessionId), target, job);
  }
}

/** A terminal, through Terminals' `input.targets:terminal` adapter: one prompt, so one value (today's router rule). */
export class TerminalTargetThroughHook implements TerminalInputTargetPort {
  constructor(private readonly provider: TargetProvider) {}

  async observe(sessionId: string, target: InputTarget): Promise<ObserveResult> {
    const terminal = this.provider('terminal');
    return terminal === undefined
      ? { ok: false, reason: 'unsupported' }
      : await terminal.observe(ferretOf(sessionId), target, [{ id: INPUT_SINGLE_FIELD_ID }]);
  }

  async type(
    sessionId: string,
    target: InputTarget,
    text: string,
    submit: boolean,
    expected: InputTargetFacts,
    options?: TypeOptions,
  ): Promise<TypeResult> {
    const terminal = this.provider('terminal');
    return terminal === undefined
      ? 'target_gone'
      : await terminal.type(
          ferretOf(sessionId),
          target,
          [{ field: INPUT_SINGLE_FIELD_ID, text }],
          submit,
          expected,
          options,
        );
  }
}
