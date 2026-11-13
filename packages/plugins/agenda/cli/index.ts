import { implementCli, type VerbInvocation } from '@ferretry/kernel/manifest';
import {
  AgendaClearAgentsResultSchema,
  AgendaModeSchema,
  AgendaOpenPageSchema,
  AGENDA_OPEN_MAX_LIMIT,
  type AgendaOpenPage,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { AgendaController } from './lib/controller.ts';
import { RouteAgendaGateway } from './lib/gateway.ts';
import { composeNoticeRequest } from './lib/notify.ts';
import type { IAgendaPrompt } from './lib/ports.ts';
import { describeClear, renderOpen } from './lib/render.ts';
import { type Flags, readFlags } from './lib/verb-flags.ts';

const text = (value: string | boolean | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
const flag = (invocation: VerbInvocation, name: string): boolean => invocation.options[name] === true;

/**
 * Agenda's `fy` half (§2.3): `fy agenda` and `fy agenda open` (what waits on you), `fy agenda mode` (today's `fy notify
 * agenda`), `fy agenda clear` and `fy notify`. Every call goes through the plugin client with the manifest's route keys;
 * a verb that raises a notice calls Asks' board route, which Agenda's manifest consumes through its `needs`.
 *
 * The item verbs are v4's, word for word (`add`, `edit`, `answer`, `rest`, `log`, `merge`, `split`, `step`, `show`,
 * `patch`, `ls`, `history`, `needs-info`, `discuss`, `surface`, `snooze`, `unsnooze`, `send-now`, `done`, `dismiss`):
 * each reaches Asks' board routes through `lib/gateway.ts`, acting on the ferret this process runs inside
 * (`FY_SESSION_ID`) or the one `--session` (or `--ferret`) names. `fy ask` is the shell's own list-and-answer for the
 * owner, whether or not this plugin is on. A clear that is not a dry run asks for `--yes`.
 */
export default implementCli(manifest, {
  build({ client, io, env, readText, clock, confirm }) {
    const fail = (message: string): number => {
      io.err(`${message}\n`);
      return 1;
    };
    const say = (message: string): void => io.out(`${message}\n`);

    async function open(invocation: VerbInvocation, all: boolean): Promise<number> {
      const limit = text(invocation.options.limit);
      if (limit !== undefined && !/^[1-9][0-9]*$/u.test(limit))
        return fail('--limit is a whole number of asks, 1 or more');
      if (limit !== undefined && Number(limit) > AGENDA_OPEN_MAX_LIMIT)
        return fail(`--limit is at most ${String(AGENDA_OPEN_MAX_LIMIT)}`);
      let after = text(invocation.options.after);
      const sessions: AgendaOpenPage['sessions'][number][] = [];
      let next: string | undefined;
      do {
        const page = AgendaOpenPageSchema.parse(
          await client.call('GET /v1/agenda/open', {
            query: { ...(after === undefined ? {} : { after }), ...(limit === undefined ? {} : { limit }) },
          }),
        );
        sessions.push(...page.sessions);
        next = page.next;
        after = page.next;
      } while (all && next !== undefined);
      if (flag(invocation, 'json')) say(JSON.stringify({ sessions, ...(next === undefined ? {} : { next }) }, null, 2));
      else say(renderOpen({ sessions, ...(next === undefined ? {} : { next }) }));
      return 0;
    }

    const prompt: IAgendaPrompt | undefined =
      io.isTty && confirm !== undefined
        ? { interactive: () => true, ask: async question => ((await confirm(question)) ? 'y' : 'n') }
        : undefined;
    const controller = (): AgendaController =>
      new AgendaController(
        new RouteAgendaGateway(client, env?.FY_SESSION_ID?.trim() || undefined),
        { success: message => io.out(`${message}\n`), diagnostic: message => io.err(`${message}\n`) },
        env?.FY_SESSION_ID?.trim() || undefined,
        readText === undefined ? undefined : { read: readText },
        () => {
          if (clock === undefined) throw new Error('this fy has no clock to read a time against');
          return clock.nowMs();
        },
        prompt,
      );
    /** One item verb: its positionals, its flags, and the controller; a failure is the controller's sentence, exit 1. */
    const item =
      (
        usage: string,
        needs: number,
        run: (c: AgendaController, args: readonly string[], flags: Flags) => Promise<void>,
      ) =>
      async (invocation: VerbInvocation): Promise<number> => {
        const { flags, args } = readFlags(invocation);
        if (args.length < needs) {
          io.err(`usage: fy agenda ${usage}\n`);
          return 2;
        }
        try {
          await run(controller(), args, flags);
        } catch (error) {
          io.err(`${error instanceof Error ? error.message : String(error)}\n`);
          return 1;
        }
        return 0;
      };

    return {
      verbs: {
        agenda: async invocation => await open(invocation, true),
        'agenda add [ask...]': item(
          'add --title "<what>" "<the ask>" …',
          0,
          async (c, args, f) => void (await c.add(args, f)),
        ),
        'agenda edit <id>': item('edit <id> [flags]', 1, async (c, [id], f) => void (await c.edit(id as string, f))),
        'agenda answer <id> <text...>': item(
          'answer <id> "<text>"',
          1,
          async (c, [id, ...words], f) => void (await c.answer(id as string, words, f)),
        ),
        'agenda rest <id>': item(
          'rest <id> --why "<what you are doing>"',
          1,
          async (c, [id], f) => void (await c.rest(id as string, f)),
        ),
        'agenda log <id>': item(
          'log <id> --reply "<text>" | --rest "<text>"',
          1,
          async (c, [id], f) => void (await c.log(id as string, f)),
        ),
        'agenda merge <into> <from>': item(
          'merge <into> <from>',
          2,
          async (c, [into, from], f) => void (await c.merge(into as string, from as string, f)),
        ),
        'agenda split <id> <ask...>': item(
          'split <id> --title "<what>" "<the new ask>" …',
          1,
          async (c, [id, ...words], f) => void (await c.split(id as string, words, f)),
        ),
        'agenda step <id> <n>': item(
          'step <id> <n> [--undo]',
          2,
          async (c, [id, n], f) => void (await c.step(id as string, n as string, f)),
        ),
        'agenda show <id>': item(
          'show <id> [--tab <name>] [--yaml]',
          1,
          async (c, [id], f) => void (await c.show(id as string, f)),
        ),
        'agenda patch <id>': item(
          'patch <id> [--file <path>]',
          1,
          async (c, [id], f) => void (await c.patch(id as string, f)),
        ),
        'agenda ls': item('ls', 0, async (c, _args, f) => void (await c.list(f))),
        'agenda history': item('history', 0, async (c, _args, f) => void (await c.history(f))),
        'agenda needs-info <id>': item(
          'needs-info <id> [--note <text>]',
          1,
          async (c, [id], f) => void (await c.needsInfo(id as string, f)),
        ),
        'agenda discuss <id>': item(
          'discuss <id> [--note <text>]',
          1,
          async (c, [id], f) => void (await c.discuss(id as string, f)),
        ),
        'agenda surface <id>': item(
          'surface <id> [--why <line>] [--now]',
          1,
          async (c, [id], f) => void (await c.surface(id as string, f)),
        ),
        'agenda snooze <id>': item(
          'snooze <id> --for <time> | --until <time>',
          1,
          async (c, [id], f) => void (await c.snooze(id as string, f)),
        ),
        'agenda unsnooze <id>': item(
          'unsnooze <id>',
          1,
          async (c, [id], f) => void (await c.unsnooze(id as string, f)),
        ),
        'agenda send-now': item('send-now', 0, async (c, _args, f) => void (await c.sendNow(f))),
        'agenda done <id>': item(
          'done <id> [answer flags]',
          1,
          async (c, [id], f) => void (await c.resolve(id as string, f)),
        ),
        'agenda dismiss <id>': item(
          'dismiss <id> [--note <text>]',
          1,
          async (c, [id], f) => void (await c.dismiss(id as string, f)),
        ),
        'agenda open': async invocation => await open(invocation, false),

        'agenda mode': async invocation => {
          const ferret = text(invocation.options.ferret);
          if (ferret === undefined) return fail('say which ferret: --ferret <id>');
          const state = invocation.args[0]?.trim().toLowerCase();
          if (state !== undefined && state !== 'on' && state !== 'off')
            return fail(`agenda mode is "on" or "off", not "${invocation.args[0] ?? ''}" — leave it out to read it`);
          const params = { ferretId: ferret };
          if (state === undefined) {
            const mode = AgendaModeSchema.parse(await client.call('GET /v1/ferrets/:ferretId/agenda-mode', { params }));
            say(`Agenda mode is ${mode.enabled ? 'on' : 'off'}. ${mode.note}`);
            return 0;
          }
          const switched = (await client.call<{ enabled: boolean; note: string }>(
            'PATCH /v1/ferrets/:ferretId/agenda-mode',
            {
              params,
              body: { enabled: state === 'on' },
            },
          )) as { enabled: boolean; note: string };
          say(`Agenda mode is now ${switched.enabled ? 'on' : 'off'}. ${switched.note}`);
          return 0;
        },

        'agenda clear': async invocation => {
          if (!flag(invocation, 'agents'))
            return fail(
              'say what to clear: `agenda clear --agents` clears every open ask on the agent ferrets’ boards',
            );
          const found = AgendaClearAgentsResultSchema.parse(
            await client.call('POST /v1/agenda/clear-agents', { body: { dryRun: true } }),
          );
          if (flag(invocation, 'dry-run')) {
            say(`would clear ${describeClear(found)}`);
            return 0;
          }
          if (found.cleared === 0) {
            say('nothing to clear: the agent ferrets have no open asks');
            return 0;
          }
          if (!flag(invocation, 'yes'))
            return fail(
              `this would dismiss ${describeClear(found)} and nobody can be asked here: re-run with --yes to go ahead`,
            );
          const done = AgendaClearAgentsResultSchema.parse(
            await client.call('POST /v1/agenda/clear-agents', { body: {} }),
          );
          say(flag(invocation, 'json') ? JSON.stringify(done, null, 2) : `cleared ${describeClear(done)}`);
          return 0;
        },

        notify: async invocation => {
          const ferret = text(invocation.options.ferret);
          if (ferret === undefined) return fail('no ferret id — pass --ferret <id>');
          let request: ReturnType<typeof composeNoticeRequest>;
          try {
            request = composeNoticeRequest(invocation.args, {
              body: text(invocation.options.body),
              buzz: flag(invocation, 'buzz'),
            });
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
          await client.call('POST /v1/ferrets/:ferretId/agenda', { params: { ferretId: ferret }, body: request });
          say(
            `Sent. The owner sees it in this ferret's agenda${flag(invocation, 'buzz') ? ' and their phone buzzes' : ''}.`,
          );
          return 0;
        },
      },
    };
  },
});
