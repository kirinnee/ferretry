/**
 * `reference:/` and `reference:$` — a `/name` or `$name` written anywhere (docs/reference-standard.md). Both sigils mean the
 * same skill, so both keys are this one renderer.
 *
 * PROOF BEFORE LINK. The token is a link only when the daemon says the skill is real: in the written-in ferret's own
 * catalog when the value names a ferret, else on this machine's inventory. Both reads are the caller's own, answered at
 * the caller's standing — a daemon that refuses them leaves the token as the plain text it was written as. A name the
 * grammar would not read as a skill (`$HOME`) is never asked about.
 */
import { daemonSettingsHref } from '@ferretry/app';
import { RouteLink } from '@ferretry/app/ui';
import type { AppComponent, PluginClient, RendererProps } from '@ferretry/kernel/manifest';
import { type ReactNode, useEffect, useState } from 'react';
import { readFerretSkills, readMachineSkills } from '../lib/client.ts';
import { referenceScope, skillNameOf } from '../lib/skills-model.ts';

type Proof = 'asking' | 'proved' | 'unproved';

/** Whether the daemon lists `name`, for the ferret the reference was written in when it names one. */
export async function proveSkill(
  client: Pick<PluginClient, 'call'>,
  name: string,
  ferretId: string | undefined,
): Promise<boolean> {
  try {
    if (ferretId !== undefined)
      return (await readFerretSkills(client, ferretId)).skills.some(skill => skill.name === name);
    const machine = await readMachineSkills(client);
    return [...machine.homes, ...machine.projects].some(place => place.skills.some(skill => skill.name === name));
  } catch {
    // Absence is honest: a read this caller may not make proves nothing.
    return false;
  }
}

/** One daemon's skill reference: built once per client and sigil. */
export function createSkillReference(
  client: Pick<PluginClient, 'call'>,
  sigil: '/' | '$',
): AppComponent<RendererProps> {
  return function SkillReference({ value }: RendererProps): ReactNode {
    const name = skillNameOf(value);
    const { ferretId, daemon } = referenceScope(value);
    const [proof, setProof] = useState<Proof>('asking');
    useEffect(() => {
      if (name === undefined) return;
      let live = true;
      setProof('asking');
      void proveSkill(client, name, ferretId).then(found => {
        if (live) setProof(found ? 'proved' : 'unproved');
      });
      return () => {
        live = false;
      };
    }, [name, ferretId]);
    if (name === undefined) return <>{typeof value === 'string' ? value : ''}</>;
    const written = `${sigil}${name}`;
    // Unproved — and still being asked — stay plain text. A proved token with no daemon to address has nowhere to go.
    if (proof !== 'proved' || daemon === undefined) return <>{written}</>;
    return (
      <RouteLink to={daemonSettingsHref(daemon, 'skills')} title={`Open the ${written} skill in Settings › Skills`}>
        {written}
      </RouteLink>
    );
  };
}
