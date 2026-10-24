/**
 * The skills inventory service: which skills a machine holds and which a ferret sees.
 *
 * Pure of the file system — every read goes through {@link SkillFilesPort}, and the runtime homes and
 * registered projects arrive as ports, so the precedence and shadowing rules are testable with fakes.
 */

import { basename, dirname, join } from 'node:path';
import { wrapperNameOf } from '@ferretry/fleet';
import type {
  MachineSkillsInventory,
  SessionSkillsInventory,
  SessionView,
  SkillEntry,
  SkillScope,
  SkillToggle,
} from '@ferretry/protocol';
import { skillFrontMatter } from './front-matter.ts';

export const MAX_SKILL_MANIFEST_BYTES = 256 * 1024;
/** Per-directory cap; beyond it a listing is cut short and flagged `truncated`. */
export const MAX_SKILLS_PER_ROOT = 200;

type Harness = 'claude' | 'codex';

/** One skill folder: a directory, or a link to one, holding a SKILL.md. */
export interface SkillDirectoryEntry {
  /** Absolute path of the SKILL.md as seen from the listed directory (the link path, not its target). */
  readonly manifest: string;
  /** Where the link points (the link's own text, resolved), when the folder is a link. */
  readonly linkTarget?: string;
}

export interface SkillFilesPort {
  /**
   * Skill folders directly inside `directory`, at most `limit + 1`, skipping dot-entries and any link whose
   * target is not inside `confinedTo`. An unreadable or missing directory is an empty list.
   */
  list(directory: string, confinedTo: string, limit: number): Promise<readonly SkillDirectoryEntry[]>;
  /** The text of a file no larger than `maxBytes`, or `undefined` when it is absent or too large. */
  read(path: string, maxBytes: number): Promise<string | undefined>;
}

/** A runtime home the fleet owns. */
export interface SkillRuntimeHome {
  /** The wrapper names that launch into this home. */
  readonly runtimes: readonly string[];
  readonly harness: Harness;
  readonly home: string;
}

export interface SkillsInventoryPorts {
  readonly files: SkillFilesPort;
  readonly homes: () => Promise<readonly SkillRuntimeHome[]>;
  readonly projects: () => Promise<readonly { readonly id: string; readonly name: string; readonly path: string }[]>;
  /** `<FY_HOME>/fleet`: the only place a link inside a home may point. */
  readonly fleetDirectory: string;
  /** `<FY_HOME>/fleet/assets`: a link into here is a Ferretry component. */
  readonly assetsDirectory: string;
  /** The daemon's own harness homes, used only when a session runs no fleet account. */
  readonly userHome: string;
}

/**
 * Precedence between scopes, per harness.
 *
 * INFERRED, not verified against a running harness: Claude documents personal skills overriding project
 * skills of the same name, so a project skill is shadowed by the home's skill; Codex lists skills of the
 * same name from both scopes without merging them, so nothing shadows anything.
 */
function shadowingScope(harness: Harness, scope: SkillScope, homeHas: ReadonlyMap<string, SkillScope>, name: string) {
  if (harness !== 'claude' || scope !== 'project') return undefined;
  return homeHas.get(name);
}

/** Codex reads `<root>/.agents/skills`; Claude reads `<root>/.claude/skills`. */
export function projectSkillsDirectory(harness: Harness, root: string): string {
  return join(root, harness === 'claude' ? '.claude' : '.agents', 'skills');
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
        const listed = await this.homeSkills(entry.harness, entry.home, entry.runtimes);
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
        for (const harness of ['claude', 'codex'] as const) {
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

  /** Exactly what one session's ferret sees: its runtime home's skills, then its working directory's. */
  async session(session: SessionView): Promise<SessionSkillsInventory> {
    const { harness, cwd, agent } = session.config;
    const runtimeName = wrapperNameOf(agent);
    const homes = await this.ports.homes();
    const runtimeHome = homes.find(entry => entry.harness === harness && entry.runtimes.includes(runtimeName));
    const homePath = runtimeHome?.home ?? join(this.ports.userHome, harness === 'claude' ? '.claude' : '.codex');
    const runtimes = [runtimeName];
    const fromHome = await this.homeSkills(harness, homePath, runtimes, runtimeHome === undefined);
    const homeScopes = new Map(fromHome.skills.map(skill => [skill.name, skill.scope]));
    const fromProject = await this.projectSkills(harness, cwd, runtimes, undefined, homeScopes);
    return {
      sessionId: session.config.id,
      harness,
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

  private async homeSkills(
    harness: Harness,
    home: string,
    runtimes: readonly string[],
    fallback = false,
  ): Promise<Listed> {
    const directory = join(home, 'skills');
    // A fallback home is the daemon's own, outside the fleet: its links may point anywhere inside it.
    const confinedTo = fallback ? home : this.ports.fleetDirectory;
    const entries = await this.ports.files.list(directory, confinedTo, MAX_SKILLS_PER_ROOT);
    return await this.read(harness, entries, runtimes, entry =>
      entry.linkTarget !== undefined && isInside(this.ports.assetsDirectory, entry.linkTarget) ? 'ferretry' : 'user',
    );
  }

  private async projectSkills(
    harness: Harness,
    root: string,
    runtimes: readonly string[],
    id: string | undefined,
    homeScopes: ReadonlyMap<string, SkillScope>,
  ): Promise<Listed> {
    const entries = await this.ports.files.list(projectSkillsDirectory(harness, root), root, MAX_SKILLS_PER_ROOT);
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

function isInside(parent: string, child: string): boolean {
  let current = child;
  for (;;) {
    if (current === parent) return true;
    const up = dirname(current);
    if (up === current) return false;
    current = up;
  }
}
