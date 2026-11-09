/**
 * One conversion: preflight, then every step in order into a NEW folder, then `home.json` only if every step
 * finished. The v4 home is opened read-only and never written.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type LockProbe, preflight } from './preflight.ts';
import type { ConversionReport, StepReport } from './report.ts';
import { type HostFacts, STEPS, type Step } from './steps/index.ts';
import { LoginKeyHold } from './steps/login-keys.ts';
import { v4Paths } from './v4/layout.ts';
import { writeHomeJson } from './v5/home.ts';
import { v5Writer } from './v5/write.ts';

export interface ConvertOptions {
  readonly from: string;
  readonly to: string;
  readonly dryRun: boolean;
  readonly lock: LockProbe;
  readonly now: () => Date;
  /** The machine facts steps may read (service definitions, environment); absent reads none. */
  readonly host?: HostFacts;
  readonly steps?: readonly Step[];
  /**
   * The try-it preview (migration/v4-to-v5/preview/): a COPY that must never reach anything of the live v4. Every
   * ferret is written stopped with no launch command, pane handle, transcript pointer, credential hash or token
   * ledger row, no worktree ledger is carried, and the runtimes config switches auto-resume off. Absent, a normal
   * conversion: nothing here changes it.
   */
  readonly preview?: boolean;
  /**
   * With `preview`: the REAL v4 home the staged copy in `from` was taken from. A ferret whose folder is inside it, or
   * inside its `-worktrees` sibling, is written with the preview's own empty `workspace` folder instead.
   */
  readonly previewV4Home?: string;
  /**
   * With `preview`: the environment every preview ferret's shells get (the harness settings item `fy-preview`), so a
   * login shell finds the preview's `fy`. The preview driver owns it (`src/v5/preview-env.ts`).
   */
  readonly previewShellEnv?: Readonly<Record<string, string>>;
  /** With `preview`: the owner ran `prepare --owner` (see `StepContext.previewOwner`). */
  readonly previewOwner?: boolean;
}

export type ConvertResult =
  | { readonly kind: 'refused'; readonly problems: readonly string[] }
  | { readonly kind: 'done'; readonly report: ConversionReport };

/** `packages/core/kernel/host/home.ts` `openHome`: the folders a new v5 home starts with, each `0700`. */
export const V5_HOME_TREE = ['config', 'state', 'state/kernel', 'run', 'logs'] as const;

/** The accepted-record step reads what the others wrote; it is the one step the plain pass leaves out. */
const ACCEPTED_STEP = 'accepted-config';

/** What the plain (non-preview) conversion of the same v4 home would write under `config/`, from a dry run. */
async function plainConfigs(options: ConvertOptions, steps: readonly Step[]): Promise<ReadonlyMap<string, string>> {
  const plain = {
    v4: v4Paths(options.from),
    v5: v5Writer(options.to, { dryRun: true }),
    dryRun: true,
    loginKeys: new LoginKeyHold(),
    ...(options.host === undefined ? {} : { host: options.host }),
  };
  for (const step of steps) {
    if (step.id === ACCEPTED_STEP) continue;
    try {
      await step.run(plain);
    } catch {
      // A step that fails here leaves its files out: they then count as preview-authored (fail closed).
    }
  }
  return plain.v5.writtenConfigs();
}

export async function convert(options: ConvertOptions): Promise<ConvertResult> {
  const checked = await preflight(options.from, options.to, options.lock);
  if (!checked.ok) return { kind: 'refused', problems: checked.problems };

  if (!options.dryRun) await mkdir(options.to, { recursive: true, mode: 0o700 });
  const ctx = {
    v4: v4Paths(options.from),
    v5: v5Writer(options.to, { dryRun: options.dryRun }),
    dryRun: options.dryRun,
    ...(options.preview === true
      ? {
          preview: true,
          ...(options.previewV4Home === undefined ? {} : { previewV4Home: options.previewV4Home }),
          ...(options.previewShellEnv === undefined ? {} : { previewShellEnv: options.previewShellEnv }),
          ...(options.previewOwner === true ? { previewOwner: true } : {}),
        }
      : {}),
    loginKeys: new LoginKeyHold(),
    ...(options.host === undefined ? {} : { host: options.host }),
  };

  const steps = options.steps ?? STEPS;
  // A preview's authored files are found by comparison: a config file the preview wrote or changed differs from what the
  // plain conversion of the same v4 home writes. The plain pass is a dry run (nothing written) of every step that
  // writes config; a step that fails there leaves its files out, so they count as authored (fail closed).
  const withPlain = options.preview === true ? { ...ctx, plainConfigs: await plainConfigs(options, steps) } : ctx;

  const reports: StepReport[] = [];
  for (const step of steps) {
    try {
      reports.push(await step.run(withPlain));
    } catch (error) {
      // The message is the tool's own; a step never puts file content into an error.
      reports.push({
        id: step.id,
        title: step.title,
        status: 'failed',
        note: error instanceof Error ? error.message : String(error),
        kept: [],
        notCarried: step.notCarried,
        sealed: [],
      });
    }
  }

  const finished = reports.every(step => step.status === 'converted' || step.status === 'not-carried');
  const at = options.now();
  if (finished && !options.dryRun) {
    // The tree v5's openHome makes for a NEW home (it makes none for an existing one): without `logs/` fyd writes no
    // log at all, and `run/` holds its lock and sockets. Then home.json, last.
    for (const folder of V5_HOME_TREE) await mkdir(join(options.to, folder), { recursive: true, mode: 0o700 });
    await writeHomeJson(options.to, at, 'ferretry-v4-to-v5');
  }
  return {
    kind: 'done',
    report: {
      format: 1,
      tool: 'ferretry-v4-to-v5',
      from: options.from,
      to: options.to,
      at: at.toISOString(),
      dryRun: options.dryRun,
      steps: reports,
      complete: finished && !options.dryRun,
    },
  };
}
