import { implementCli, type VerbInvocation } from '@ferretry/kernel/manifest';
import {
  type AnalyticsResponse,
  type BudgetsView,
  isTimeZone,
  PERFORMANCE_PROFILE_DEFAULT_SECONDS,
  PERFORMANCE_PROFILE_MAX_SECONDS,
  PERFORMANCE_PROFILE_MIN_SECONDS,
  type PerformanceProfileView,
  PerformanceProfileViewSchema,
  type PerformanceReport,
  renderPerformanceReport,
  BudgetSchema,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import {
  BudgetEditError,
  budgetInFile,
  budgetWords,
  editedBudget,
  parseLevel,
  sameBudget,
  withLoginBudget,
  withTimeZone,
} from './lib/budget.ts';
import { renderAnalytics } from './lib/render.ts';

const OK = 0;
const FAILED = 1;
const USAGE = 2;

/** The one file budgets and their time zone live in. */
const USAGE_FILE = 'usage.yaml';

/** How often a finished window is asked for, and how long past its end before giving up. */
const POLL_MS = 1_000;
const GRACE_MS = 60_000;

interface ConfigFileView {
  readonly path: string;
  readonly exists: boolean;
  readonly text: string;
  readonly etag: string;
}
interface ConfigPutResult {
  readonly outcome: 'applied' | 'pending';
  readonly pending?: { readonly changes: readonly string[] };
}

/** Said when `--out` is given: the shell hands a half no file facility to write the report with. */
export const UNSUPPORTED_OUT =
  '--out is not available yet: the CLI shell gives a plugin no way to write a file. Run `fy daemon profile --json > report.json` to keep the full report.';
/** Said when `--trace-syscalls` is given: the shell hands a half no process facility to run the tracer with. */
export const UNSUPPORTED_TRACE =
  '--trace-syscalls is not available yet: the CLI shell gives a plugin no way to start strace or fs_usage and read its output. Run the tracer yourself against the daemon, or profile without it.';

const wantsJson = (invocation: VerbInvocation): boolean => invocation.options.json === true;
const optionText = (invocation: VerbInvocation, name: string): string | undefined => {
  const value = invocation.options[name];
  return typeof value === 'string' ? value : undefined;
};

/**
 * Usage (cli half): `fy usage`, `fy login budget` and `fy daemon profile`. Each verb is one or two daemon calls; the query
 * language, the pricing and the measurement all live in the daemon, so the CLI and the app report the same numbers.
 */
export default implementCli(manifest, {
  build: ({ client, io }) => {
    const usage = (line: string): number => {
      io.err(`usage: ${line}\n`);
      return USAGE;
    };

    /** What one write did, in words, and whether it waits for the owner. */
    const writeWords = (result: ConfigPutResult, applied: string): string =>
      result.outcome === 'applied'
        ? applied
        : `Written, but held for the owner (${result.pending?.changes.join('; ') ?? 'it loosens spending'}); the tighter version stays in effect until they confirm it with \`fy config confirm ${USAGE_FILE}\`.`;

    return {
      verbs: {
        usage: async invocation => {
          const query = invocation.args.join(' ').trim();
          const response = await client.call<AnalyticsResponse>('GET /v1/usage/insights', {
            ...(query === '' ? {} : { query: { q: query } }),
          });
          io.out(wantsJson(invocation) ? JSON.stringify(response, null, 2) : renderAnalytics(response));
          return OK;
        },

        'login budget': async invocation => {
          const [id, ...rest] = invocation.args;
          if (id === undefined || rest.length > 0)
            return usage(
              'fy login budget <id> [--daily-trigger <usd>] [--daily-hard <usd>] [--weekly-trigger <usd>] [--weekly-hard <usd>] [--clear] [--time-zone <zone>] [--dry-run]',
            );
          try {
            const flag = (name: string): number | 'off' | undefined => {
              const text = optionText(invocation, name);
              return text === undefined ? undefined : parseLevel(name, text);
            };
            const edit = {
              dailyTrigger: flag('daily-trigger'),
              dailyHard: flag('daily-hard'),
              weeklyTrigger: flag('weekly-trigger'),
              weeklyHard: flag('weekly-hard'),
              clear: invocation.options.clear === true,
            };
            const setsLevel = [edit.dailyTrigger, edit.dailyHard, edit.weeklyTrigger, edit.weeklyHard].some(
              value => value !== undefined,
            );
            const zone = optionText(invocation, 'time-zone');
            if (edit.clear && setsLevel)
              throw new BudgetEditError('--clear removes the whole budget; give it alone, or give levels without it.');
            if (zone !== undefined && !isTimeZone(zone))
              throw new BudgetEditError(
                `"${zone}" is not a time zone this machine knows: use an IANA name such as America/Los_Angeles or UTC.`,
              );

            // A login the machine does not have is refused in v4's words, before anything is read or written. The list is
            // the daemon's own (Logins' port, the same one Usage reads), not a file.
            const known = await client.call<{ readonly logins: readonly { readonly id: string }[] }>('GET /v1/logins');
            if (!known.logins.some(login => login.id === id))
              throw new BudgetEditError(`No login "${id}" on this machine.`);

            const file = await client.call<ConfigFileView>('GET /v1/config/file', { query: { path: USAGE_FILE } });
            const text = file.exists ? file.text : '';
            const current = budgetInFile(text, id);
            if (current === null)
              throw new BudgetEditError(`${USAGE_FILE} does not check; fix it first (\`fy config check\`).`);

            if (!setsLevel && !edit.clear && zone === undefined) {
              const view = await client.call<BudgetsView>('GET /v1/usage/budgets');
              const standing = view.budgets.find(entry => entry.login === id);
              io.out(
                wantsJson(invocation)
                  ? JSON.stringify({ login: id, budget: current ?? null, standing: standing ?? null }, null, 2)
                  : `${id}: ${budgetWords(current)}.${standing?.pause === undefined ? '' : ` Paused: ${standing.pause.phrase}.`} What it spent: \`fy login check ${id}\`.`,
              );
              io.out('\n');
              return OK;
            }

            const next = editedBudget(current, edit);
            if (next !== undefined) {
              const parsed = BudgetSchema.safeParse(next);
              if (!parsed.success)
                throw new BudgetEditError(`That budget is not valid: ${parsed.error.issues[0]?.message ?? ''}.`);
            }
            const dryRun = invocation.options['dry-run'] === true;
            const lines: string[] = [];
            const result: Record<string, unknown> = { login: id, budget: next ?? null };
            let etag = file.etag;
            let body = text;
            if (!sameBudget(current, next)) {
              body = withLoginBudget(body, id, next);
              if (dryRun) lines.push(`Would set ${id}'s budget to ${budgetWords(next)}.`);
              else {
                const written = await client.call<ConfigPutResult & { readonly etag: string }>('PUT /v1/config/file', {
                  body: { path: USAGE_FILE, text: body, etag },
                });
                etag = written.etag;
                lines.push(writeWords(written, `${id}'s budget is now ${budgetWords(next)}.`));
                result.outcome = written.outcome;
              }
            } else lines.push(`${id}'s budget is already ${budgetWords(next)}.`);

            if (zone !== undefined) {
              body = withTimeZone(body, zone);
              if (dryRun) lines.push(`Would count budgets in ${zone}.`);
              else {
                const written = await client.call<ConfigPutResult>('PUT /v1/config/file', {
                  body: { path: USAGE_FILE, text: body, etag },
                });
                lines.push(writeWords(written, `Budgets now count days in ${zone}.`));
                result.timeZone = zone;
                result.timeZoneOutcome = written.outcome;
              }
            }
            io.out(`${wantsJson(invocation) ? JSON.stringify(result, null, 2) : lines.join('\n')}\n`);
            return OK;
          } catch (error) {
            if (!(error instanceof BudgetEditError)) throw error;
            io.err(`${error.message}\n`);
            return FAILED;
          }
        },

        'daemon profile': async invocation => {
          // TWO FLAGS THE SHELL CANNOT YET CARRY, REFUSED RATHER THAN IGNORED. A half is handed a daemon client and
          // the terminal (`CliContext`: `client`, `io`) and nothing else: no way to write a file (`--out`) and none to
          // start a program and read its output (`--trace-syscalls`: strace, or sudo fs_usage). Both are refused BEFORE a
          // window opens, so a person never waits thirty seconds for a report that then lacks what they asked for.
          if (invocation.options.out !== undefined) {
            io.err(UNSUPPORTED_OUT);
            return USAGE;
          }
          if (invocation.options['trace-syscalls'] !== undefined && invocation.options['trace-syscalls'] !== false) {
            io.err(UNSUPPORTED_TRACE);
            return USAGE;
          }
          const raw = optionText(invocation, 'seconds');
          const seconds =
            raw === undefined ? PERFORMANCE_PROFILE_DEFAULT_SECONDS : /^\d+$/u.test(raw.trim()) ? Number(raw) : NaN;
          if (!(seconds >= PERFORMANCE_PROFILE_MIN_SECONDS && seconds <= PERFORMANCE_PROFILE_MAX_SECONDS)) {
            io.err(
              `--seconds must be a whole number from ${String(PERFORMANCE_PROFILE_MIN_SECONDS)} to ${String(PERFORMANCE_PROFILE_MAX_SECONDS)}`,
            );
            return FAILED;
          }
          const started = PerformanceProfileViewSchema.parse(
            await client.call<PerformanceProfileView>('POST /v1/diagnostics/profile', { body: { seconds } }),
          );
          if (!wantsJson(invocation))
            io.err(`profiling the daemon for ${String(seconds)} s — leave it idle for an idle profile…`);

          let report: PerformanceReport | undefined = started.state === 'finished' ? started.report : undefined;
          if (report === undefined && started.state === 'running') {
            // A window is a few seconds long: ask once a second until it has closed, and give up a minute after it should have.
            for (let waited = 0; waited <= seconds * 1_000 + GRACE_MS; waited += POLL_MS) {
              await Bun.sleep(POLL_MS);
              const view = PerformanceProfileViewSchema.parse(
                await client.call<PerformanceProfileView>('GET /v1/diagnostics/profile/:id', {
                  params: { id: started.id },
                }),
              );
              if (view.state === 'finished') {
                report = view.report;
                break;
              }
            }
          }
          if (report === undefined) {
            io.err('the daemon did not finish the profile; is it still running? (fy daemon status)');
            return FAILED;
          }
          io.out(wantsJson(invocation) ? JSON.stringify(report) : renderPerformanceReport(report));
          return OK;
        },
      },
    };
  },
});
