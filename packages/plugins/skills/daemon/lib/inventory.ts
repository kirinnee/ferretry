/**
 * The skills inventory service: which skills a machine holds and which a ferret sees.
 *
 * Pure of the file system — every read goes through {@link SkillFilesPort}, and the runtime homes and
 * registered projects arrive as ports, so the precedence and shadowing rules are testable with fakes.
 */

import { basename, dirname, join } from 'node:path';

import type {
  FerretSkillsInventory,
  MachineSkillsInventory,
  SkillEntry,
  SkillScope,
  SkillToggle,
} from '../../contract/index.ts';
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { skillFrontMatter } from './front-matter.ts';

export const MAX_SKILL_MANIFEST_BYTES = 256 * 1024;
/** Per-directory cap; beyond it a listing is cut short and flagged `truncated`. */
export const MAX_SKILLS_PER_ROOT = 200;

type Harness = HarnessKey;

/** What the inventory needs to know about one ferret: where it works and which runtime it spends. */
export interface SkillsFerret {
  readonly id: string;
  readonly harness: Harness;
  /** The folder it works in. */
  readonly folder: string;
  /** The runtime's name, when it has one. */
  readonly runtime?: string;
}

/** One skill folder: a directory, or a link the home's reader says is Ferretry's own, holding a SKILL.md. */
export interface SkillDirectoryEntry {
  /** Absolute path of the SKILL.md as listed (the link path, not its target). */
  readonly manifest: string;
  /** The folder is Ferretry's own (an asset the fleet linked, an asset listed straight, or an installed item). */
  readonly managed?: boolean;
}

export interface SkillFilesPort {
  /**
   * Skill folders directly inside `directory`, at most `limit + 1`, skipping dot-entries. What a link may point at is
   * the reader's decision, never the service's. An unreadable or missing directory is an empty list.
   */
  list(directory: string, limit: number): Promise<readonly SkillDirectoryEntry[]>;
  /** The text of a file no larger than `maxBytes`, or `undefined` when it is absent or too large. */
  read(path: string, maxBytes: number): Promise<string | undefined>;
}

/** A runtime home the fleet owns. */
interface SkillRuntimeHome {
  /** The wrapper names that launch into this home. */
  readonly runtimes: readonly string[];
  readonly harness: Harness;
  readonly home: string;
}

export interface SkillsInventoryPorts {
  readonly files: SkillFilesPort;
  readonly homes: () => Promise<readonly SkillRuntimeHome[]>;
  readonly projects: () => Promise<readonly { readonly id: string; readonly name: string; readonly path: string }[]>;
  /**
   * The v4-installed skills, listed straight from the fleet's `assets/skills/<name>` (source `ferretry`), because a
   * link from a home into `assets/` is never followed: it is the same skill listed once here. Unbound until Runtimes
   * offers that tree.
   */
  readonly ferretry?: () => Promise<readonly SkillDirectoryEntry[]>;
  /** The skill items a runtime's profile selects, resolved to Skills' own store: what the launch hands over. */
  readonly selected?: (runtime: string) => Promise<readonly SkillDirectoryEntry[]>;
}

/**
 * Precedence between scopes, per harness.
 *
 * INFERRED, not verified against a running harness: Claude documents personal skills overriding project
 * skills of the same name, so a project skill is shadowed by the home's skill; Codex lists skills of the
 * same name from both scopes without merging them, so nothing shadows anything.
 */
function shadowingScope(harness: Harness, scope: SkillScope, homeHas: ReadonlyMap<string, SkillScope>, name: string) {
  if (harness !== 'claude-code' || scope !== 'project') return undefined;
  return homeHas.get(name);
}

/** Codex reads `<root>/.agents/skills`; Claude reads `<root>/.claude/skills`. */
function projectSkillsDirectory(harness: Harness, root: string): string {
  return join(root, harness === 'claude-code' ? '.claude' : '.agents', 'skills');
}

const FERRETRY_TOGGLE: SkillToggle = {
  supported: false,
  enabled: true,
  reason: 'a Ferretry skill is switched through the profile that selects it',
};
const CODEX_TOGGLE: SkillToggle = {
  supported: false,
  enabled: true,
  reason: "Codex's skills.config switch lives in config.toml, which Ferretry regenerates on every apply",
};
const CLAUDE_TOGGLE: SkillToggle = {
  supported: false,
  enabled: true,
  reason: 'Claude has no per-skill switch Ferretry can verify',
};

function toggleFor(harness: Harness, scope: SkillScope): SkillToggle {
  if (scope === 'ferretry') return FERRETRY_TOGGLE;
  return harness === 'codex' ? CODEX_TOGGLE : CLAUDE_TOGGLE;
}

interface Listed {
  readonly skills: SkillEntry[];
  readonly truncated: boolean;
}

export class SkillsInventoryService {
  constructor(private readonly ports: SkillsInventoryPorts) {}

  /** Every runtime home plus every registered project. */
  async machine(): Promise<MachineSkillsInventory> {
    const [homes, projects] = await Promise.all([this.ports.homes(), this.ports.projects()]);
    let truncated = false;
    const homeListings = await Promise.all(
      homes.map(async entry => {
        const listed = await this.homeSkills(entry.harness, entry.home, entry.runtimes, entry.runtimes[0]);
        truncated ||= listed.truncated;
        return {
          runtime: entry.runtimes[0] ?? basename(entry.home),
          harness: entry.harness,
          home: entry.home,
          skills: listed.skills,
        };
      }),
    );
    const projectListings = await Promise.all(
      projects.map(async project => {
        const skills: SkillEntry[] = [];
        for (const harness of ['claude-code', 'codex'] as const) {
          const runtimes = homes.filter(entry => entry.harness === harness).flatMap(entry => [...entry.runtimes]);
          const listed = await this.projectSkills(harness, project.path, runtimes, project.id, new Map());
          truncated ||= listed.truncated;
          skills.push(...listed.skills);
        }
        return { id: project.id, name: project.name, root: project.path, skills };
      }),
    );
    return { homes: homeListings, projects: projectListings, truncated };
  }

