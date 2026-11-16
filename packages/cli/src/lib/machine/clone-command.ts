import {
  CLONE_REVIEW_STALE,
  CLONE_RUNNABLE_KINDS,
  type CloneBundle,
  type CloneDecisions,
  type CloneReview,
} from '@ferretry/plugin-runtimes/contract';
import { requireMayApply, runChange } from './change.ts';

import { type MachineDeps, MachineCommandError, type MachineWriteOptions } from './ports.ts';
import {
  type CloneChoiceFlags,
  cloneNeedsYes,
  loginProblems,
  parseLoginFlags,
  pendingBoth,
  pendingLogins,
  renderCloneDiff,
  renderItemDetail,
  resolveCloneChoices,
} from './clone-update.ts';

/** The flags `machine clone` takes, as commander parsed them. */
export interface CloneOptions {
  readonly replace?: boolean;
  readonly alongside?: boolean;
  readonly skip?: readonly string[];
  readonly theirs?: readonly string[];
  readonly mine?: readonly string[];
  readonly remove?: readonly string[];
  readonly login?: readonly string[];
  readonly forget?: string;
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  readonly json?: boolean;
}

/** How many wrong answers one question takes before the copy stops rather than ask for ever. */
const ANSWER_ATTEMPTS = 3;

/**
 * Whether the bundle carries anything a copy would make this machine RUN that the person has not left out: a component
 * of a kind that can run something, or a login configured from the environment. The daemon's review lists exactly what
 * each would run; this only decides whether to ask first, so it errs to the safe side and asks for any component of
 * those kinds (`mcp/notes`, `hooks/guard`), a carried `--skip` aside.
 */
function bringsRunnables(bundle: CloneBundle, skip: readonly string[]): boolean {
  const components = CLONE_RUNNABLE_KINDS.some(kind =>
    Object.keys(bundle.components[kind] ?? {}).some(name => !skip.includes(`${kind}/${name}`)),
  );
  return components || bundle.credentials.some(credential => credential.store === 'environment');
}

const list = (values: readonly string[] | undefined): readonly string[] => values ?? [];

/** The choice flags an update takes and a first copy, an alongside copy or a replace has no use for. */
function updateOnlyFlags(options: CloneOptions): string[] {
  return [
    ...(list(options.theirs).length > 0 ? ['--theirs'] : []),
    ...(list(options.mine).length > 0 ? ['--mine'] : []),
    ...(list(options.remove).length > 0 ? ['--remove'] : []),
    ...(list(options.login).length > 0 ? ['--login'] : []),
  ];
}

/**
 * `machine clone [file]`: repeat an earlier copy as an update, or copy for the first time.
 *
 * ## Which copy it is
 * `--replace` and `--alongside` are the two explicit ones and never look at an earlier copy. Without either,
 * the daemon reviews the export against this machine: when it has been copied from before (or probably has)
 * the copy is an UPDATE of only what differs; otherwise it is the first copy, alongside, as it always was.
 *
 * ## What it can never do
 * No flag, answer or mode here deletes, empties, overwrites or re-points a login, a token, a secret, an
 * account default or a second factor. A login the setup carries is matched to one here, or becomes an empty
 * slot; what the daemon writes for it is decided by the daemon, and this command only passes its review
 * back with the person's choices. `--forget` drops the record of one source and nothing else.
 */
export async function runClone(
  deps: MachineDeps,
  file: string | undefined,
  bundle: CloneBundle | undefined,
  options: CloneOptions,
): Promise<void> {
  const bin = deps.binaryName;
  if (options.forget !== undefined) {
    await forgetSource(deps, file, options);
    return;
  }
  if (file === undefined || bundle === undefined) {
    throw new MachineCommandError(
      `Name the setup to copy: ${bin} machine clone <file> (the output of \`${bin} machine export\` on the other machine).`,
    );
  }
  if (options.replace === true && options.alongside === true) {
    throw new MachineCommandError('--replace starts over and --alongside adds beside what is here. Pick one.');
  }
  if (options.replace === true || options.alongside === true) {
    const strays = updateOnlyFlags(options);
    if (strays.length > 0) {
      throw new MachineCommandError(
        `${strays.join(', ')} choose between two versions of an item, which only an update has. ${options.replace === true ? '--replace' : '--alongside'} copies everything.`,
      );
    }
    await copyWhole(deps, bundle, options, options.replace === true ? 'replace' : 'alongside');
    return;
  }
  await requireMayApply(deps);
  const review = await deps.gateway.reviewClone({ bundle });
  if (review.mode === 'update') await updateFrom(deps, bundle, review, options);
  else await firstCopy(deps, bundle, review, options);
}

