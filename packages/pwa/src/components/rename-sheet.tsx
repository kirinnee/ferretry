import type { SessionView } from '@ferretry/protocol';

export interface RenameSessionPatch {
  readonly name?: string;
  readonly teammate?: string;
  readonly clearParent?: boolean;
}

interface RenameFieldErrors {
  readonly title?: string;
  readonly teammate?: string;
  readonly form?: string;
}

/** Builds the narrow daemon patch, normalising the two human-editable identifiers exactly once. */
export const renamePatch = (
  view: SessionView,
  title: string,
  teammate: string,
  detach: boolean,
): RenameSessionPatch => {
  const patch: { name?: string; teammate?: string; clearParent?: boolean } = {};
  const normalizedTitle = title.trim();
  const normalizedTeammate = teammate.trim().toLowerCase();
  if (normalizedTitle !== view.config.name.trim()) patch.name = normalizedTitle;
  if (normalizedTeammate !== (view.config.teammate ?? '').trim().toLowerCase()) patch.teammate = normalizedTeammate;
  if (view.config.parent && detach) patch.clearParent = true;
  return patch;
};

/** Places a daemon refusal beside the field it names; unknown failures stay at form level. */
export const renameErrorsFor = (error: unknown): RenameFieldErrors => {
  const message = error instanceof Error ? error.message : String(error);
  if (/teammate|callsign/i.test(message)) return { teammate: message };
  if (/\bname\b|title/i.test(message)) return { title: message };
  return { form: message };
};
