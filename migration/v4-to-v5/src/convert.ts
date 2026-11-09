/**
 * One conversion: preflight, then every step in order into a NEW folder, then `home.json` only if every step
 * finished. The v4 home is opened read-only and never written.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type LockProbe, preflight } from './preflight.ts';
import type { ConversionReport, StepReport } from './report.ts';
import { type EnforcedConversion, type HostFacts, STEPS, type Step, type StepContext } from './steps/index.ts';
import { LoginKeyHold } from './steps/login-keys.ts';
import { type V4ConfigOverrides, v4Paths } from './v4/layout.ts';
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
  /** With `preview`: the user's real home folder (see `StepContext.previewUserHome`). */
  readonly previewUserHome?: string;
  /** With `preview`: login name to its harness, from the stage (see `StepContext.previewLoginHarnesses`). */
  readonly previewLoginHarnesses?: ReadonlyMap<string, 'claude' | 'codex'>;
  /** The person running it chose to drop uncarried settings or hooks layers (see `StepContext.dropUncarried`). */
  readonly dropUncarried?: boolean;
}

export type ConvertResult =
  | { readonly kind: 'refused'; readonly problems: readonly string[] }
  | { readonly kind: 'done'; readonly report: ConversionReport };

/** `packages/core/kernel/host/home.ts` `openHome`: the folders a new v5 home starts with, each `0700`. */
export const V5_HOME_TREE = ['config', 'state', 'state/kernel', 'run', 'logs'] as const;

/**
 * The steps the plain dry pass runs: the ones that write config (`V5Writer.config`). Nothing else changes what a config
 * file says, so the rest (agenda archives, conversations, ledgers) is not walked a second time. A test pins this list to
 * the step files that call `config(`.
 */
export const CONFIG_STEPS: ReadonlySet<string> = new Set([
  'settings',
  'daemon-settings',
  'lessons',
  'packs',
  'archive-setting',
]);

/** What the plain passes share with the real run beyond the v4 and v5 paths. */
type PlainExtra = Pick<StepContext, 'previewV4Home' | 'previewUserHome' | 'dropUncarried'>;

/**
 * What the plain (non-preview) conversion of the v4 home at `from` would write under `config/`, from a dry run (the
 * v4 home is only read). Used on the real home, and on the accepted-config step's view of what v4 ENFORCED, where
 * `overrides` give the accepted text of each held file in memory (nothing is copied or written anywhere).
 */
async function plainConfigs(
  from: string,
  to: string,
  host: HostFacts | undefined,
  steps: readonly Step[],
  extra: PlainExtra,
  overrides?: V4ConfigOverrides,
): Promise<EnforcedConversion> {
  const loginKeys = new LoginKeyHold();
  const plain = {
    ...extra,
    v4: { ...v4Paths(from), ...(overrides === undefined ? {} : { configOverrides: overrides }) },
    v5: v5Writer(to, { dryRun: true }),
    dryRun: true,
    loginKeys,
    ...(host === undefined ? {} : { host }),
  };
  const failed: string[] = [];
  const failedWhy: string[] = [];
  for (const step of steps) {
    if (!CONFIG_STEPS.has(step.id)) continue;
    try {
      // A step that fails here leaves its files out: they then count as preview-authored (fail closed), and the
      // enforced pass names it so the accepted-config step records nothing from it.
      const report = await step.run(plain);
      if (report.status === 'failed') {
        failed.push(step.id);
        failedWhy.push(report.note === undefined ? step.id : `${step.id}: ${report.note}`);
      }
    } catch (error) {
      failed.push(step.id);
      failedWhy.push(`${step.id}: ${error instanceof Error ? error.message : 'it threw'}`);
    }
  }
  return {
    configs: plain.v5.writtenConfigs(),
    failed,
    failedWhy,
    fingerprint: login => loginKeys.fingerprint(login),
  };
}

/** The plain dry conversion of the v4 home with the given config overrides (the accepted-config step's enforced view). */
export const dryConfigsOf =
  (from: string, to: string, host: HostFacts | undefined, steps: readonly Step[], extra: PlainExtra = {}) =>
  (overrides: V4ConfigOverrides): Promise<EnforcedConversion> =>
    plainConfigs(from, to, host, steps, extra, overrides);

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
          ...(options.previewUserHome === undefined ? {} : { previewUserHome: options.previewUserHome }),
          ...(options.previewLoginHarnesses === undefined
            ? {}
            : { previewLoginHarnesses: options.previewLoginHarnesses }),
        }
      : {}),
    ...(options.dropUncarried === true ? { dropUncarried: true } : {}),
    loginKeys: new LoginKeyHold(),
    ...(options.host === undefined ? {} : { host: options.host }),
  };

  const steps = options.steps ?? STEPS;
  // A preview's authored files are found by comparison: a config file the preview wrote or changed differs from what the
  // plain conversion of the same v4 home writes. The plain pass is a dry run (nothing written) of every step that
  // writes config; a step that fails there leaves its files out, so they count as authored (fail closed).
  // The plain passes resolve a component's real-home paths and drop layers exactly as this run does, so a file the
  // preview did not change is never mistaken for one it authored.
  const extra: PlainExtra = {
    ...(options.previewV4Home === undefined ? {} : { previewV4Home: options.previewV4Home }),
    ...(options.previewUserHome === undefined ? {} : { previewUserHome: options.previewUserHome }),
    ...(options.dropUncarried === true ? { dropUncarried: true } : {}),
  };
  const withEnforced = { ...ctx, dryConfigs: dryConfigsOf(options.from, options.to, options.host, steps, extra) };
  const withPlain =
    options.preview === true
      ? {
          ...withEnforced,
          plainConfigs: (await plainConfigs(options.from, options.to, options.host, steps, extra)).configs,
        }
      : withEnforced;

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
