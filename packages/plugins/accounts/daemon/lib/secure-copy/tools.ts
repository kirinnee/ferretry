import type { AuditDetail } from '@ferretry/core-gate/contract';
import { ferretOf, isFerretCall } from '@ferretry/core-gate/contract';
import type { InputRaise, InputRequestId, VaultApi } from '@ferretry/core-vault/contract';
import { type AgentControlKind, agentControlRefusal } from '@ferretry/kernel/contract';
import type { ToolHandler, ToolResult } from '@ferretry/kernel/manifest';
import type { BrowsersApi } from '@ferretry/plugin-browsers/contract';
import type { z } from 'zod';
import {
  type CopyMeta,
  type CopyName,
  CopyCaptureSchema,
  copyHandle,
  SecureDiscardInputSchema,
  SecureListInputSchema,
  SecurePasteInputSchema,
} from '../../../contract/routes/index.ts';
import type { AuditSink } from '../local-ports.ts';
import { SecureCopyError } from './errors.ts';
import type { SecureCopyService } from './service.ts';

/**
 * THE AGENT'S FOUR SECURE-COPY TOOLS (`secure_copy`, `secure_list`, `secure_discard`, `secure_paste`; docs/secure-copy.md).
 *
 * What an agent is told is {@link CopyMeta} and a sentence: the handle, the name, where it came from, how long it is, when
 * it ends, whether it may already have seen it, how often it was pasted. Never the value: no member of the copy service
 * that a tool reaches returns one (`open` is the Vault's, at the write, and is on no tool's port).
 *
 * A call is a FERRET's own: a call with no ferret behind it (a person's route) is refused, because a person can read the
 * value themselves. Every refusal is a sentence the agent can act on; an error that is not one of ours is a fixed sentence,
 * never its message (a thrown error can quote what a page or a program said).
 */
export interface SecureCopyToolDeps {
  readonly copies: SecureCopyService;
  /** The Vault's reach: input requests (a paste is one) and nothing else. */
  readonly vault: () => Pick<VaultApi, 'raiseInput' | 'inputState'>;
  readonly browsers: () => BrowsersApi | undefined;
  /** "What agents may control", read afresh; anything but a plain yes is a no (fails closed). */
  readonly mayControl: (ferret: string, kind: AgentControlKind) => Promise<boolean>;
  /** The vault redactor, over every sentence on its way out. */
  readonly redact: (text: string) => Promise<string>;
  readonly audit: AuditSink;
}

const NOT_AN_AGENT = 'Only an agent uses secure copy: a person can read the value themselves.';
const FAILED = 'Secure copy could not do that; nothing was changed.';

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** What a capture tells the agent in words (never the value): its length, where from, and any exposure, said plainly. */
function copiedSummary(copy: CopyMeta): string {
  const from = copy.from.origin ?? copy.from.program ?? copy.from.kind;
  const seen =
    copy.exposure.transcript === 'found'
      ? ' WARNING: this value was already in your transcript before it was sealed, so it is NOT protected; tell the owner it should be rotated.'
      : copy.exposure.pageReadBeforeCapture === true
        ? ' NOTE: you may have read this page before sealing it, so the value may already be in your context; tell the owner it may need rotating.'
        : '';
  const page =
    copy.from.kind === 'command'
      ? ''
      : ` Pages on ${copy.from.origin ?? 'that site'} are closed to your read, eval, console, network and screenshot until the copy ends (${copy.expiresAt}, or when you discard it); you can still click, type and navigate.`;
  return `Sealed ${plural(copy.length, 'character')} from ${from} as ${copy.handle}, until ${copy.expiresAt}. You cannot read it; paste it by handle.${page}${seen}`;
}

const liveCopies = (count: number): string => `This session holds ${plural(count, 'live copy')}.`;

const surfaceWords = (kind: 'terminal' | 'browser', name: string): string => `%${kind}:${name}`;

