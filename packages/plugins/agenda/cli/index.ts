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
import { type Flags, type GrammarName, readVerb } from './lib/verb-flags.ts';

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

    async function open(verb: 'open' | 'roll', invocation: VerbInvocation, all: boolean): Promise<number> {
      const read = readVerb(verb, invocation);
      if (!read.ok) return fail(read.message);
      const given = read.flags as { readonly limit?: string; readonly after?: string; readonly json?: boolean };
      const limit = text(given.limit);
      if (limit !== undefined && !/^[1-9][0-9]*$/u.test(limit))
        return fail('--limit is a whole number of asks, 1 or more');
      if (limit !== undefined && Number(limit) > AGENDA_OPEN_MAX_LIMIT)
        return fail(`--limit is at most ${String(AGENDA_OPEN_MAX_LIMIT)}`);
      let after = text(given.after);
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
      if (given.json === true) say(JSON.stringify({ sessions, ...(next === undefined ? {} : { next }) }, null, 2));
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
    /** What a refused flag or word costs: the sentence, and exit 1 as v4's parser did (an unknown SUB-VERB is the shell's exit 2). */
    const refused = (message: string): number => {
      io.err(`${message}\n`);
      return 1;
    };
    /** One item verb: its grammar reads the words as typed, and the controller does the rest; a failure is its sentence, exit 1. */
    const item =
      (verb: GrammarName, run: (c: AgendaController, args: readonly string[], flags: Flags) => Promise<void>) =>
      async (invocation: VerbInvocation): Promise<number> => {
        const read = readVerb(verb, invocation);
        if (!read.ok) return refused(read.message);
        try {
          await run(controller(), read.args, read.flags);
        } catch (error) {
          io.err(`${error instanceof Error ? error.message : String(error)}\n`);
          return 1;
        }
        return 0;
      };

    return {
      verbs: {
        agenda: async invocation => await open('roll', invocation, true),
        'agenda add [ask...]': item('add', async (c, args, f) => void (await c.add(args, f))),
        'agenda edit <id>': item('edit', async (c, [id], f) => void (await c.edit(id as string, f))),
        'agenda answer <id> <text...>': item(
          'answer',
          async (c, [id, ...words], f) => void (await c.answer(id as string, words, f)),
        ),
        'agenda rest <id>': item('rest', async (c, [id], f) => void (await c.rest(id as string, f))),
        'agenda log <id>': item('log', async (c, [id], f) => void (await c.log(id as string, f))),
        'agenda merge <into> <from>': item(
          'merge',
          async (c, [into, from], f) => void (await c.merge(into as string, from as string, f)),
        ),
        'agenda split <id> <ask...>': item(
          'split',
          async (c, [id, ...words], f) => void (await c.split(id as string, words, f)),
        ),
        'agenda step <id> <n>': item(
          'step',
          async (c, [id, n], f) => void (await c.step(id as string, n as string, f)),
        ),
        'agenda show <id>': item('show', async (c, [id], f) => void (await c.show(id as string, f))),
        'agenda patch <id>': item('patch', async (c, [id], f) => void (await c.patch(id as string, f))),
        'agenda ls': item('ls', async (c, _args, f) => void (await c.list(f))),
        'agenda history': item('history', async (c, _args, f) => void (await c.history(f))),
        'agenda needs-info <id>': item('needs-info', async (c, [id], f) => void (await c.needsInfo(id as string, f))),
        'agenda discuss <id>': item('discuss', async (c, [id], f) => void (await c.discuss(id as string, f))),
        'agenda surface <id>': item('surface', async (c, [id], f) => void (await c.surface(id as string, f))),
        'agenda snooze <id>': item('snooze', async (c, [id], f) => void (await c.snooze(id as string, f))),
        'agenda unsnooze <id>': item('unsnooze', async (c, [id], f) => void (await c.unsnooze(id as string, f))),
        'agenda send-now': item('send-now', async (c, _args, f) => void (await c.sendNow(f))),
        'agenda done <id>': item('done', async (c, [id], f) => void (await c.resolve(id as string, f))),
        'agenda dismiss <id>': item('dismiss', async (c, [id], f) => void (await c.dismiss(id as string, f))),
        'agenda open': async invocation => await open('open', invocation, false),

        'agenda mode': async invocation => {
          const read = readVerb('mode', invocation);
          if (!read.ok) return refused(read.message);
          if (read.ferret === undefined || read.ferret.trim() === '') return fail('say which ferret: --ferret <id>');
          const state = read.args[0]?.trim().toLowerCase();
          if (state !== undefined && state !== 'on' && state !== 'off')
            return fail(`agenda mode is "on" or "off", not "${read.args[0] ?? ''}" — leave it out to read it`);
          const params = { ferretId: read.ferret.trim() };
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
          const read = readVerb('clear', invocation);
          if (!read.ok) return refused(read.message);
          const given = read.flags as {
            readonly agents?: boolean;
            readonly yes?: boolean;
            readonly dryRun?: boolean;
            readonly json?: boolean;
          };
          if (given.agents !== true)
            return fail(
              'say what to clear: `agenda clear --agents` clears every open ask on the agent ferrets’ boards',
            );
          const found = AgendaClearAgentsResultSchema.parse(
            await client.call('POST /v1/agenda/clear-agents', { body: { dryRun: true } }),
          );
          if (given.dryRun === true) {
            say(`would clear ${describeClear(found)}`);
            return 0;
          }
          if (found.cleared === 0) {
            say('nothing to clear: the agent ferrets have no open asks');
            return 0;
          }
          if (given.yes !== true) {
            if (prompt === undefined)
              return fail(
                `this would dismiss ${describeClear(found)} and nobody can be asked here: re-run with --yes to go ahead`,
              );
            const answer = (await prompt.ask(`Dismiss ${describeClear(found)}? [y/N]`)).trim().toLowerCase();
            if (answer !== 'y' && answer !== 'yes') {
              say('Nothing was cleared.');
              return 0;
            }
          }
          const done = AgendaClearAgentsResultSchema.parse(
            await client.call('POST /v1/agenda/clear-agents', { body: {} }),
          );
          if (given.json === true) say(JSON.stringify(done, null, 2));
          else say(`cleared ${describeClear(done)}`);
          // The dry run said what would go; a clear that dismissed fewer left asks open, and says so rather than succeeding.
          if (done.cleared < found.cleared)
            return fail(
              `only ${describeClear(done)} were cleared, of the ${describeClear(found)} it listed: the rest are still open (see \`fy agenda ls --session <id>\`)`,
            );
          return 0;
        },

        notify: async invocation => {
          const ferret = text(invocation.options.ferret);
          if (ferret === undefined) return fail('no ferret id — pass --ferret <id>');
          // `--ping` is v4's spelling of `--buzz`. Help names only `--buzz` (help.test.ts), but agents' old instructions still say `--ping`.
          // It is no declared switch, so `--ping "summary"` reads the summary as its value: that word is given back.
          const ping = invocation.options.ping;
          const buzzes = flag(invocation, 'buzz') || (ping !== undefined && ping !== false);
          const words = typeof ping === 'string' ? [ping, ...invocation.args] : invocation.args;
          let request: ReturnType<typeof composeNoticeRequest>;
          try {
            request = composeNoticeRequest(words, {
              body: text(invocation.options.body),
              buzz: buzzes,
            });
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
          await client.call('POST /v1/ferrets/:ferretId/agenda', { params: { ferretId: ferret }, body: request });
          say(`Sent. The owner sees it in this ferret's agenda${buzzes ? ' and their phone buzzes' : ''}.`);
          return 0;
        },
      },
    };
  },
});
