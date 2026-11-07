/**
 * THE APP'S SURFACE REGISTRY — written by `scripts/gen/registries.ts` (§7.5); do not edit by hand.
 *
 * DAY-1 STUB: until the generator lands, this file is a hand-written stand-in of the same shape. Every `contract`
 * is the placeholder `unhashed`, which no daemon ever publishes, so every package is blocked `different` against a
 * real daemon until the generator writes the real effective hashes. `consumes` is empty for the same reason.
 */
import kernelManifest from '@ferretry/kernel/plugin';
import gateManifest from '@ferretry/core-gate/manifest';
import gateApp from '@ferretry/core-gate/app';
import vaultManifest from '@ferretry/core-vault/manifest';
import vaultApp from '@ferretry/core-vault/app';
import ferretsManifest from '@ferretry/core-ferrets/manifest';
import ferretsApp from '@ferretry/core-ferrets/app';
import asksManifest from '@ferretry/core-asks/manifest';
import asksApp from '@ferretry/core-asks/app';
import accessManifest from '@ferretry/plugin-access/manifest';
import accessApp from '@ferretry/plugin-access/app';
import accountsManifest from '@ferretry/plugin-accounts/manifest';
import accountsApp from '@ferretry/plugin-accounts/app';
import agendaManifest from '@ferretry/plugin-agenda/manifest';
import agendaApp from '@ferretry/plugin-agenda/app';
import boardManifest from '@ferretry/plugin-board/manifest';
import boardApp from '@ferretry/plugin-board/app';
import browsersManifest from '@ferretry/plugin-browsers/manifest';
import browsersApp from '@ferretry/plugin-browsers/app';
import catalogsManifest from '@ferretry/plugin-catalogs/manifest';
import catalogsApp from '@ferretry/plugin-catalogs/app';
import claudeCodeManifest from '@ferretry/plugin-claude-code/manifest';
import claudeCodeApp from '@ferretry/plugin-claude-code/app';
import codexManifest from '@ferretry/plugin-codex/manifest';
import codexApp from '@ferretry/plugin-codex/app';
import connectionsManifest from '@ferretry/plugin-connections/manifest';
import connectionsApp from '@ferretry/plugin-connections/app';
import conversationManifest from '@ferretry/plugin-conversation/manifest';
import conversationApp from '@ferretry/plugin-conversation/app';
import layoutsManifest from '@ferretry/plugin-layouts/manifest';
import layoutsApp from '@ferretry/plugin-layouts/app';
import lessonsManifest from '@ferretry/plugin-lessons/manifest';
import lessonsApp from '@ferretry/plugin-lessons/app';
import loginsManifest from '@ferretry/plugin-logins/manifest';
import loginsApp from '@ferretry/plugin-logins/app';
import mcpManifest from '@ferretry/plugin-mcp/manifest';
import mcpApp from '@ferretry/plugin-mcp/app';
import onboardingManifest from '@ferretry/plugin-onboarding/manifest';
import onboardingApp from '@ferretry/plugin-onboarding/app';
import packsManifest from '@ferretry/plugin-packs/manifest';
import packsApp from '@ferretry/plugin-packs/app';
import projectsManifest from '@ferretry/plugin-projects/manifest';
import projectsApp from '@ferretry/plugin-projects/app';
import runtimesManifest from '@ferretry/plugin-runtimes/manifest';
import runtimesApp from '@ferretry/plugin-runtimes/app';
import shellsManifest from '@ferretry/plugin-shells/manifest';
import shellsApp from '@ferretry/plugin-shells/app';
import skillsManifest from '@ferretry/plugin-skills/manifest';
import skillsApp from '@ferretry/plugin-skills/app';
import terminalsManifest from '@ferretry/plugin-terminals/manifest';
import terminalsApp from '@ferretry/plugin-terminals/app';
import tidyManifest from '@ferretry/plugin-tidy/manifest';
import tidyApp from '@ferretry/plugin-tidy/app';
import updatesManifest from '@ferretry/plugin-updates/manifest';
import updatesApp from '@ferretry/plugin-updates/app';
import usageManifest from '@ferretry/plugin-usage/manifest';
import usageApp from '@ferretry/plugin-usage/app';
import voiceManifest from '@ferretry/plugin-voice/manifest';
import voiceApp from '@ferretry/plugin-voice/app';
import wardenManifest from '@ferretry/plugin-warden/manifest';
import wardenApp from '@ferretry/plugin-warden/app';
import type { GeneratedSurfaces } from '../surfaces/registry.ts';

const UNHASHED = 'unhashed';