/** `--forget <source>`: the record of one source, and nothing else. */
async function forgetSource(deps: MachineDeps, file: string | undefined, options: CloneOptions): Promise<void> {
  const source = options.forget ?? '';
  const others = [
    ...(file === undefined ? [] : [file]),
    ...(options.replace === true ? ['--replace'] : []),
    ...(options.alongside === true ? ['--alongside'] : []),
    ...(list(options.skip).length > 0 ? ['--skip'] : []),
    ...updateOnlyFlags(options),
  ];
  if (others.length > 0) {
    throw new MachineCommandError(
      `--forget stands alone: it only drops the record of ${source}. Remove ${others.join(', ')}.`,
    );
  }
  const effect = `the next copy from ${source} starts as if there had been none. Nothing copied, no login and no secret is touched.`;
  if (options.dryRun === true) {
    deps.out.report(`Dry run: ${effect}`);
    return;
  }
  await requireMayApply(deps);
  const forgotten = await deps.gateway.forgetCloneSource(source);
  if (options.json === true) {
    deps.out.report(JSON.stringify({ source, forgotten }, null, 2));
    return;
  }
  if (forgotten) deps.out.success(`Forgot ${source}: ${effect}`);
  else deps.out.report(`There is no record of ${source}, so there is nothing to forget.`);
}

/** Today's copy: everything arrives, and a name already taken becomes `-2`. `--replace` asks first. */
async function copyWhole(
  deps: MachineDeps,
  bundle: CloneBundle,
  options: CloneOptions,
  mode: 'alongside' | 'replace',
): Promise<void> {
  const skip = list(options.skip);
  // A copy that brings commands to run here always asks first, like a replace: the preview above the
  // question is the only place a person sees them.
  const runs = bringsRunnables(bundle, skip);
  const outcome = await runChange(deps, {
    change: {
      kind: 'clone.import',
      mode,
      bundle: { ...bundle },
      ...(skip.length === 0 ? {} : { skip: [...skip] }),
    },
    destructive: mode === 'replace' || runs,
    options: writeOf(options),
  });
  if (outcome !== undefined && options.json !== true) reportSlots(deps);
}

/** The first copy from a source: as today, alongside, now with a login this machine already has reused. */
async function firstCopy(
  deps: MachineDeps,
  bundle: CloneBundle,
  review: CloneReview,
  options: CloneOptions,
): Promise<void> {
  const strays = updateOnlyFlags(options);
  if (strays.length > 0) {
    throw new MachineCommandError(
      `${strays.join(', ')} choose between two versions of an item, and ${review.source.name} has not been copied here before, so there is only one version. Leave an item out with --skip <item>.`,
    );
  }
  // A dry run asked for as data is the review itself; asked for as words it is the full preview below.
  if (options.dryRun === true && options.json === true) {
    deps.out.report(JSON.stringify(review, null, 2));
    return;
  }
  await copyWhole(deps, bundle, options, 'alongside');
}

/** Say where the sign-ins to do are, after a copy that may have added empty slots. */
function reportSlots(deps: MachineDeps): void {
  deps.out.report(`Sign in to any copied login that is new here: \`${deps.binaryName} login ls\` lists each one.`);
}

