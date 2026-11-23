import type { FerretDetails, LaunchSpec } from '../../../contract/index.ts';

/**
 * The launch spec's share of a ferret's start options: `model` and `effort` on their own fields (where the harness
 * already reads them), and the rest whole, so a harness, runner or supervisor reads today's start fields from the spec.
 */
export function launchOptions(
  recorded: FerretDetails['options'],
  fast: boolean | undefined,
): Pick<LaunchSpec, 'model' | 'effort' | 'options'> {
  const options = fast === undefined ? recorded : { ...recorded, fast };
  if (options === undefined) return {};
  return {
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    options,
  };
}
