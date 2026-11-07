/**
 * WHERE THE NEW-FERRET PAGE SENDS THE READER. The shell does not hand a half its route table, so the few addresses this
 * page needs are built from the shell's own exported builders and the screen paths other manifests declare.
 *
 * GAP(app): `screenHref` (the shell's route-table link builder, being added to `@ferretry/app` with the Conversation
 * port) replaces `ferretChatHref` once it lands; nothing else here is a stand-in.
 */

import { daemonHomeHref, daemonSettingsHref } from '@ferretry/app';

/** Conversation's chat screen (`ferrets/:ferret/chat`, per daemon) for one ferret. */
export const ferretChatHref = (daemon: string, ferret: string): string =>
  `${daemonHomeHref(daemon)}/ferrets/${encodeURIComponent(ferret)}/chat`;

/** The Runtimes tab of this daemon's settings: where a runtime is created. */
export const runtimesSettingsHref = (daemon: string): string => daemonSettingsHref(daemon, 'runtimes', 'runtimes');

export { daemonHomeHref };
