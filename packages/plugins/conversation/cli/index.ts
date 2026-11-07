import { implementCli, type VerbHandler, type VerbInvocation } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { AnswerQuestionController, InterruptController } from './lib/answer/controller.ts';
import { CompactAtController } from './lib/compact-at/controller.ts';
import { CommandError } from './lib/errors.ts';
import { ClientConversationGateway, NO_FILE_ACCESS } from './lib/gateway.ts';
import { queueCancelVerb, queueEditVerb, queueVerb } from './lib/queue/commands.ts';
import { ClientQueueGateway } from './lib/queue/gateway.ts';
import { SendMessageController } from './lib/send/controller.ts';
import type { ConversationOutput, SendFiles, SendWaitClock } from './lib/send/ports.ts';
// The reading verbs: logs, search, render, link and transcript.
import { readingVerbs } from './reading/verbs.ts';

/** Exit code a verb that is not ready answers with (the skeleton's), after saying so. */
const NOT_READY = 69;

/** The string an option holds (its last, when repeated), under any of its spellings. */
const text = (invocation: VerbInvocation, ...names: readonly string[]): string | undefined => {
  for (const name of names) {
    const value = invocation.options[name];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value[value.length - 1] as string | undefined;
  }
  return undefined;
};
const on = (invocation: VerbInvocation, ...names: readonly string[]): boolean =>
  names.some(name => invocation.options[name] === true || invocation.options[name] === 'true');
const list = (invocation: VerbInvocation, name: string): string[] => {
  const value = invocation.options[name];
  if (Array.isArray(value)) return [...value] as string[];
  return typeof value === 'string' ? [value] : [];
};
const first = (invocation: VerbInvocation, what: string): string => {
  const value = invocation.args[0]?.trim();
  if (value === undefined || value === '') throw new CommandError(`missing the ${what}`);
  return value;
};
const joinedFrom = (parts: readonly string[]): string | undefined => {
  const value = parts.join(' ').trim();
  return value === '' ? undefined : value;
};

/**
 * Conversation's cli half: `send`, `reply`, `answer`, `interrupt`, `compact-at` and the `queue` verbs.
 *
 * The shell hands a half no environment: no files (so `--message-file` and `--file` say so), no clock to rest on (so
 * `--wait` says so) and no caller ferret (so `--ask` takes `--session <ferret>`). Write positionals before options.
 */
export default implementCli(manifest, {
  build: ctx => {
    const output: ConversationOutput = {
      out: line => ctx.io.out(`${line}\n`),
      note: line => ctx.io.err(`${line}\n`),
    };
    const gateway = new ClientConversationGateway(ctx.client);
    const files: SendFiles = {
      readText: async () => {
        throw new CommandError(NO_FILE_ACCESS);
      },
    };
    const clock: SendWaitClock = {
      nowMs: () => 0,
      sleep: async () => {
        throw new CommandError(
          '--wait needs a clock the shell does not give a plugin yet; look with `fy queue <ferret>` instead',
        );
      },
    };
    const guarded =
      (work: (invocation: VerbInvocation) => Promise<void>): VerbHandler =>
      async invocation => {
        try {
          await work(invocation);
          return 0;
        } catch (error) {
          if (!(error instanceof CommandError)) {
            const shellOwned = error instanceof Error && typeof (error as { exitCode?: unknown }).exitCode === 'number';
            if (shellOwned) throw error;
          }
          ctx.io.err(`${error instanceof Error ? error.message : String(error)}\n`);
          return error instanceof CommandError ? error.exitCode : 1;
        }
      };

    const send = (peerReply: boolean): VerbHandler =>
      guarded(async invocation => {
        const ferret = first(invocation, 'ferret');
        const caller = text(invocation, 'session');
        const message = joinedFrom(invocation.args.slice(1));
        const messageFile = text(invocation, 'message-file');
        const kind = text(invocation, 'kind');
        const until = text(invocation, 'until');
        const controller = new SendMessageController(
          gateway,
          files,
          output,
          caller === undefined ? {} : { callerFerret: caller },
          clock,
        );
        await controller.execute(ferret, {
          ...(message === undefined ? {} : { message }),
          ...(messageFile === undefined ? {} : { messageFile }),
          attachmentPaths: list(invocation, 'file'),
          ...(on(invocation, 'now') ? { now: true } : {}),
          ...(!peerReply && on(invocation, 'ask') ? { ask: true } : {}),
          ...(!peerReply && on(invocation, 'expect-reply') ? { expectReply: true } : {}),
          ...(until === undefined ? {} : { until }),
          ...(kind === undefined ? {} : { kind }),
          ...(on(invocation, 'wait') ? { wait: true } : {}),
          ...(on(invocation, 'json') ? { json: true } : {}),
        });
      });
    const answer = guarded(async invocation => {
      const ferret = first(invocation, 'ferret');
      const other = text(invocation, 'other');
      await new AnswerQuestionController(gateway, output).execute(ferret, {
        labels: invocation.args.slice(1),
        ...(other === undefined ? {} : { other }),
        responses: list(invocation, 'response'),
        ...(on(invocation, 'json') ? { json: true } : {}),
      });
    });
    const interrupt = guarded(async invocation => {
      await new InterruptController(gateway, output).execute(
        first(invocation, 'ferret'),
        on(invocation, 'json') ? { json: true } : {},
      );
    });
    const compactAt = guarded(async invocation => {
      await new CompactAtController(gateway, output).run(
        first(invocation, 'ferret'),
        invocation.args[1],
        on(invocation, 'json') ? { json: true } : {},
      );
    });

    const queuePorts = {
      gateway: new ClientQueueGateway(ctx.client),
      out: { report: (message: string) => ctx.io.out(`${message}\n`) },
    };
    const notReady =
      (verb: string): VerbHandler =>
      async () => {
        ctx.io.err(`fy ${verb} is not ready yet in this version of Conversation.\n`);
        return NOT_READY;
      };
    const mine: Record<string, VerbHandler> = {
      send: send(false),
      reply: send(true),
      answer,
      interrupt,
      'compact-at': compactAt,
      queue: queueVerb(queuePorts),
      'queue edit': queueEditVerb(queuePorts),
      'queue cancel': queueCancelVerb(queuePorts),
    };
    const theirs = readingVerbs({ client: ctx.client, io: ctx.io });
    const verbs: Record<string, VerbHandler> = { ...mine, ...theirs };
    for (const declared of manifest.actions.cli) verbs[declared.verb] ??= notReady(declared.verb);
    return { verbs } as never;
  },
});