/** Ask one question until it has a usable answer, or give up after a few so a script never hangs. */
async function askUntil<T>(
  deps: MachineDeps,
  question: string,
  read: (answer: string) => T | undefined,
): Promise<T | undefined> {
  for (let attempt = 0; attempt < ANSWER_ATTEMPTS; attempt += 1) {
    const found = read((await deps.prompt.ask(question)).trim().toLowerCase());
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A repeat copy: show what differs, settle every choice, and apply exactly the review that was shown. */
async function updateFrom(
  deps: MachineDeps,
  bundle: CloneBundle,
  review: CloneReview,
  options: CloneOptions,
): Promise<void> {
  const flags: CloneChoiceFlags = {
    theirs: list(options.theirs),
    mine: list(options.mine),
    remove: list(options.remove),
    skip: list(options.skip),
  };
  const logins = parseLoginFlags(list(options.login));
  const resolved = resolveCloneChoices(review, flags);
  const problems = [...resolved.problems, ...loginProblems(review, logins)];
  if (problems.length > 0) throw new MachineCommandError(`${problems.join('\n')}\nNothing was changed.`);
  const decisions: Record<string, CloneDecisions[string]> = { ...resolved.decisions };
  const binaryName = deps.binaryName;
  const show = (): string => renderCloneDiff(review, { decisions, logins, binaryName });

  if (options.dryRun === true) {
    deps.out.report(options.json === true ? JSON.stringify(review, null, 2) : show());
    if (options.json !== true) deps.out.report('Dry run: nothing was changed.');
    return;
  }
  if (options.json !== true) deps.out.report(show());

  await settleBoth(deps, review, decisions, options);
  await settleLogins(deps, review, logins, options);

  const nothing =
    review.items.length === 0 &&
    review.same.probable === 0 &&
    review.logins.every(login => login.outcome === 'matched');
  if (nothing) {
    if (options.json !== true)
      deps.out.success(`Everything from ${review.source.name} is already here. Nothing to copy.`);
    else deps.out.report(JSON.stringify(review, null, 2));
    return;
  }
  try {
    const outcome = await runChange(deps, {
      change: {
        kind: 'clone.import',
        mode: 'update',
        bundle: { ...bundle },
        decisions: { ...decisions },
        ...(Object.keys(logins).length === 0 ? {} : { logins: { ...logins } }),
        reviewed: review.fingerprint,
      },
      destructive: cloneNeedsYes(review, decisions, logins),
      options: writeOf(options),
    });
    const addsSlot = review.logins.some(login => login.outcome === 'slot' || logins[login.sourceId] === 'slot');
    if (outcome !== undefined && options.json !== true && addsSlot) reportSlots(deps);
  } catch (error) {
    if (error instanceof Error && error.message.includes(CLONE_REVIEW_STALE)) {
      throw new MachineCommandError(
        `${CLONE_REVIEW_STALE} Nothing was changed. Run \`${binaryName} machine clone <file> --dry-run\` to see the new review.`,
      );
    }
    throw error;
  }
}

/** Every both-changed item needs a choice: ask on a terminal, refuse naming each otherwise. Nothing is pre-selected. */
async function settleBoth(
  deps: MachineDeps,
  review: CloneReview,
  decisions: Record<string, CloneDecisions[string]>,
  options: CloneOptions,
): Promise<void> {
  const pending = pendingBoth(review, decisions);
  if (pending.length === 0) return;
  const canAsk = deps.interactive && options.yes !== true && options.json !== true;
  if (!canAsk) {
    throw new MachineCommandError(
      [
        `Both machines changed ${pending.length === 1 ? 'this' : 'these'}, and nothing is chosen for you:`,
        ...pending.map(item => `  ${item.ref}`),
        `Choose each with --theirs <item> to take ${review.source.name}'s, or --mine <item> to keep yours. Nothing was changed.`,
      ].join('\n'),
    );
  }
  for (const item of pending) {
    const question = `${item.ref}: both sides changed it. [k]eep mine / [t]ake theirs / [s]how both`;
    let chosen: 'keep' | 'take' | undefined;
    for (let looks = 0; looks <= ANSWER_ATTEMPTS && chosen === undefined; looks += 1) {
      const answer = await askUntil<'keep' | 'take' | 'show'>(deps, question, text => {
        if (text === 'k' || text === 'keep') return 'keep';
        if (text === 't' || text === 'take' || text === 'theirs') return 'take';
        if (text === 's' || text === 'show') return 'show';
        return undefined;
      });
      if (answer === undefined) break;
      if (answer === 'show') deps.out.report(renderItemDetail(item, review.source.name));
      else chosen = answer;
    }
    if (chosen === undefined) throw new MachineCommandError(`No choice was made for ${item.ref}. Nothing was changed.`);
    decisions[item.ref] = chosen;
  }
}

/** A sign-in the daemon cannot match to one login here: the person says which, or asks for an empty slot. */
async function settleLogins(
  deps: MachineDeps,
  review: CloneReview,
  logins: Record<string, string>,
  options: CloneOptions,
): Promise<void> {
  const pending = pendingLogins(review, logins);
  if (pending.length === 0) return;
  const canAsk = deps.interactive && options.yes !== true && options.json !== true;
  if (!canAsk) {
    throw new MachineCommandError(
      [
        'These logins could be more than one login here, and nothing picks one for you:',
        ...pending.map(login => `  ${login.sourceId}: ${(login.candidates ?? []).join(', ')}`),
        'Answer each with --login <source login>=<login here>, or =slot for a new empty one. Nothing was changed.',
      ].join('\n'),
    );
  }
  for (const login of pending) {
    const candidates = login.candidates ?? [];
    const picked = await askUntil(
      deps,
      `Which login here is ${login.sourceId}? ${candidates.join(' / ')} / slot (a new empty one)`,
      text => (text === 'slot' || candidates.includes(text) ? text : undefined),
    );
    if (picked === undefined) {
      throw new MachineCommandError(`No login was chosen for ${login.sourceId}. Nothing was changed.`);
    }
    logins[login.sourceId] = picked;
  }
}

/** The write flags of a copy, apart from the choices that are only its own. */
const writeOf = (options: CloneOptions): MachineWriteOptions => ({
  ...(options.dryRun === true ? { dryRun: true } : {}),
  ...(options.yes === true ? { yes: true } : {}),
  ...(options.json === true ? { json: true } : {}),
});
