import type { BulkStopSelector, StopPlan, StopSweepResult, StopTarget } from './types.ts';

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

export function selectorDescription(selector: BulkStopSelector): string {
  switch (selector.kind) {
    case 'orphan':
      return `ORPHAN ${selector.rootId} (stop only this session; descendants keep running)`;
    case 'cascade':
      return `CASCADE ${selector.rootId} (stop this session + all transitive descendants)`;
    case 'children':
      return `CHILDREN ${selector.rootId} (stop all transitive descendants; keep this session running)`;
    case 'label':
      return `LABEL ${JSON.stringify(selector.label)} (exact match; independent of lineage)`;
  }
}

export function targetDisplay(target: StopTarget): string {
  const identity = target.teammate
    ? `${target.teammate} — ${target.name} (${target.id})`
    : `${target.name} (${target.id})`;
  const warnings = [target.caller ? 'CALLER' : '', target.callerAncestor ? 'CALLER ANCESTOR / POSSIBLE LEAD' : ''] //
    .filter(Boolean);
  return `${identity}${warnings.length ? `  [${warnings.join('; ')}]` : ''}`;
}

export function renderStopPlan(plan: StopPlan): string {
  const lines = [`Stop selection: ${selectorDescription(plan.selector)}`];
  if (plan.selector.kind === 'orphan') {
    if (plan.leftRunning.length) {
      const noun = plural(plan.leftRunning.length, 'descendant', 'descendants');
      lines.push(`Will leave ${plan.leftRunning.length} live ${noun} running without this parent:`);
      for (const target of plan.leftRunning) lines.push(`  - ${targetDisplay(target)}`);
    } else {
      lines.push('No live descendants will be orphaned.');
    }
    lines.push('');
  }
  lines.push(`Will stop ${plan.targets.length} ${plural(plan.targets.length, 'session', 'sessions')}:`);
  if (plan.targets.length === 0) lines.push('  (none)');
  else for (const target of plan.targets) lines.push(`  - ${targetDisplay(target)}`);

  if (plan.excluded.length) {
    lines.push('', `Excluded for caller safety (${plan.excluded.length}; will NOT be stopped):`);
    for (const target of plan.excluded) lines.push(`  - ${targetDisplay(target)}`);
    lines.push('Use --include-caller to include the issuing session explicitly; it will be stopped last.');
  }

  const leads = plan.targets.filter(target => target.callerAncestor);
  if (leads.length) {
    const verb = plural(leads.length, 'session is', 'sessions are');
    lines.push('', `WARNING: ${leads.length} selected ${verb} in the caller's ancestor/lead chain.`);
  }
  if (plan.targets.some(target => target.caller)) {
    lines.push(
      '',
      'WARNING: the issuing session is selected and may terminate this CLI before its own outcome prints.',
    );
  }
  return lines.join('\n');
}

/**
 * The phrase the human must retype. It names the size and the dangerous inclusions so a muscle
 * memory "y" cannot authorize a sweep the operator did not read.
 */
export function confirmationPhrase(plan: StopPlan): string {
  const protectedKinds = [
    plan.targets.some(target => target.caller) ? 'caller' : '',
    plan.targets.some(target => target.callerAncestor) ? 'lead' : '',
  ].filter(Boolean);
  const orphanImpact =
    plan.selector.kind === 'orphan' && plan.leftRunning.length ? ` leaving ${plan.leftRunning.length}` : '';
  const including = protectedKinds.length ? ` including ${protectedKinds.join(' and ')}` : '';
  return `stop ${plan.targets.length}${orphanImpact}${including}`;
}

/** The reason recorded against every session when the operator supplied none. */
export function defaultStopReason(selector: BulkStopSelector, binaryName: string): string {
  const subject = selector.kind === 'label' ? selector.label : selector.rootId;
  return `stopped by ${binaryName} stop ${selector.kind} ${subject}`;
}

export function renderStopSweep(result: StopSweepResult): string {
  const lines = [`Stop outcomes (${result.outcomes.length}):`];
  if (!result.outcomes.length) lines.push('  (no stop calls made)');
  for (const outcome of result.outcomes) {
    lines.push(
      outcome.ok
        ? `  OK     ${targetDisplay(outcome.target)} — ${outcome.status ?? 'stopped'}`
        : `  FAILED ${targetDisplay(outcome.target)} — ${outcome.error ?? 'unknown error'}`,
    );
  }
  if (result.raceCheckError) {
    lines.push(
      '',
      `RACE CHECK FAILED: ${result.raceCheckError}`,
      'The fleet may contain unreported new matches; inspect it now.',
    );
    return lines.join('\n');
  }
  if (result.kind === 'orphan') {
    const noun = plural(result.leftRunning.length, 'descendant', 'descendants');
    lines.push('', `Left running after the orphan stop (${result.leftRunning.length} live ${noun}):`);
    if (!result.leftRunning.length) lines.push('  (none)');
    else for (const target of result.leftRunning) lines.push(`  - ${targetDisplay(target)}`);
    if (result.appearedLeftRunning.length) {
      const count = result.appearedLeftRunning.length;
      const appeared = plural(count, 'descendant appeared', 'descendants appeared');
      const was = plural(count, 'was', 'were');
      lines.push('', `${count} live ${appeared} after confirmation and ${was} intentionally NOT stopped:`);
      for (const target of result.appearedLeftRunning) lines.push(`  - ${targetDisplay(target)}`);
    } else {
      lines.push('Race check: no new live descendants appeared after confirmation.');
    }
    return lines.join('\n');
  }
  if (result.appeared.length) {
    const count = result.appeared.length;
    const appeared = plural(count, 'session appeared', 'sessions appeared');
    lines.push('', `${count} matching ${appeared} after confirmation and ${plural(count, 'was', 'were')} NOT stopped:`);
    for (const target of result.appeared) lines.push(`  - ${targetDisplay(target)}`);
    lines.push('Re-run the same command to review and confirm the new set.');
    return lines.join('\n');
  }
  lines.push('', 'Race check: no new matching sessions appeared during the sweep.');
  return lines.join('\n');
}
