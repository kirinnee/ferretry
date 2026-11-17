import type { VerbInvocation } from '@ferretry/kernel/manifest';
import { SessionCommandError } from '../lib/session/errors.ts';
import {
  attachmentPaths,
  promptFilePath,
  promptWith,
  readAttachments,
  readPromptFile,
  requestIdOf,
} from '../lib/session/start-inputs.ts';
import { START_FLAGS_ELSEWHERE } from '../lib/session/start-request.ts';
import { StartSessionController } from '../lib/session/start-controller.ts';
import { choice, count, joined, list as listOf, on, text, typed } from '../lib/verb-io.ts';
import { BINARY, defineVerbs, type VerbContext } from './context.ts';

/**
 * The flags of `fy new` that are not Ferrets' start: a start's idempotency key and attachments are `fy start`'s alone.
 * The model routing (`--model`, `--effort`, `--auto`), `--task`, `--name <title>` and `--allow-scratch` are sent with
 * the start.
 */
const NEW_FLAGS_ELSEWHERE = ['request-id', 'file', 'f'];

/**
 * How a refused flag is named back to the caller: a flag with a short spelling is named by both (`-f/--file`), whichever
 * the caller typed (the shell's parser hands `-f` over under the key `f`, so both keys must be refused, or `new -f a.png`
 * would be accepted and the file silently dropped); any other by its long spelling.
 */
const REFUSED_SPELLING: Readonly<Record<string, string>> = { file: '-f/--file', f: '-f/--file' };

/** Refuses, by name, a typed flag whose value has no field in Ferrets' routes. */
function refuseElsewhere(invocation: VerbInvocation, names: readonly string[], verb: string): void {
  const found = [
    ...new Set(names.filter(name => typed(invocation, name)).map(name => REFUSED_SPELLING[name] ?? `--${name}`)),
  ];
  if (found.length > 0)
    throw new SessionCommandError(
      `${found.join(', ')}: not taken by \`${BINARY} ${verb}\` in this version of Ferretry (another plugin decides it now)`,
    );
}

const start = (role: 'start' | 'new', { api, environment, env, readText, readBytes, verb, json }: VerbContext) =>
  verb(async (invocation, presenter) => {
    refuseElsewhere(invocation, role === 'start' ? START_FLAGS_ELSEWHERE : NEW_FLAGS_ELSEWHERE, role);
    // v4 declared `--compact-at <tokens|auto>` with a REQUIRED argument. The shell's parser reads a bare flag as a
    // switch (`true`), which `text()` drops: say so here, before anything is read or sent, instead of starting without it.
    if (typed(invocation, 'compact-at') && text(invocation, 'compact-at') === undefined)
      throw new SessionCommandError('--compact-at: needs a value. Use auto, or a token count like 250k or 250000.');
    const mode = text(invocation, 'mode') ?? 'auto';
    if (mode !== 'auto' && mode !== 'interactive') throw new SessionCommandError('--mode is auto or interactive');
    const agent = text(invocation, 'agent', 'a', 'runtime');
    const teammate = text(invocation, 'teammate');
    const parent = role === 'start' ? text(invocation, 'parent') : undefined;
    const harness = text(invocation, 'harness');
    const login = text(invocation, 'login');
    const pack = text(invocation, 'pack');
    const cwd = text(invocation, 'cwd');
    const filePath = promptFilePath(invocation);
    const requestId = requestIdOf(invocation);
    const prompt =
      filePath === undefined
        ? joined(invocation.args)
        : promptWith(role, joined(invocation.args), await readPromptFile(filePath, readText));
    // `-f/--file` (start only): files for the opening message, read as bytes here and sent inline.
    const filePaths = role === 'start' ? attachmentPaths(invocation) : [];
    if (filePaths.length > 0 && prompt === undefined)
      throw new SessionCommandError(
        'attachments belong to an opening message: give a prompt (arguments and/or --prompt-file), or start bare without -f',
      );
    const initialAttachments = await readAttachments(filePaths, readBytes);
    const auto = role === 'new' && on(invocation, 'auto');
    // Today's `fy new` refinement: a sub-ferret names its runtime, or lets Ferretry pick one.
    if (role === 'new' && auto && agent !== undefined)
      throw new SessionCommandError('--auto picks the runtime; do not name one');
    if (role === 'new' && !auto && agent === undefined)
      throw new SessionCommandError('name a --runtime, or pass --auto');
    // v4 checked only a folder that was NAMED: `--cwd`, or a person's own (a ferret's helper otherwise runs in its parent's).
    const insideFerret = (env?.FY_SESSION_ID ?? '').trim() !== '';
    const allowScratch =
      role !== 'new'
        ? undefined
        : on(invocation, 'allow-scratch')
          ? true
          : cwd !== undefined || !insideFerret
            ? false
            : undefined;
    const title = text(invocation, 'name');
    const label = text(invocation, 'label');
    // `--task` is the flag's former name: still read, no longer declared or listed.
    const task = text(invocation, 'task', 'card');
    const model = text(invocation, 'model');
    const effort = text(invocation, 'effort');
    const fast = choice(invocation, 'fast');
    const remoteControl = choice(invocation, 'rc');
    const compactAt = text(invocation, 'compact-at');
    const harnessFlags = listOf(invocation, 'harness-flag');
    const numbers = {
      interval: count(invocation, 'interval'),
      turnTimeout: count(invocation, 'turn-timeout'),
      nudgeAfter: count(invocation, 'nudge-after'),
      stallKillAfter: count(invocation, 'stall-kill-after'),
      directMax: count(invocation, 'direct-max'),
      maxSnapshots: count(invocation, 'max-snapshots'),
    };
    await new StartSessionController(api, presenter, environment, BINARY).execute({
      mode,
      ...(on(invocation, 'teammate-fallback') ? { teammateFallback: true } : {}),
      ...(title === undefined ? {} : { title }),
      ...(label === undefined ? {} : { label }),
      ...(task === undefined ? {} : { card: task }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(fast === undefined ? {} : { fast }),
      ...(remoteControl === undefined ? {} : { remoteControl }),
      ...(compactAt === undefined ? {} : { compactAt }),
      ...(harnessFlags.length === 0 ? {} : { harnessFlags }),
      ...(auto ? { auto: true } : {}),
      ...(allowScratch === undefined ? {} : { allowScratch }),
      ...Object.fromEntries(Object.entries(numbers).filter(([, value]) => value !== undefined)),
      ...(agent === undefined ? {} : { agent }),
      ...(teammate === undefined ? {} : { teammate }),
      ...(parent === undefined ? {} : { parent }),
      ...(harness === undefined ? {} : { harness }),
      ...(login === undefined ? {} : { login }),
      ...(pack === undefined ? {} : { pack }),
      ...(role === 'start' && on(invocation, 'detach') ? { detach: true } : {}),
      ...(cwd === undefined ? {} : { cwd }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(initialAttachments.length === 0 ? {} : { initialAttachments }),
      ...(requestId === undefined ? {} : { requestId }),
      ...json(invocation),
    });
  });

export default defineVerbs(c => ({
  'start [prompt...]': start('start', c),
  'new [words...]': start('new', c),
}));
