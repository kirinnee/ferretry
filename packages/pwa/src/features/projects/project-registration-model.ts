/**
 * THE PURE HALF OF PROJECT ONBOARDING: a draft in, one wire request out.
 *
 * `RegisterProjectRequestSchema` has four arms and they are four genuinely
 * different acts — point at a folder that exists, make one, clone one, or
 * confirm one a session was seen using. Three of them are a form; the fourth is
 * a single deliberate confirmation and has no draft at all, which is the shape
 * of the invariant the registry is built around: **a folder observed in a
 * session is a discovery, not a Project, until somebody says so.** There is no
 * scan here and no "add all recent folders", because either would be that
 * confirmation happening without anybody making it.
 *
 * ONE VERDICT, NOT A PREDICATE AND A MESSAGE. `projectDraftVerdict` answers both
 * "can this be sent" and "why not" in a single total function, so a disabled
 * button and the sentence beside it cannot disagree — the failure mode
 * `secrets-card.tsx` avoided the same way. A draft that is merely INCOMPLETE
 * carries no problem: a reader who has typed three characters of a path is not
 * making a mistake and should not be told they are.
 *
 * THE SCHEMA IS THE LAST WORD. Every arm is built and then handed to
 * `RegisterProjectRequestSchema`, so the request this module returns is the
 * parsed value rather than a shape that merely looks like one, and the clone
 * address is judged by the protocol's own rule instead of by a second URL
 * opinion written here.
 *
 * WHAT IT REFUSES ON THE DAEMON'S BEHALF, AND WHAT IT DOES NOT. A relative path
 * is refused here, because the daemon would resolve it against ITS working
 * directory and quietly register a folder nobody named. A missing parent
 * directory is NOT refused here: only the daemon can know, `mkdir` runs
 * non-recursively, and guessing would either block a legal path or promise a
 * creation that then fails. That one is stated to the reader up front and
 * surfaced verbatim when it happens.
 */

import { type RegisterProjectRequest, RegisterProjectRequestSchema, type ProjectInfo } from '@ferretry/protocol';

import type { FleetProject } from '../../lib/fleet-grouping.ts';

/** The three arms a form can produce. The fourth is a confirmation, not a draft. */
export type ProjectRegistrationMode = 'existing-folder' | 'new-folder' | 'clone';

export interface ProjectRegistrationDraft {
  readonly mode: ProjectRegistrationMode;
  readonly path: string;
  /** Only `clone` sends it, and every mode keeps it: switching modes to read a
   *  hint must not silently delete an address the reader pasted. */
  readonly url: string;
  /** Blank means "let the daemon name it after the folder", never an empty name. */
  readonly name: string;
  readonly initializeGit: boolean;
}

export const emptyProjectRegistrationDraft: ProjectRegistrationDraft = Object.freeze({
  mode: 'existing-folder' as const,
  path: '',
  url: '',
  name: '',
  initializeGit: false,
});

interface ProjectModeDescriptor {
  readonly label: string;
  /** The one line under the segment: what this mode DOES to the filesystem. */
  readonly detail: string;
  readonly pathLabel: string;
  readonly pathPlaceholder: string;
}

/**
 * A record rather than an array, so adding a fourth mode cannot compile until it
 * has a descriptor: a mapped type over the union proves COMPLETENESS, which
 * `satisfies readonly Descriptor[]` on a list would not. The reading order is
 * this object's key order — least to most destructive.
 */
const MODE_DESCRIPTORS: Readonly<Record<ProjectRegistrationMode, ProjectModeDescriptor>> = {
  'existing-folder': {
    label: 'Existing folder',
    detail: 'Point at a folder already on this machine. Nothing is written to disk.',
    pathLabel: 'Folder',
    pathPlaceholder: '/home/you/work/ferretry',
  },
  'new-folder': {
    label: 'New folder',
    detail: 'Creates the folder, owner-only. Optionally runs git init inside it.',
    pathLabel: 'Folder to create',
    pathPlaceholder: '/home/you/work/new-project',
  },
  clone: {
    label: 'Clone',
    detail: 'Runs git clone on the daemon, then registers the checkout.',
    pathLabel: 'Clone into',
    pathPlaceholder: '/home/you/work/cloned-project',
  },
};

/** The segments in reading order, each with the descriptor the form renders. */
export const PROJECT_REGISTRATION_MODES: readonly (ProjectModeDescriptor & {
  readonly mode: ProjectRegistrationMode;
})[] = Object.freeze(
  (Object.keys(MODE_DESCRIPTORS) as readonly ProjectRegistrationMode[]).map(mode => ({
    mode,
    ...MODE_DESCRIPTORS[mode],
  })),
);

export const projectModeDescriptor = (mode: ProjectRegistrationMode): ProjectModeDescriptor => MODE_DESCRIPTORS[mode];

/**
 * Why a relative path is refused rather than sent. Exported so the form and its
 * test cannot drift on the wording of a rule the reader has to act on.
 */
export const ABSOLUTE_PATH_REQUIRED =
  'Use an absolute path. A relative one is resolved against the daemon’s own working directory, not yours, so it would register a folder you did not name.';

