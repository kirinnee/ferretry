/**
 * Archive setting: v4's `FYD_SESSION_ARCHIVE_AFTER_HOURS` environment variable → `archive.yaml` `afterHours`.
 *
 * v4 turned automatic session archiving on ONLY through that variable (`docs/session-archive.md` § Setting); the
 * default is off. v5 reads `archive.yaml` and no plugin reads the environment, so an owner's live value would be
 * lost without this step. It reads, first match wins:
 *
 *   1. the Linux user unit `fyd.service.d/*.conf` drop-ins (lexical order, a later one wins, as systemd applies
 *      them), then the unit `fyd.service` itself (drop-ins override the unit). The documented recipe is a drop-in
 *      `archive.conf`; `fy daemon install` rewrites the unit but never writes the variable;
 *   2. the macOS plist `~/Library/LaunchAgents/com.ferretry.fyd.plist` `EnvironmentVariables`;
 *   3. this process's own environment, last.
 *
 * WHY THIS ORDER: a daemon `fy daemon install` supervises sees ONLY its service definition (systemd and launchd
 * hand it nothing from a shell), so a value there is what the live daemon ran with, and is deliberate and persistent.
 * The converter's environment is incidental (a stale `export` in an owner's shell) and describes only a foreground
 * `fyd` started from that shell, so it is the fallback. A service definition that names another state home
 * (one unit per host, whatever `FY_HOME` says) is skipped: its value belonged to someone else's daemon. The
 * first source that NAMES the variable wins even when its value is `off` or invalid: v4 refused to boot on an
 * invalid one, so falling past it would write a setting no v4 daemon ever ran with.
 *
 * Not readable: `launchctl setenv` and `systemctl --user set-environment` live in the service manager's memory, and
 * an `EnvironmentFile=` can hold anything; none is opened or run. They are named in the report when relevant.
 *
 * The value is checked by v4's own parse rule (`parseArchiveAfter`). Absent, `off` or invalid writes NOTHING (v5's
 * default is off too) and says why in the summary, so the default stays off. A whole number v5 cannot hold
 * (over a year) is not carried either. Only the whole number is ever echoed.
 *
 * SCHEMA: `archive.yaml` is Ferrets' (`ArchiveConfigFile` and `ARCHIVE_MAX_HOURS` in
 * `packages/core/ferrets/contract/state.ts`). It is IMPORTED, never restated, so what this step writes is checked by the
 * very schema the daemon reads it with (one fact, one owner).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ARCHIVE_MAX_HOURS } from '@ferretry/core-ferrets/contract';
import { Document } from 'yaml';
import type { KeptItem, NotCarried, StepReport } from '../report.ts';
import {
  type ArchiveAfter,
  parseArchiveAfter,
  plistEnvironmentValue,
  systemdEnvironment,
  v4ServicePaths,
  V4_ARCHIVE_VARIABLE,
} from '../v4/archive-after.ts';
import { YAML_OPTIONS } from '../v4/config.ts';
import { pointsIntoTerminalFolder } from '../v4/link-chase.ts';
import { CONFIG_TARGETS } from '../v5/targets.ts';
import { configPath, v5ConfigProblem, type V5ConfigTarget } from '../v5/write.ts';
import type { Step, StepContext } from './index.ts';

/** Ferrets' own `archive.yaml`: its file name and the schema the daemon reads it with. */
export const ARCHIVE_CONFIG: V5ConfigTarget = CONFIG_TARGETS.ARCHIVE;

/** What a source said: where, and the raw value (`undefined` = it does not name the variable). */
interface Found {
  readonly source: string;
  readonly raw: string;
}

/** A source this tool could not settle: the step writes nothing and says so. */
class Unsettled extends Error {}

const missing = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR');

/**
 * Where a service definition is read from: the person's home (to know its terminal sign-in folders) and the notes a
 * refusal is said in. A service file may be a link (home-manager links it into the Nix store); only one whose chain
 * lands in `~/.claude`, `~/.claude.json` or `~/.codex` is refused.
 */
interface ServiceReads {
  readonly homeDirectory: string;
  readonly notes: string[];
}

