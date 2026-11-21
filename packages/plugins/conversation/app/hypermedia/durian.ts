import { readConfigText } from '@ferretry/std/yaml';
import { setYamlParser } from 'durian-hypermedia';

/**
 * DURIAN'S ONE HOST SETTING. The format reads YAML (front matter, chart and animation data) through a parser the host
 * gives it: the browser has no `Bun.YAML`, and Durian ships none of its own (`durian-hypermedia/src/host/yaml.ts`).
 * Ours is the repository's shared BOUNDED reader (`@ferretry/std/yaml`: a size cap, an alias budget, no YAML 1.1 tags,
 * duplicate keys refused), the only door text a person or an agent wrote may go through. A text it refuses throws, and
 * Durian turns the throw into a problem on that part, so the part is not drawn from it. Agent output is untrusted input;
 * Durian also refuses an alias bomb before it gets here, and this is the second lock on the same door.
 *
 * Call it once before the first `parse`; calling it again is harmless.
 */
export function configureDurian(): void {
  setYamlParser(text => {
    const read = readConfigText(text);
    if (!read.ok) throw new Error(read.errors[0]?.message ?? 'the YAML could not be read');
    return read.read.value;
  });
}
