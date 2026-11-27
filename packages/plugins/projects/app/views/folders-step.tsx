/**
 * THE SETUP FLOW'S LAST PAGE, "Add your projects" (the `projects.folders` first-run step): the same folder explorer "Add
 * project" uses, to pick one folder or several, and the same registration (`registerProject`, `existing-folder`) when the
 * footer's Next is pressed (`host.commit`, contract rule 8). The flow draws the title, the footer ("Skip for now" is its Later
 * button) and the loading cover; this page draws only the body.
 *
 * - A machine that already has a project is not asked again: the page passes over (`notNeeded`) before it draws anything.
 *   Projects this very run made do not count: Back from the next page lands here and stays (`madeIds`, in the step's memory).
 * - Next with no folder picked says so in the footer and stays (the way out is Skip for now).
 * - What was registered is left in the step's memory (`openLabel`, `openHref`) so the last page can open it. A project is
 *   offered to the next page ("Connect GitHub") only when this run PROVED it made it: its id was not in the registry read just
 *   before registering. The daemon answers a folder it already holds with the record it held, which proves nothing.
 * - The work is kept per save, not per batch: each folder picked or removed, and each project made, is written down at once
 *   (this browser's storage, one draft per machine), so a refusal on the third folder, Back, or a reload finds the folders
 *   still picked and the projects already made counted as this run's. A finished save clears the draft.
 * - Nothing here is about boards: a folder is registered, and the project's own page holds the rest.
 */
import { daemonOfClient } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import type { AppComponent, PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectInfo } from '../../contract/index.ts';
import { FolderPicker } from '../features/folder-explorer/folder-picker.tsx';
import { type ProjectsClient, reasonOf } from '../lib/client.ts';
import { projectPath, projectsPath } from '../lib/paths.ts';
import { fetchProjects, registerProject } from '../lib/projects-api.ts';
import { projectsStoreFor } from './context.ts';

export interface FoldersStepProps {
  readonly step: StepHost | undefined;
  readonly client: ProjectsClient;
  /** The machine the folders are registered on; without it nothing is linked to. */
  readonly daemon: string | undefined;
}

/** What the page has written down so far: the folders still to register and the ids of the projects this run made. */
interface Draft {
  readonly picks: readonly string[];
  readonly madeIds: readonly string[];
}

const draftKey = (daemon: string | undefined): string => `fy.projects.setup-folders.${daemon ?? 'machine'}`;

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** The saved draft; storage that is missing, refused or damaged is an empty draft. */
const readDraft = (daemon: string | undefined): Draft => {
  try {
    const raw = globalThis.localStorage?.getItem(draftKey(daemon));
    const parsed: unknown = raw === null || raw === undefined ? undefined : JSON.parse(raw);
    const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    return { picks: strings(record.picks), madeIds: strings(record.madeIds) };
  } catch {
    return { picks: [], madeIds: [] };
  }
};

/** Writes the draft down (an empty one removes it); a browser that refuses storage keeps it for this visit only. */
const writeDraft = (daemon: string | undefined, draft: Draft): void => {
  try {
    if (draft.picks.length === 0 && draft.madeIds.length === 0) globalThis.localStorage?.removeItem(draftKey(daemon));
    else globalThis.localStorage?.setItem(draftKey(daemon), JSON.stringify(draft));
  } catch {
    // Private mode or a full store: the draft lasts for this visit only.
  }
};

/** The ids of the projects this run made, kept in the step's memory as one comma-joined string. */
const idsOf = (memory: unknown): readonly string[] =>
  typeof memory === 'string' && memory !== '' ? memory.split(',').filter(id => id !== '') : [];

const openOf = (daemon: string, made: readonly ProjectInfo[]): Record<string, string> => {
  const [only] = made;
  return made.length === 1 && only !== undefined
    ? { openLabel: `Open ${only.name}`, openHref: projectPath(daemon, only.id) }
    : { openLabel: 'Open your projects', openHref: projectsPath(daemon) };
};

