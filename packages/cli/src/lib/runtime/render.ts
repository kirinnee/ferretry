import type { FleetRuntimeCatalog, FleetRuntimeView, FleetStackView } from '@ferretry/protocol';
import { disabledWords, HARNESS_LABEL, indent, listOrNone, unavailable } from '../fleet/account-render.ts';

const kind = (runtime: FleetRuntimeView): string =>
  runtime.agent ? `${HARNESS_LABEL[runtime.harness]}, agent` : HARNESS_LABEL[runtime.harness];

const login = (runtime: FleetRuntimeView): string => {
  const status = runtime.credential.status === undefined ? '' : ` (${runtime.credential.status.replace(/_/gu, ' ')})`;
  return `${runtime.credential.label ?? runtime.credential.id}${status}`;
};

/** The Runtimes tab in a terminal. */
export function renderRuntimeList(catalog: FleetRuntimeCatalog, binaryName: string): string {
  if (catalog.runtimes.length === 0) {
    return `No runtimes yet. Set this machine up with \`${binaryName} daemon setup\`, or add one with \`${binaryName} runtime add\`.`;
  }
  const lines: string[] = [];
  for (const runtime of catalog.runtimes) {
    lines.push(
      `${runtime.name}  ${kind(runtime)}  — ${disabledWords(runtime.disabled) ?? unavailable(runtime.launch) ?? 'ready to launch'}`,
      ...indent([`Login: ${login(runtime)} · Profile: ${runtime.profile}`]),
    );
  }
  return lines.join('\n');
}

/** A profile's stack for one harness: what applies, what is skipped, and what overrides what. */
export function renderStack(stack: FleetStackView): string[] {
  const reason = unavailable(stack.available);
  return [
    ...(reason === undefined ? [] : [reason]),
    `Applies, oldest first: ${listOrNone(stack.applied)}`,
    ...stack.skipped.map(skipped => `Skipped: ${skipped.sentence}`),
    ...stack.partial.map(partial => `Partly supported: ${partial.reference} — ${partial.reason}`),
    ...stack.conflicts.map(conflict => `Overrides: ${conflict.sentence}`),
  ];
}

/** One runtime: its login, its profile's stack, its models and, for an agent, the fixed layer. */
export function renderRuntime(runtime: FleetRuntimeView): string {
  const lines = [
    `${runtime.name}  ${kind(runtime)}`,
    ...indent([
      `Launch: ${unavailable(runtime.launch) ?? 'ready'}`,
      ...(runtime.disabled === undefined
        ? []
        : [`Switch: ${disabledWords(runtime.disabled)} (on its ${runtime.disabled.source})`]),
      `Login: ${login(runtime)}`,
      `Profile: ${runtime.profile}`,
      ...renderStack(runtime.stack).map(line => `  ${line}`),
    ]),
  ];
  const models = runtime.modelSet;
  if (models.source === 'harness-default')
    lines.push(...indent([`Models: the ${HARNESS_LABEL[runtime.harness]} default`]));
  else {
    const offered = models.models.map(model =>
      model.available ? model.id : `${model.id} (not available on this login)`,
    );
    lines.push(
      ...indent([
        `Models (${models.name}): ${offered.join(', ')}`,
        `Starts with: ${models.default ?? 'none of them is available on this login'}`,
        ...(models.note === undefined ? [] : [models.note]),
      ]),
    );
  }
  if (runtime.fixedLayer !== undefined) {
    lines.push(
      ...indent([
        `Added last because Ferretry launches it as an agent (agent permissions: ${runtime.fixedLayer.agentPermissions}):`,
        ...runtime.fixedLayer.entries.map(entry => `  ${entry.key} = ${entry.value}`),
        ...runtime.fixedLayer.overridden.map(entry => `  ${entry.sentence}`),
      ]),
    );
  }
  if (runtime.sameAs.length > 0) lines.push(...indent([`Same login and profile as: ${runtime.sameAs.join(', ')}`]));
  return lines.join('\n');
}
