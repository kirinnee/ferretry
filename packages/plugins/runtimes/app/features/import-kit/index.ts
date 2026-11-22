/**
 * The import kit: what a harness plugin's own onboarding pages (Claude Code's, Codex's) build on, and what the r9 wizard
 * (Settings › Runtimes › Import) is drawn from. Public through `@ferretry/plugin-runtimes/import-kit`.
 *
 * - `useHarnessScan(client, harness, run)`: the shared scan, read once per onboarding run; `useScan` for both tools.
 * - `kindGroups(model, kind)`: what was found of one kind; `FoundKindList`: its checklist with what each becomes.
 * - `buildImportChange(harness, include, skip, name)`: the one `setup.import` change.
 * - `useApplyImport(client)`: applies it once; `ImportResultList`: each file written or refused.
 */
export { buildImportChange, type ImportChangeExtras } from './change.ts';
export { FoundKindList, type FoundKindListProps } from './found-kind-list.tsx';
export { IMPORT_KINDS, type ImportKind, kindFound, kindGroups, kindItemIds, kindSkips } from './kinds.ts';
export { HARNESS_LABEL, HOOKS_NOT_IMPORTED, SECRET_KEPT } from './mapping-words.ts';
export { type FoundGroup, type FoundItem, HARNESSES, nameProblem, type ToolModel } from './model.ts';
export { ImportResultList } from './import-results.tsx';
export { ImportPartialNote, type ImportPartialNoteProps } from './import-partial.tsx';
export { type ApplyImport, type ImportApplied, type ImportPartial, useApplyImport } from './use-apply-import.ts';
export {
  createScanStore,
  forgetSetupScanAhead,
  type HarnessScan,
  readSetupScanAhead,
  scanStoreFor,
  type ScanRead,
  useHarnessScan,
  useScan,
} from './use-harness-scan.ts';
export {
  InstalledDemo,
  NEXT_LEAVES,
  PermissionDemo,
  RuntimeNameField,
  StepActions,
  StepBody,
  StepCommand,
  StepConfirm,
  StepLine,
} from './step-parts.tsx';
