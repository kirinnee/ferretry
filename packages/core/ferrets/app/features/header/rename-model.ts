import type { FerretSummary } from '../../../contract/index.ts';

export interface RenamePatch {
  readonly name?: string;
  readonly title?: string;
}

interface RenameFieldErrors {
  readonly title?: string;
  readonly name?: string;
  readonly form?: string;
}

/** Builds the narrow daemon patch, normalising the two human-editable identifiers exactly once. */
export const renamePatch = (
  ferret: Pick<FerretSummary, 'name' | 'title'>,
  title: string,
  name: string,
): RenamePatch => {
  const patch: { name?: string; title?: string } = {};
  const normalizedTitle = title.trim();
  const normalizedName = name.trim().toLowerCase();
  if (normalizedTitle !== (ferret.title ?? '').trim()) patch.title = normalizedTitle;
  if (normalizedName !== ferret.name.trim().toLowerCase()) patch.name = normalizedName;
  return patch;
};

/** Places a daemon refusal beside the field it names; unknown failures stay at form level. */
export const renameErrorsFor = (error: unknown): RenameFieldErrors => {
  const message = error instanceof Error ? error.message : String(error);
  if (/\bname\b|callsign|taken/iu.test(message) && !/title/iu.test(message)) return { name: message };
  if (/title|task/iu.test(message)) return { title: message };
  return { form: message };
};
