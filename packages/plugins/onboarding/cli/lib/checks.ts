/**
 * The live check of each first-run step, read from the answer of a route the OWNING plugin declares.
 *
 * CONVENTION. A step is manifest metadata (`{ id, title, order }`, the snapshot's `OnboardingEntry`); it names no
 * route. The CLI therefore keeps one table, keyed `<plugin>:<id>`, that says which route of the owning plugin to call
 * and which fields of its answer mean "already done". The client refuses a route no manifest declares, so a table
 * entry cannot invent one. A step with no entry is asked, never looked for. Each reader parses only the fields it
 * names (loose objects): the owning plugin's contract stays its own.
 *
 * GAP(kernel): `OnboardingEntry` carries no check route or remedy; when the snapshot does, this table is read from it.
 * GAP(connections): no Connections step or route exists yet (relay, phone), so there is no entry for them.
 */
import { z } from 'zod';

/** What a step's check saw. */
export type Reading =
  | { readonly kind: 'found'; readonly line: string; readonly linked?: true }
  | { readonly kind: 'missing'; readonly line: string; readonly remedy: string }
  | { readonly kind: 'unreadable'; readonly reason: string };

export interface StepCheck {
  /** A route key the owning plugin's manifest declares. */
  readonly route: string;
  read(answer: unknown, bin: string): Reading;
}

const Loose = z.looseObject;

const UpdateViewSchema = Loose({ installed: Loose({ state: z.string(), version: z.unknown().optional() }).nullable() });
const LoginsSchema = Loose({
  logins: z.array(
    Loose({ store: z.string(), sharedWithTerminal: z.boolean().optional(), status: Loose({ word: z.string() }) }),
  ),
});
const NixSchema = z.discriminatedUnion('present', [
  Loose({ present: z.literal(true), version: z.string() }),
  Loose({ present: z.literal(false), consequence: z.string(), remedy: z.string() }),
]);
const RuntimesSchema = z.union([z.array(z.unknown()), Loose({ runtimes: z.array(z.unknown()) })]);

const unreadable = (reason: z.ZodError): Reading => ({
  kind: 'unreadable',
  reason: `the answer was not in a form this fy can read (${reason.issues[0]?.message ?? 'unknown'})`,
});

function harnessCheck(route: string, name: string): StepCheck {
  return {
    route,
    read(answer, bin) {
      const parsed = UpdateViewSchema.safeParse(answer);
      if (!parsed.success) return unreadable(parsed.error);
      const installed = parsed.data.installed;
      if (installed === null || installed.state !== 'ok')
        return {
          kind: 'missing',
          line: `${name} was not found on this machine.`,
          remedy: `Install ${name}, then run \`${bin} onboard\` again.`,
        };
      const version = typeof installed.version === 'string' ? ` ${installed.version}` : '';
      return { kind: 'found', line: `${name}${version} is installed.` };
    },
  };
}

/** A login is "signed in" when it works now or only needs a refresh; a host login is the harness's own, linked. */
const SIGNED_IN: ReadonlySet<string> = new Set(['ready', 'refresh_due']);

export const STEP_CHECKS: Readonly<Record<string, StepCheck>> = {
  'claude-code:harness': harnessCheck('GET /v1/claude-code/update', 'Claude Code'),
  'codex:harness': harnessCheck('GET /v1/codex/update', 'Codex'),
  'logins:login': {
    route: 'GET /v1/logins',
    read(answer, bin) {
      const parsed = LoginsSchema.safeParse(answer);
      if (!parsed.success) return unreadable(parsed.error);
      const working = parsed.data.logins.filter(login => SIGNED_IN.has(login.status.word));
      if (working.length === 0)
        return {
          kind: 'missing',
          line: 'No login is signed in yet.',
          remedy: `Run \`${bin} login add\` for one browser sign-in or one API key.`,
        };
      const linked = working.some(login => login.store === 'host' || login.sharedWithTerminal === true);
      const count = working.length === 1 ? 'A login is' : `${String(working.length)} logins are`;
      return linked
        ? { kind: 'found', line: `${count} signed in, linked to your terminal's own sign-in.`, linked: true }
        : { kind: 'found', line: `${count} signed in.` };
    },
  },
  'runtimes:runtimes': {
    route: 'GET /v1/runtimes',
    read(answer, bin) {
      const parsed = RuntimesSchema.safeParse(answer);
      if (!parsed.success) return unreadable(parsed.error);
      const list = Array.isArray(parsed.data) ? parsed.data : parsed.data.runtimes;
      if (list.length === 0)
        return {
          kind: 'missing',
          line: 'No runtime is set up yet.',
          remedy: `Run \`${bin} runtime scan\` to see what you could bring in, then \`${bin} runtime import\`.`,
        };
      return {
        kind: 'found',
        line: list.length === 1 ? 'A runtime is set up.' : `${String(list.length)} runtimes are set up.`,
      };
    },
  },
  'shells:nix': {
    route: 'GET /v1/shells/nix',
    read(answer) {
      const parsed = NixSchema.safeParse(answer);
      if (!parsed.success) return unreadable(parsed.error);
      return parsed.data.present
        ? { kind: 'found', line: `nix ${parsed.data.version} is on this machine.` }
        : { kind: 'missing', line: parsed.data.consequence, remedy: parsed.data.remedy };
    },
  },
};

export const checkFor = (plugin: string, id: string): StepCheck | undefined => STEP_CHECKS[`${plugin}:${id}`];
