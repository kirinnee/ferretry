// Run from the repository root: bun scripts/test/redact-encoded-comparison.ts [samples-per-cell].
// Extract only the historical encoded-value scanner, so historical imports cannot read host state.
import { execFileSync } from 'node:child_process';
import { redactText } from '../../packages/daemon/src/lib/fleet/catalog.ts';
import {
  MATRIX_SHAPES,
  MATRIX_WRAPPERS,
  matrixExposure,
} from '../../packages/daemon/tests/support/redact-encoded-matrix.ts';
import {
  ENCODED_SHAPES,
  ENCODED_WRAPPERS,
  encodedSample,
  exposedEncoded,
} from '../../packages/daemon/tests/support/redact-encoded-samples.ts';

function historical(revision: string): (text: string) => string {
  const source = execFileSync('git', ['show', `${revision}:packages/daemon/src/lib/fleet/catalog.ts`], {
    encoding: 'utf8',
  });
  const word = source.slice(source.indexOf('const WORD =')).split('\n')[0];
  const region = source.slice(source.indexOf('const ENCODED_RUN ='), source.indexOf('/** A line that ends in a name'));
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    `const HIDDEN_TEXT = '‹hidden›';\n${word}\n${region}\nreturn text => redactEncoded(text, () => {});`,
  );
  return new Function(javascript)() as (text: string) => string;
}

const scanners = [historical('a45817b5d3'), historical('5e4f86ca09'), (text: string) => redactText(text).text];
// The existing r3 suite also checks these 13 forms with all 10,000 keys (including keys without '/').
const paths = [
  ['$VAR/', '', false],
  ['$RELAY/', '', false],
  ['$HOME/x/', '', false],
  ['$X/models/', '', false],
  ['$X/', '', true],
  ['./', '', true],
  ['~/', '', true],
  ['/abs/', '', false],
  ['', '/suffix', false],
  ['', '/suffix', true],
  ['', '.v2', true],
  ['', '-7b.gguf', true],
  ['./', '.v2', true],
] as const;
const count = Number(process.argv[2] ?? 2_000);
console.log(`Seed: SHA-256(v4-redaction-r4:sample:offset). ${count} samples containing '/' per cell.`);
console.log(
  'Cells = whole values exposed / samples with >=32-char fragments. Head regressions are checked per sample.',
);
console.log('| Shape | Wrapper | r1 a45817b5d3 | 5e4f86ca09 | head | Worse than 5e4f |');
console.log('| --- | --- | ---: | ---: | ---: | ---: |');
let regressions = 0;
for (const [shape, length] of ENCODED_SHAPES) {
  const wrappers: [string, (value: string) => string, boolean][] = ENCODED_WRAPPERS.map(([name, wrap]) => [
    name,
    wrap,
    false,
  ]);
  if (length === 32) {
    for (const [prefix, suffix, unpadded] of paths) {
      wrappers.push([
        `${prefix}key${suffix}${unpadded ? ' (unpadded)' : ''}`,
        value => `${prefix}${value}${suffix}`,
        unpadded,
      ]);
    }
  }
  for (const [wrapper, wrap, unpadded] of wrappers) {
    const whole = [0, 0, 0];
    const fragments = [0, 0, 0];
    let worse = 0;
    for (let sample = 0, checked = 0; checked < count; sample++) {
      const encoded = encodedSample(sample, length);
      const value = unpadded ? encoded.replace(/=$/u, '') : encoded;
      if (!value.includes('/')) continue;
      checked++;
      const outputs = scanners.map(scan => scan(wrap(value)));
      const exposure = outputs.map(output => exposedEncoded(output, value));
      outputs.forEach((output, index) => {
        if (output.includes(value)) whole[index] = (whole[index] ?? 0) + 1;
        if ((exposure[index] ?? 0) > 0) fragments[index] = (fragments[index] ?? 0) + 1;
      });
      if ((exposure[2] ?? 0) > (exposure[1] ?? 0) || (length === 32 && outputs[2]?.includes(value))) worse++;
    }
    regressions += worse;
    const cells = whole.map((value, index) => `${value} / ${fragments[index]}`);
    console.log(`| ${shape} | ${wrapper} | ${cells.join(' | ')} | ${worse} |`);
  }
}
if (regressions > 0) process.exitCode = 1;

console.log('\nR5 full cross-product. Seed: SHA-256(rv4-opus:tag:sample:offset).');
console.log(`${count} samples per cell; counts are samples with a surviving >=32-character fragment.`);
console.log('| Shape | Wrapper | 5e4f | head | Worse |');
console.log('| --- | --- | ---: | ---: | ---: |');
for (const [shape, generate] of MATRIX_SHAPES) {
  for (const [wrapper, wrap] of MATRIX_WRAPPERS) {
    let baseline = 0;
    let head = 0;
    let worse = 0;
    for (let sample = 0; sample < count; sample++) {
      const input = wrap(generate(sample));
      const reference = matrixExposure(scanners[1]!(input), input);
      const current = matrixExposure(redactText(input).text, input);
      if (reference > 0) baseline++;
      if (current > 0) head++;
      if (current > reference || (shape === 'vault' && current > 0)) worse++;
    }
    console.log(`| ${shape} | ${wrapper} | ${baseline} | ${head} | ${worse} |`);
    regressions += worse;
  }
}
console.log(`\nPer-sample regressions: ${regressions}.`);
if (regressions > 0) process.exitCode = 1;