/** Whether `path` was refused (it points into a terminal sign-in folder), saying so in the notes; nothing is read. */
async function refused(path: string, label: string, reads: ServiceReads): Promise<boolean> {
  if (!(await pointsIntoTerminalFolder(path, reads.homeDirectory))) return false;
  reads.notes.push(`${label}: the service file points into a terminal sign-in folder, so it was not read`);
  return true;
}

/** A file's text, `undefined` when it is not there or was refused; any other failure leaves the question open. */
async function readText(path: string, label: string, reads: ServiceReads): Promise<string | undefined> {
  if (await refused(path, label, reads)) return undefined;
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (missing(error)) return undefined;
    throw new Unsettled(`${label} exists but could not be read, so the v4 value cannot be known`);
  }
}

interface Systemd {
  readonly found: Found | undefined;
  readonly stateHome: string | undefined;
  readonly present: boolean;
  readonly environmentFile: boolean;
}

/** The unit, then its drop-ins in order, merged the way systemd merges `Environment=`. */
async function readSystemd(unitFile: string, dropIns: string, reads: ServiceReads): Promise<Systemd> {
  const unit = await readText(unitFile, 'the systemd unit fyd.service', reads);
  let names: string[] = [];
  if (!(await refused(dropIns, 'the fyd.service.d folder', reads))) {
    try {
      names = (await readdir(dropIns)).filter(name => name.endsWith('.conf')).sort();
    } catch (error) {
      if (!missing(error)) throw new Unsettled('the fyd.service.d folder exists but could not be listed');
    }
  }
  const merged = new Map<string, { value: string; source: string }>();
  let environmentFile = false;
  const apply = (text: string, source: string): void => {
    const parsed = systemdEnvironment(text);
    environmentFile ||= parsed.environmentFile;
    for (const [name, value] of parsed.assignments) merged.set(name, { value, source });
  };
  if (unit !== undefined) apply(unit, 'the systemd unit fyd.service');
  for (const name of names) {
    const text = await readText(join(dropIns, name), `the drop-in fyd.service.d/${name}`, reads);
    if (text !== undefined) apply(text, `the drop-in fyd.service.d/${name}`);
  }
  const variable = merged.get(V4_ARCHIVE_VARIABLE);
  return {
    found: variable === undefined ? undefined : { source: variable.source, raw: variable.value },
    stateHome: merged.get('FY_HOME')?.value,
    present: unit !== undefined || names.length > 0,
    environmentFile,
  };
}

interface Located {
  readonly found: Found | undefined;
  readonly notes: string[];
}

/** The first source that names the variable. Pure reads; nothing is run. */
async function locate(ctx: StepContext): Promise<Located> {
  const notes: string[] = [];
  const host = ctx.host;
  if (host === undefined) {
    notes.push('no host facts were supplied, so no service definition or environment was read');
    return { found: undefined, notes };
  }
  const paths = v4ServicePaths(host.homeDirectory, host.configHome);

  const reads: ServiceReads = { homeDirectory: host.homeDirectory, notes };
  const systemd = await readSystemd(paths.unitFile, paths.dropInFolder, reads);
  const serves = (stateHome: string | undefined): boolean =>
    stateHome === undefined || resolve(stateHome) === resolve(ctx.v4.home);
  if (systemd.present && !serves(systemd.stateHome)) {
    notes.push('the systemd unit fyd.service supervises another state home, so its setting is not this home’s');
  } else {
    if (systemd.found !== undefined) return { found: systemd.found, notes };
    if (systemd.environmentFile)
      notes.push(
        'the systemd unit names an EnvironmentFile=, which is never opened; set afterHours in archive.yaml by hand if it holds the variable',
      );
  }

  const plistText = await readText(paths.plist, 'the launchd plist com.ferretry.fyd.plist', reads);
  if (plistText !== undefined) {
    const plist = plistEnvironmentValue(plistText, V4_ARCHIVE_VARIABLE);
    if (plist.binary) notes.push('the launchd plist is a binary plist, which is not read');
    else if (plist.value !== undefined) return { found: { source: 'the launchd plist', raw: plist.value }, notes };
  }

  const own = host.env[V4_ARCHIVE_VARIABLE];
  if (own !== undefined) return { found: { source: 'the converter’s own environment', raw: own }, notes };
  return { found: undefined, notes };
}