/** The only thing the protocol can still refuse once a path and an address are present. */
export const CLONE_ADDRESS_UNUSABLE =
  'That is not a URL Ferretry can hand to git. Use https://…, ssh://… or file://… — git’s git@host:path shorthand is not a URL, so write it as ssh://git@host/path.';

/**
 * Said BEFORE the button is pressed, not after.
 *
 * The route is synchronous: the daemon clones and only then answers, so this tab
 * holds an open request for the whole clone. There is no progress to show and no
 * cancel to offer, and inventing either — a fake percentage, a button that
 * abandons the request while git keeps running — would be worse than the wait.
 */
export const CLONE_PATIENCE =
  'A clone runs on the daemon while this page waits. A large repository can take minutes, and there is no way to cancel it from here.';

/** The `mkdir` is deliberately non-recursive, so this is a real limit and not advice. */
export const NEW_FOLDER_ONE_LEVEL =
  'Exactly one folder is created, owner-only. The parent must already exist — a path whose parent is missing is refused, not created.';

/** The sentence that keeps a discovery list from reading as a list of projects. */
export const DISCOVERY_PROMISE =
  'Folders sessions on this daemon have worked in. Ferretry registers none of them on its own — confirming one is what enrols it.';

/**
 * Whether a draft can be sent, and the one sentence explaining why not.
 *
 * `problem` is `null` for a draft that is fine AND for one that is merely
 * unfinished; `request` being `null` is what "cannot be sent" means. The two
 * together are the only inputs the form needs to decide both the button and the
 * message.
 */
interface ProjectDraftVerdict {
  readonly request: RegisterProjectRequest | null;
  readonly problem: string | null;
}

const INCOMPLETE: ProjectDraftVerdict = Object.freeze({ request: null, problem: null });

const candidateFor = (draft: ProjectRegistrationDraft, path: string, url: string): unknown => {
  const named = draft.name.trim() === '' ? {} : { name: draft.name.trim() };
  if (draft.mode === 'clone') return { kind: 'clone', url, path, ...named };
  if (draft.mode === 'new-folder') return { kind: 'new-folder', path, initializeGit: draft.initializeGit, ...named };
  return { kind: 'existing-folder', path, ...named };
};

export const projectDraftVerdict = (draft: ProjectRegistrationDraft): ProjectDraftVerdict => {
  const path = draft.path.trim();
  const url = draft.url.trim();
  if (path === '') return INCOMPLETE;
  if (draft.mode === 'clone' && url === '') return INCOMPLETE;
  if (!path.startsWith('/')) return { request: null, problem: ABSOLUTE_PATH_REQUIRED };
  const parsed = RegisterProjectRequestSchema.safeParse(candidateFor(draft, path, url));
  // The path is a non-empty absolute string, the name is either absent or
  // non-empty, and `initializeGit` is a boolean — so the clone address is the
  // only field the schema has left to refuse.
  if (!parsed.success) return { request: null, problem: CLONE_ADDRESS_UNUSABLE };
  return { request: parsed.data, problem: null };
};

/**
 * The confirmation request for one discovered path.
 *
 * It takes a path and nothing else on purpose. A discovery has no display name
 * to carry — `RecentProjectOption.name` is a basename this browser derived, not
 * a name anybody chose — so sending it would turn a guess into the registry's
 * durable answer. The daemon takes the basename of the resolved root itself.
 */
export const confirmDiscoveryRequest = (path: string): RegisterProjectRequest =>
  RegisterProjectRequestSchema.parse({ kind: 'confirmed-discovery', path });

/**
 * What the surface is waiting on, refused, or just wrote.
 *
 * The whole request is carried rather than a kind and a path, so a row can ask
 * "is this ME" by comparing the path it renders, and the clone-specific wait can
 * be recognised without a second flag. One status at a time: the form and the
 * discovery list share it, because a reader can only press one of them.
 */
export type ProjectRegistrationStatus =
  | { readonly phase: 'submitting'; readonly request: RegisterProjectRequest }
  | { readonly phase: 'refused'; readonly request: RegisterProjectRequest; readonly message: string }
  | {
      readonly phase: 'registered';
      readonly request: RegisterProjectRequest;
      readonly project: ProjectInfo;
      /** The daemon answered with a record it already held; nothing was created. */
      readonly alreadyRegistered: boolean;
    };

/** True while THIS path is the one being written, so only its row shows a wait. */
export const registrationPendingFor = (status: ProjectRegistrationStatus | null, path: string): boolean =>
  status?.phase === 'submitting' && status.request.path === path;

const SOURCE_LABELS: Readonly<Record<NonNullable<FleetProject['source']>, string>> = {
  'existing-folder': 'existing folder',
  clone: 'cloned',
  'new-folder': 'created here',
  'confirmed-discovery': 'confirmed discovery',
};

/**
 * How a registered folder came to be registered, or `null` when the row does not
 * say. A row without a `source` gets no chip rather than a guessed one: the
 * grouping shape allows a name-and-path row, and "existing folder" is a claim
 * about a deliberate act that such a row carries no evidence for.
 */
export const projectSourceLabel = (source: FleetProject['source']): string | null =>
  source === undefined ? null : SOURCE_LABELS[source];