  /** Exactly what one ferret sees: its runtime home's skills, then its working folder's. */
  async ferret(ferret: SkillsFerret): Promise<FerretSkillsInventory> {
    const { harness, folder: cwd, runtime: runtimeName = '' } = ferret;
    const homes = await this.ports.homes();
    const runtimeHome = homes.find(entry => entry.harness === harness && entry.runtimes.includes(runtimeName));
    const runtimes = runtimeName === '' ? [] : [runtimeName];
    // A ferret that runs no published account lists no home (a 5.0 ferret never reads the daemon user's own harness
    // home); the skill items its runtime's profile selects are still what its launch carries, so they are still listed.
    const fromHome = await this.homeSkills(harness, runtimeHome?.home, runtimes, runtimeName);
    const homeScopes = new Map(fromHome.skills.map(skill => [skill.name, skill.scope]));
    const fromProject = await this.projectSkills(harness, cwd, runtimes, undefined, homeScopes);
    return {
      ferretId: ferret.id,
      harness,
      folder: cwd,
      ...(runtimeHome === undefined ? {} : { runtime: runtimeName }),
      skills: [...fromHome.skills, ...fromProject.skills],
      truncated: fromHome.truncated || fromProject.truncated,
    };
  }

  /** The SKILL.md text for `path`, only when `listed` (an inventory this caller may see) names it exactly. */
  async file(path: string, listed: readonly SkillEntry[]): Promise<string | undefined> {
    if (!listed.some(skill => skill.path === path)) return undefined;
    return await this.ports.files.read(path, MAX_SKILL_MANIFEST_BYTES);
  }

  /** Every skill path the machine inventory lists. */
  async machinePaths(): Promise<readonly SkillEntry[]> {
    const inventory = await this.machine();
    return [...inventory.homes.flatMap(home => home.skills), ...inventory.projects.flatMap(project => project.skills)];
  }

  /**
   * One account's skills: the folders of its home (when it has a published one), then Ferretry's own, each listed once.
   * Ferretry's own are the v4-installed skills read straight from the fleet's asset tree (a link from a home into it is
   * a duplicate, never followed) and the skill items the runtime's profile selects. A name the home already lists, its
   * own plain folder or a managed link alike, is not listed a second time: the harness loads the one the home holds.
   * The asset tree reaches a launch only through a runtime home, so an account with no published home lists none of it.
   */
  private async homeSkills(
    harness: Harness,
    home: string | undefined,
    runtimes: readonly string[],
    runtime: string | undefined,
  ): Promise<Listed> {
    const own = home === undefined ? [] : await this.ports.files.list(join(home, 'skills'), MAX_SKILLS_PER_ROOT);
    const asset = home === undefined ? [] : ((await this.ports.ferretry?.()) ?? []);
    const chosen = runtime === undefined || runtime === '' ? [] : ((await this.ports.selected?.(runtime)) ?? []);
    const entries: SkillDirectoryEntry[] = [...own];
    const taken = new Set(own.map(folderOf));
    for (const entry of [...asset, ...chosen]) {
      if (taken.has(folderOf(entry))) continue;
      taken.add(folderOf(entry));
      entries.push({ ...entry, managed: true });
    }
    return await this.read(harness, entries, runtimes, entry => (entry.managed === true ? 'ferretry' : 'user'));
  }

  private async projectSkills(
    harness: Harness,
    root: string,
    runtimes: readonly string[],
    id: string | undefined,
    homeScopes: ReadonlyMap<string, SkillScope>,
  ): Promise<Listed> {
    const entries = await this.ports.files.list(projectSkillsDirectory(harness, root), MAX_SKILLS_PER_ROOT);
    const project = { ...(id === undefined ? {} : { id }), root };
    const listed = await this.read(harness, entries, runtimes, () => 'project', project);
    return {
      truncated: listed.truncated,
      skills: listed.skills.map(skill => {
        const shadowedBy = shadowingScope(harness, skill.scope, homeScopes, skill.name);
        return shadowedBy === undefined ? skill : { ...skill, shadowedBy };
      }),
    };
  }

  private async read(
    harness: Harness,
    entries: readonly SkillDirectoryEntry[],
    runtimes: readonly string[],
    scopeOf: (entry: SkillDirectoryEntry) => SkillScope,
    project?: { readonly id?: string; readonly root: string },
  ): Promise<Listed> {
    const capped = entries.slice(0, MAX_SKILLS_PER_ROOT);
    const read = await Promise.all(
      capped.map(async entry => {
        const text = await this.ports.files.read(entry.manifest, MAX_SKILL_MANIFEST_BYTES);
        const parsed = text === undefined ? undefined : skillFrontMatter(text);
        if (parsed === undefined) return undefined;
        const scope = scopeOf(entry);
        return {
          ...parsed,
          harness,
          scope,
          path: entry.manifest,
          runtimes: [...runtimes],
          ...(project === undefined ? {} : { project }),
          toggle: toggleFor(harness, scope),
        } satisfies SkillEntry;
      }),
    );
    return {
      skills: read
        .filter((skill): skill is NonNullable<typeof skill> => skill !== undefined)
        .sort((left, right) => left.name.localeCompare(right.name)),
      truncated: entries.length > MAX_SKILLS_PER_ROOT,
    };
  }
}

/** The skill's folder name: the segment above its SKILL.md. */
function folderOf(entry: SkillDirectoryEntry): string {
  return basename(dirname(entry.manifest));
}