export function FoldersStep({ step, client, daemon }: FoldersStepProps) {
  const [saved] = useState(() => readDraft(daemon));
  const [picks, setPicks] = useState<readonly string[]>(saved.picks);
  /** The list as the save reads it (the save outlives the render it was made in). */
  const picked = useRef<readonly string[]>(saved.picks);
  /** The projects made so far in this setup: what the step's memory holds plus what the draft held across a reload. */
  const madeNow = useRef<ReadonlySet<string>>(new Set([...saved.madeIds, ...idsOf(step?.segment.madeIds)]));
  const host = useRef(step);
  host.current = step;
  const made = useRef<readonly ProjectInfo[]>([]);
  /** The projects this run made, as the page last drew (read again whenever the page is drawn again). */
  const [madeBefore, setMadeBefore] = useState(0);

  useEffect(() => {
    let live = true;
    fetchProjects(client).then(
      known => {
        if (!live) return;
        const mine = new Set([...madeNow.current, ...idsOf(host.current?.segment.madeIds)]);
        // Only what this run made is on the machine: the person came Back here, and the page stays.
        if (known.length > 0 && !known.every(project => mine.has(project.id))) host.current?.notNeeded();
        else {
          setMadeBefore(mine.size);
          host.current?.ready();
        }
      },
      () => live && host.current?.ready(),
    );
    return () => {
      live = false;
    };
  }, [client]);

  // What Next saves: every picked folder, one by one; a refusal keeps the page, with the folders not yet registered still picked.
  // The save is registered again only when the PERSON changes the list (`change`): that clears the footer's old message, and a
  // refusal's own trim of the list (below) must not clear the message it is raising.
  const save = useCallback(async (): Promise<void> => {
    const picks = picked.current;
    const earlier = [...new Set([...madeNow.current, ...idsOf(host.current?.segment.madeIds)])];
    // Nothing new picked, but this run already made projects (Back brought the person here): keep them and move on.
    if (picks.length === 0 && earlier.length > 0) {
      writeDraft(daemon, { picks: [], madeIds: [] });
      return;
    }
    if (picks.length === 0) throw new Error('Pick a folder, or choose Skip for now.');
    // What the registry held BEFORE: the only proof that a project was made here. A registry that cannot be read proves nothing.
    const held = await fetchProjects(client).then(
      rows => new Set(rows.map(project => project.id)),
      () => undefined,
    );
    const created = new Set(earlier);
    const left = [...picks];
    for (const path of picks) {
      try {
        const project = await registerProject(client, { kind: 'existing-folder', path });
        if (!made.current.some(each => each.id === project.id)) made.current = [...made.current, project];
        if (held !== undefined && !held.has(project.id)) created.add(project.id);
      } catch (cause) {
        picked.current = left;
        setPicks(left);
        throw new Error(`${path}: ${reasonOf(cause)}`);
      }
      left.shift();
      // Written down NOW, folder by folder: a refusal later in the batch, Back or a reload must find this one made.
      madeNow.current = new Set(created);
      writeDraft(daemon, { picks: left, madeIds: [...created] });
      host.current?.remember({ madeIds: [...created].join(',') });
    }
    const [only] = made.current;
    if (daemon !== undefined) host.current?.remember(openOf(daemon, made.current));
    host.current?.remember({ madeIds: [...created].join(',') });
    writeDraft(daemon, { picks: [], madeIds: [] });
    // The next page ("Connect GitHub") may offer to link an account to the one project made here, and only a project proven new.
    host.current?.remember(
      made.current.length === 1 && only !== undefined && created.has(only.id)
        ? { linkProjectId: only.id, linkProjectName: only.name }
        : { linkProjectId: undefined, linkProjectName: undefined },
    );
    await projectsStoreFor(client)
      .refresh()
      .catch(() => undefined);
  }, [client, daemon]);
  useEffect(() => host.current?.commit(save), [save]);

  const change = (next: readonly string[]): void => {
    picked.current = next;
    setPicks(next);
    writeDraft(daemon, { picks: next, madeIds: [...madeNow.current] });
    host.current?.commit(save);
  };
  const add = (path: string): void => {
    if (!picked.current.includes(path)) change([...picked.current, path]);
  };

  return (
    <div className="grid gap-md" data-projects-step="folders">
      <p className="m-0 text-ui text-muted">
        Open a folder and press Add this folder, as many times as you like. Each becomes a project; you can link GitHub
        accounts from the project&apos;s own page. Next saves your list.
      </p>
      {madeBefore > 0 && picks.length === 0 && (
        <p className="m-0 text-meta text-muted" data-projects-step-made="">
          {madeBefore === 1
            ? '1 project is already added in this setup.'
            : `${madeBefore} projects are already added in this setup.`}{' '}
          Next keeps {madeBefore === 1 ? 'it' : 'them'}, or add more.
        </p>
      )}
      {picks.length > 0 && (
        <ul className="m-0 grid list-none gap-xs p-0" aria-label="Your folders" data-projects-step-picks="">
          {picks.map(path => (
            <li
              key={path}
              className="flex min-h-[44px] items-center gap-sm rounded-control border border-border-strong bg-surface pl-control-x"
            >
              <span className="mono min-w-0 flex-1 break-all text-meta text-fg">{path}</span>
              <button
                type="button"
                className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-muted hover:text-fg"
                aria-label={`Remove ${path}`}
                onClick={() => change(picked.current.filter(each => each !== path))}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <FolderPicker client={client} onChoose={add} chooseLabel="Add this folder" warnBroad />
    </div>
  );
}

/** The panel Projects places in `onboarding.step` (the app half hands it only its own step's subject). */
export function createFoldersStep(client: PluginClient): AppComponent<PanelProps> {
  return function FoldersStepPanel(props: PanelProps) {
    return <FoldersStep step={props.step} client={client} daemon={daemonOfClient(client)} />;
  };
}
