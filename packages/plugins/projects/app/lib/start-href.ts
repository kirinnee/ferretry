import { daemonHomeHref } from '@ferretry/app';

/**
 * Where "Start a ferret here" goes: Ferrets' New ferret screen (`/d/<daemon>/new`) with this folder in its Folder field
 * (`?folder=`). The query is only a PREFILL: the page's start still goes through the daemon's own fence and grants, so a
 * folder named here is never trusted just because it was named here. Projects' hub imports this too.
 */
export const startFerretHref = (daemon: string, folder: string): string =>
  `${daemonHomeHref(daemon)}/new?folder=${encodeURIComponent(folder)}`;