type Decision =
  | { readonly kind: 'write'; readonly hours: number; readonly source: string }
  | { readonly kind: 'nothing'; readonly why: string };

function decide(found: Found | undefined): Decision {
  if (found === undefined) return { kind: 'nothing', why: 'v4 had it unset (automatic archiving off)' };
  const parsed: ArchiveAfter = parseArchiveAfter(found.raw);
  if (parsed.kind === 'off')
    return { kind: 'nothing', why: `${found.source} set it off or empty (automatic archiving off)` };
  if (parsed.kind === 'invalid')
    return {
      kind: 'nothing',
      why: `${found.source} set it to a value v4 refuses (not a whole number of hours, 1 or more, or "off"); it is not carried`,
    };
  if (parsed.hours > ARCHIVE_MAX_HOURS)
    return {
      kind: 'nothing',
      why: `${found.source} set ${String(parsed.hours)} hours; v5 holds at most ${String(ARCHIVE_MAX_HOURS)}, so it is not carried`,
    };
  return { kind: 'write', hours: parsed.hours, source: found.source };
}

const STATIC_NOT_CARRIED: readonly NotCarried[] = [
  {
    what: `\`launchctl setenv ${V4_ARCHIVE_VARIABLE}\` and \`systemctl --user set-environment\``,
    why: 'held in the service manager’s memory; reading them means running a command, which this tool never does. If you used one, set afterHours in archive.yaml by hand',
  },
];

export const archiveSettingStep: Step = {
  id: 'archive-setting',
  title: 'Archive setting (automatic session archiving age)',
  owner: ['core-ferrets'],
  reads: [
    `~/.config/systemd/user/fyd.service.d/*.conf and fyd.service (${V4_ARCHIVE_VARIABLE} only)`,
    `~/Library/LaunchAgents/com.ferretry.fyd.plist EnvironmentVariables (${V4_ARCHIVE_VARIABLE} only)`,
    `the converter's own environment (${V4_ARCHIVE_VARIABLE} only)`,
  ],
  sealed: [],
  notCarried: STATIC_NOT_CARRIED,
  async run(ctx): Promise<StepReport> {
    const base = { id: this.id, title: this.title, sealed: [] };
    const dry = ctx.dryRun ? ['dry run: nothing written'] : [];
    let located: Located;
    try {
      located = await locate(ctx);
    } catch (error) {
      if (!(error instanceof Unsettled)) throw error;
      return {
        ...base,
        status: 'converted',
        note: [`archive.yaml not written: ${error.message}; automatic archiving stays off`, ...dry].join('; '),
        kept: [],
        notCarried: this.notCarried,
      };
    }
    const decision = decide(located.found);
    if (decision.kind === 'nothing')
      return {
        ...base,
        status: 'converted',
        note: [
          `archive.yaml not written: ${decision.why}; automatic archiving stays off`,
          ...located.notes,
          ...dry,
        ].join('; '),
        kept: [],
        notCarried: this.notCarried,
      };

    const document = new Document({ afterHours: decision.hours }, YAML_OPTIONS);
    document.commentBefore = ` Carried from v4 ${V4_ARCHIVE_VARIABLE} (${decision.source}) by the v4 → v5 converter.`;
    const text = document.toString({ lineWidth: 0 });
    const problem = v5ConfigProblem(ARCHIVE_CONFIG, undefined, text);
    if (problem !== undefined)
      return {
        ...base,
        status: 'failed',
        note: `v5 refuses it as ${configPath(ARCHIVE_CONFIG)}: ${problem}`,
        kept: [],
        notCarried: this.notCarried,
      };
    await ctx.v5.config(ARCHIVE_CONFIG, undefined, text);
    const kept: KeptItem[] = [{ what: `archive age (${String(decision.hours)} h, from ${decision.source})`, count: 1 }];
    const notes = [...located.notes, ...dry];
    return {
      ...base,
      status: 'converted',
      ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
      kept,
      notCarried: this.notCarried,
    };
  },
};
