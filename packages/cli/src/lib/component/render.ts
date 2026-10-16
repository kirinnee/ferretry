import { HARNESS_SCOPE_WORDS } from '@ferretry/fleet';
import type { FleetComponentDetail, FleetComponentGroup, FleetComponentView, FleetEnvEntry } from '@ferretry/protocol';
import { HARNESS_LABEL, indent, listOrNone, unavailable } from '../fleet/account-render.ts';

const env = (entries: readonly FleetEnvEntry[]): string[] =>
  entries.map(entry => ('value' in entry ? `${entry.name}=${entry.value}` : `${entry.name}=(hidden)`));

/** What a component holds, per kind. */
function detailLines(detail: FleetComponentDetail): string[] {
  switch (detail.kind) {
    case 'instructions':
      return [`File: ${detail.file}`];
    case 'mcp':
      return [
        ...(detail.command === undefined ? [] : [`Runs: ${[detail.command, ...(detail.args ?? [])].join(' ')}`]),
        ...(detail.url === undefined ? [] : [`Address: ${detail.url}`]),
        ...env(detail.env).map(line => `Env: ${line}`),
      ];
    case 'skills':
      return [`Skills: ${listOrNone(detail.items)}`];
    case 'settings':
      return [
        ...(detail.file === undefined ? [] : [`File: ${detail.file}`]),
        ...(detail.flags === undefined ? [] : [`Flags: ${detail.flags.join(' ')}`]),
        ...env(detail.env).map(line => `Env: ${line}`),
      ];
    case 'hooks':
      return [
        ...(detail.file === undefined ? [] : [`File: ${detail.file}`]),
        ...(detail.directory === undefined ? [] : [`Folder: ${detail.directory}`]),
      ];
    case 'modelSets':
      return [`Models: ${detail.models.join(', ')}`, `Starts with: ${detail.default}`];
  }
}

/** Generic, Claude only or Codex only — the scope a profile using it inherits. */
const scope = (component: FleetComponentView): string => HARNESS_SCOPE_WORDS[component.scope];

/** One component in full. */
export function renderComponent(component: FleetComponentView): string {
  const removal = unavailable(component.remove);
  return [
    `${component.reference}  (${scope(component)})`,
    ...indent([
      ...detailLines(component.detail),
      ...component.partial.map(partial => `Partly supported on ${HARNESS_LABEL[partial.harness]}: ${partial.reason}`),
      ...component.warnings.map(warning => `Note: ${warning}`),
      `Used by profiles: ${listOrNone(component.usedBy.profiles)}`,
      `Used by runtimes: ${listOrNone(component.usedBy.runtimes)}`,
      component.editNote,
      ...(removal === undefined ? [] : [`Cannot remove yet: ${removal}`]),
    ]),
  ].join('\n');
}

/** The Components tab in a terminal, one group per kind. */
export function renderComponentCatalog(groups: readonly FleetComponentGroup[], binaryName: string): string {
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(`${group.label} — ${group.description}`);
    if (group.components.length === 0) lines.push(...indent(['none yet']));
    for (const component of group.components) {
      const notes = component.warnings.length > 0 ? `  · ${component.warnings.length} note(s)` : '';
      lines.push(
        ...indent([
          `${component.name}  (${scope(component)})  used by ${component.usedBy.profiles.length} profile(s)${notes}`,
        ]),
      );
    }
  }
  lines.push('', `Show one with \`${binaryName} component show <kind>/<name>\`.`);
  return lines.join('\n');
}