function firstIssue(error: z.ZodError): string {
  const [issue] = error.issues;
  return issue === undefined
    ? 'the call is not valid'
    : `${issue.path.length === 0 ? '' : `${issue.path.join('.')}: `}${issue.message}`;
}

export function secureCopyTools(deps: SecureCopyToolDeps): {
  readonly secure_copy: ToolHandler;
  readonly secure_list: ToolHandler;
  readonly secure_discard: ToolHandler;
  readonly secure_paste: ToolHandler;
} {
  const failure = async (text: string): Promise<ToolResult> => ({
    text: await deps.redact(text).catch(() => FAILED),
    isError: true,
  });

  /** Runs one tool as a ferret's call; every refusal is a sentence, and nothing else leaves as an error. */
  const guarded =
    (work: (ferret: string, input: unknown) => Promise<ToolResult>): ToolHandler =>
    async (call, input) => {
      if (!isFerretCall(call)) return await failure(NOT_AN_AGENT);
      const ferret = ferretOf(call);
      if (ferret === undefined) return await failure(NOT_AN_AGENT);
      try {
        const result = await work(ferret, input ?? {});
        return { ...result, text: await deps.redact(result.text) };
      } catch (error) {
        return await failure(error instanceof SecureCopyError ? error.message : FAILED);
      }
    };

  const record = async (
    tool: string,
    ferret: string,
    outcome: 'succeeded' | 'refused' | 'failed',
    detail: AuditDetail,
  ): Promise<void> => {
    await deps.audit
      .record({
        event: 'agent.tool',
        actor: { kind: 'host' },
        cause: 'daemon',
        subject: tool,
        outcome,
        detail: { session: ferret.slice(0, 64), ...detail },
      })
      .catch(() => undefined);
  };

  const secure_copy = guarded(async (ferret, input) => {
    const parsed = CopyCaptureSchema.safeParse(input);
    if (!parsed.success) throw new SecureCopyError('bad_request', firstIssue(parsed.error));
    const request = parsed.data;
    // A command is a terminal's act, a page element a browser's: the owner's switch for what it reads (Browsers asks its own
    // for a page, inside the read).
    if (request.source.kind === 'command' && !(await deps.mayControl(ferret, 'terminal')))
      throw new SecureCopyError('forbidden', agentControlRefusal('terminal'));
    try {
      const captured = await deps.copies.capture(ferret, request);
      await record('secure_copy', ferret, 'succeeded', {
        copyLength: captured.copy.length,
        transcript: captured.copy.exposure.transcript,
        ...(captured.copy.from.program === undefined ? {} : { program: captured.copy.from.program }),
        ...(captured.copy.exposure.pageReadBeforeCapture === undefined
          ? {}
          : { pageRead: captured.copy.exposure.pageReadBeforeCapture }),
      });
      return {
        text: copiedSummary(captured.copy),
        data: JSON.parse(
          JSON.stringify({
            copy: captured.copy,
            ...(captured.command === undefined ? {} : { command: captured.command }),
          }),
        ),
      };
    } catch (error) {
      await record('secure_copy', ferret, 'refused', { source: request.source.kind });
      throw error;
    }
  });

  const secure_list = guarded(async (ferret, input) => {
    const parsed = SecureListInputSchema.safeParse(input);
    if (!parsed.success) throw new SecureCopyError('bad_request', firstIssue(parsed.error));
    const copies = deps.copies.list(ferret);
    return {
      text:
        copies.length === 0
          ? 'This session holds no copies.'
          : liveCopies(copies.filter(c => c.state === 'live').length),
      data: JSON.parse(JSON.stringify({ copies })),
    };
  });

  const secure_discard = guarded(async (ferret, input) => {
    const parsed = SecureDiscardInputSchema.safeParse(input);
    if (!parsed.success) throw new SecureCopyError('bad_request', firstIssue(parsed.error));
    const copy = deps.copies.discard(ferret, parsed.data.handle);
    await record('secure_discard', ferret, 'succeeded', { copyLength: copy.length });
    return {
      text: `${copy.handle} is ${copy.state}: its value is gone from the daemon.`,
      data: JSON.parse(JSON.stringify({ copy })),
    };
  });

  const secure_paste = guarded(async (ferret, input) => {
    const parsed = SecurePasteInputSchema.safeParse(input);
    if (!parsed.success) throw new SecureCopyError('bad_request', firstIssue(parsed.error));
    const call = parsed.data;
    const name: CopyName = call.handle;
    const handle = copyHandle(name);
    const source = { kind: 'sealed' as const, name };
    const expires = call.expiresInSeconds === undefined ? {} : { expiresInSeconds: call.expiresInSeconds };
    let raise: InputRaise;
    let where: string;
    if (call.to.kind === 'secret') {
      // The store is the owner's: a paste is the one way a ferret writes it, and the owner allows each one.
      if (!(await deps.mayControl(ferret, 'terminal')))
        throw new SecureCopyError('forbidden', agentControlRefusal('terminal'));
      raise = {
        target: { kind: 'secret', key: call.to.name },
        prompt: call.prompt,
        sensitivity: 'secret',
        submit: 'agent',
        source,
        ...expires,
      } as unknown as InputRaise;
      where = `the secret ${call.to.name}`;
    } else if (call.to.kind === 'terminal') {
      if (!(await deps.mayControl(ferret, 'terminal')))
        throw new SecureCopyError('forbidden', agentControlRefusal('terminal'));
      raise = {
        target: { kind: 'terminal', key: call.to.name },
        prompt: call.prompt,
        sensitivity: 'secret',
        submit: call.submit ?? 'offer-owner',
        source,
        ...expires,
      } as unknown as InputRaise;
      where = surfaceWords('terminal', call.to.name);
    } else {
      // The page is cleared as a browser tool would clear it (the switch, the ferret's own page, nobody holding it).
      const reach = deps.browsers()?.copy;
      if (reach === undefined)
        throw new SecureCopyError('unavailable', 'Pasting into a page is not available on this daemon.');
      const cleared = await reach.pasteTarget(ferret as never, call.to.name);
      if (!cleared.ok)
        throw new SecureCopyError(cleared.code === 'unavailable' ? 'unavailable' : cleared.code, cleared.message);
      raise = {
        target: { kind: 'page', key: cleared.key },
        prompt: call.prompt,
        fields: [
          {
            id: 'value',
            sensitivity: 'secret',
            element:
              call.to.ref === undefined
                ? { kind: 'selector', selector: call.to.selector ?? '' }
                : { kind: 'ref', ref: call.to.ref },
          },
        ],
        submit: call.submit ?? 'offer-owner',
        source,
        ...expires,
      } as unknown as InputRaise;
      where = `a field on ${surfaceWords('browser', cleared.key)}`;
    }
    const raised = await deps.vault().raiseInput(ferret as never, raise);
    if (!raised.ok) {
      await record('secure_paste', ferret, 'refused', { to: call.to.kind });
      throw new SecureCopyError(/taken over/u.test(raised.error) ? 'taken_over' : 'conflict', raised.error);
    }
    const id: InputRequestId = raised.value;
    // A paste a rule the owner approved in advance allowed is delivered by the time the raise returns.
    const delivered =
      (await deps
        .vault()
        .inputState(id)
        .catch(() => undefined)) === 'delivered';
    await record('secure_paste', ferret, 'succeeded', { to: call.to.kind, by: delivered ? 'rule' : 'owner' });
    return {
      text: delivered
        ? `Pasted ${handle} into ${where} under a rule the owner approved in advance (${id}).`
        : `Asked the owner to allow pasting ${handle} into ${where} (${id}). Wait with input_wait; do not type there yourself.`,
      data: { request: id, delivered },
    };
  });

  return { secure_copy, secure_list, secure_discard, secure_paste };
}
