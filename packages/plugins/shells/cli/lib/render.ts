/** What `fy shell` prints. Pure: the verbs hand it what the daemon answered. */
import type { NixFacts, ShellDetail, ShellLock, ShellSummary } from '../../contract/index.ts';

export function summaryLines(shells: readonly ShellSummary[]): readonly string[] {
  if (shells.length === 0)
    return ['no shells yet; add one with: fy shell add <name> --flake <address> | --packages <a,b>'];
  return shells.map(shell => {
    const pin = shell.locked ? 'locked' : 'not locked';
    const kind = shell.kind === 'flake' ? 'flake' : 'packages';
    return `${shell.name}  ${kind}, ${pin}${shell.floating ? ', floating' : ''}, ${shell.build.replace('-', ' ')}`;
  });
}

export function lockLines(lock: ShellLock): readonly string[] {
  return lock.source.kind === 'flake'
    ? [`source   ${lock.source.ref}`, `revision ${lock.source.rev}`, `narHash  ${lock.source.narHash}`]
    : [
        `packages ${lock.source.packages.join(', ')}`,
        `nixpkgs  ${lock.source.nixpkgs.rev}`,
        `narHash  ${lock.source.nixpkgs.narHash}`,
      ];
}

export function detailLines(detail: ShellDetail): readonly string[] {
  const head = [`shell    ${detail.name}`, ...(detail.item.description === undefined ? [] : [detail.item.description])];
  const state = `state    ${detail.summary.build.replace('-', ' ')}${detail.item.floating ? ', floating' : ''}`;
  return [
    ...head,
    ...(detail.lock === undefined ? ['not locked yet; run: fy shell relock ' + detail.name] : lockLines(detail.lock)),
    state,
  ];
}

export function nixLines(facts: NixFacts): readonly string[] {
  return facts.present
    ? [`nix ${facts.version} is installed; ferrets whose runtime names a shell work inside it`]
    : [`nix is not installed: ${facts.consequence}`, facts.remedy];
}
