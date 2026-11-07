import { WITHHELD_SENTENCE, type OutputGuard } from '../contract/bound.ts';
import { ApiError } from '../contract/http.ts';
import type { ToolResult } from '../manifest/implement.ts';

/** The same stamp-before-build, synchronous-check-at-publication rule as guarded HTTP answers (§7.3). */
export async function guardedToolResult(
  guarded: boolean,
  guard: OutputGuard | undefined,
  build: () => Promise<ToolResult>,
  refusal?: () => ToolResult | undefined,
): Promise<ToolResult> {
  const withheld: ToolResult = Object.freeze({ text: WITHHELD_SENTENCE, isError: true });
  let stamp: ReturnType<OutputGuard['stamp']> | undefined;
  if (guarded) {
    try {
      stamp = guard?.stamp();
    } catch {
      /* missing stamp withholds */
    }
    if (stamp === undefined) return withheld;
  }
  let built: ToolResult;
  try {
    const result = await build();
    // Own the values before publication; plugin accessors cannot run during the final handoff.
    built = {
      text: result.text,
      ...(result.isError === undefined ? {} : { isError: result.isError }),
      ...(result.data === undefined ? {} : { data: JSON.parse(JSON.stringify(result.data)) }),
    };
  } catch (error) {
    built = { text: error instanceof ApiError ? error.message : 'The tool failed.', isError: true };
  }
  if (!guarded && refusal === undefined) return built;
  const current = (): ToolResult => {
    try {
      const unavailable = refusal?.();
      if (unavailable !== undefined) return unavailable;
      return !guarded || (guard !== undefined && stamp !== undefined && guard.stillShowable(stamp) === true)
        ? built
        : withheld;
    } catch {
      return withheld;
    }
  };
  // Keep the check through the tool transport's property reads/JSON handoff without extending the frozen SDK.
  // A hold after callTool resolves must suppress data as well as text, including error text.
  if (current() === withheld) return withheld;
  return Object.freeze({
    get text() {
      return current().text;
    },
    get isError() {
      return current().isError;
    },
    get data() {
      return current().data;
    },
  });
}