export const generated: GeneratedSurfaces = {
  appVersion: '5.0.0',
  surfaces: [
    { id: 'kernel', title: kernelManifest.title, core: true, contract: UNHASHED, consumes: [], manifest: kernelManifest },
    { id: 'gate', title: gateManifest.title, core: gateManifest.core, contract: UNHASHED, consumes: [], manifest: gateManifest, app: gateApp },
    { id: 'vault', title: vaultManifest.title, core: vaultManifest.core, contract: UNHASHED, consumes: [], manifest: vaultManifest, app: vaultApp },
    { id: 'ferrets', title: ferretsManifest.title, core: ferretsManifest.core, contract: UNHASHED, consumes: [], manifest: ferretsManifest, app: ferretsApp },
    { id: 'asks', title: asksManifest.title, core: asksManifest.core, contract: UNHASHED, consumes: [], manifest: asksManifest, app: asksApp },
    { id: 'access', title: accessManifest.title, core: accessManifest.core, contract: UNHASHED, consumes: [], manifest: accessManifest, app: accessApp },
    { id: 'accounts', title: accountsManifest.title, core: accountsManifest.core, contract: UNHASHED, consumes: [], manifest: accountsManifest, app: accountsApp },
    { id: 'agenda', title: agendaManifest.title, core: agendaManifest.core, contract: UNHASHED, consumes: [], manifest: agendaManifest, app: agendaApp },
    { id: 'board', title: boardManifest.title, core: boardManifest.core, contract: UNHASHED, consumes: [], manifest: boardManifest, app: boardApp },
    { id: 'browsers', title: browsersManifest.title, core: browsersManifest.core, contract: UNHASHED, consumes: [], manifest: browsersManifest, app: browsersApp },
    { id: 'catalogs', title: catalogsManifest.title, core: catalogsManifest.core, contract: UNHASHED, consumes: [], manifest: catalogsManifest, app: catalogsApp },
    { id: 'claude-code', title: claudeCodeManifest.title, core: claudeCodeManifest.core, contract: UNHASHED, consumes: [], manifest: claudeCodeManifest, app: claudeCodeApp },
    { id: 'codex', title: codexManifest.title, core: codexManifest.core, contract: UNHASHED, consumes: [], manifest: codexManifest, app: codexApp },
    { id: 'connections', title: connectionsManifest.title, core: connectionsManifest.core, contract: UNHASHED, consumes: [], manifest: connectionsManifest, app: connectionsApp },
    { id: 'conversation', title: conversationManifest.title, core: conversationManifest.core, contract: UNHASHED, consumes: [], manifest: conversationManifest, app: conversationApp },
    { id: 'layouts', title: layoutsManifest.title, core: layoutsManifest.core, contract: UNHASHED, consumes: [], manifest: layoutsManifest, app: layoutsApp },
    { id: 'lessons', title: lessonsManifest.title, core: lessonsManifest.core, contract: UNHASHED, consumes: [], manifest: lessonsManifest, app: lessonsApp },
    { id: 'logins', title: loginsManifest.title, core: loginsManifest.core, contract: UNHASHED, consumes: [], manifest: loginsManifest, app: loginsApp },
    { id: 'mcp', title: mcpManifest.title, core: mcpManifest.core, contract: UNHASHED, consumes: [], manifest: mcpManifest, app: mcpApp },
    { id: 'onboarding', title: onboardingManifest.title, core: onboardingManifest.core, contract: UNHASHED, consumes: [], manifest: onboardingManifest, app: onboardingApp },
    { id: 'packs', title: packsManifest.title, core: packsManifest.core, contract: UNHASHED, consumes: [], manifest: packsManifest, app: packsApp },
    { id: 'projects', title: projectsManifest.title, core: projectsManifest.core, contract: UNHASHED, consumes: [], manifest: projectsManifest, app: projectsApp },
    { id: 'runtimes', title: runtimesManifest.title, core: runtimesManifest.core, contract: UNHASHED, consumes: [], manifest: runtimesManifest, app: runtimesApp },
    { id: 'shells', title: shellsManifest.title, core: shellsManifest.core, contract: UNHASHED, consumes: [], manifest: shellsManifest, app: shellsApp },
    { id: 'skills', title: skillsManifest.title, core: skillsManifest.core, contract: UNHASHED, consumes: [], manifest: skillsManifest, app: skillsApp },
    { id: 'terminals', title: terminalsManifest.title, core: terminalsManifest.core, contract: UNHASHED, consumes: [], manifest: terminalsManifest, app: terminalsApp },
    { id: 'tidy', title: tidyManifest.title, core: tidyManifest.core, contract: UNHASHED, consumes: [], manifest: tidyManifest, app: tidyApp },
    { id: 'updates', title: updatesManifest.title, core: updatesManifest.core, contract: UNHASHED, consumes: [], manifest: updatesManifest, app: updatesApp },
    { id: 'usage', title: usageManifest.title, core: usageManifest.core, contract: UNHASHED, consumes: [], manifest: usageManifest, app: usageApp },
    { id: 'voice', title: voiceManifest.title, core: voiceManifest.core, contract: UNHASHED, consumes: [], manifest: voiceManifest, app: voiceApp },
    { id: 'warden', title: wardenManifest.title, core: wardenManifest.core, contract: UNHASHED, consumes: [], manifest: wardenManifest, app: wardenApp },
  ],
};
