/**
 * OPTION A — "The burrow": calm, warm, illustrated.
 *
 * A ferret peeks out of its hole while you decide. On success it pops all the way up, dooks (the happy ferret
 * wiggle), waves a paw and a little burst of sparkles goes off. The Fleet Grid logomark stays the brand in the corner;
 * the ferret is an illustration, not a second logo. Serif display type (Gelasio, already bundled for the Broadsheet
 * family) gives the page a warm voice; the colour is the app's own tokens plus a small fur palette (proto.css).
 */
import { Actions, CheckBadge, FAKE, Lockup, MachineCard, NameField, type OptionProps } from './shared.tsx';

const SPARKS = [
  { x: -100, y: -44, d: 0 },
  { x: -66, y: -82, d: 40 },
  { x: -22, y: -100, d: 80 },
  { x: 30, y: -98, d: 20 },
  { x: 74, y: -72, d: 60 },
  { x: 104, y: -34, d: 100 },
  { x: -112, y: 8, d: 50 },
] as const;

function Ferret({ stage }: { readonly stage: OptionProps['stage'] }) {
  return (
    <svg className="p3a-art" viewBox="0 0 240 190" aria-hidden="true" focusable="false" data-stage={stage}>
      <defs>
        <clipPath id="p3a-clip">
          <rect x="0" y="-60" width="240" height="250" />
        </clipPath>
      </defs>
      <ellipse className="p3a-glow" cx="120" cy="110" rx="104" ry="84" />
      <ellipse className="p3a-hill" cx="120" cy="166" rx="112" ry="26" />
      <ellipse className="p3a-hole" cx="120" cy="148" rx="54" ry="16" />

      <g clipPath="url(#p3a-clip)">
        <g className="p3a-ferret">
          <rect className="p3a-fur" x="97" y="70" width="46" height="110" rx="22" />
          <g className="p3a-head">
            <circle className="p3a-fur" cx="88" cy="38" r="12" />
            <circle className="p3a-fur" cx="152" cy="38" r="12" />
            <circle className="p3a-ear" cx="88" cy="39" r="6" />
            <circle className="p3a-ear" cx="152" cy="39" r="6" />
            <ellipse className="p3a-fur" cx="120" cy="62" rx="38" ry="32" />
            <ellipse className="p3a-cream" cx="120" cy="70" rx="27" ry="22" />
            <rect className="p3a-mask" x="90" y="50" width="60" height="19" rx="9.5" />
            <g className="p3a-eyes">
              <circle className="p3a-eye" cx="106" cy="59.5" r="3.8" />
              <circle className="p3a-eye" cx="134" cy="59.5" r="3.8" />
              <circle className="p3a-glint" cx="107.2" cy="58.2" r="1.2" />
              <circle className="p3a-glint" cx="135.2" cy="58.2" r="1.2" />
            </g>
            <ellipse className="p3a-blush" cx="96" cy="76" rx="6" ry="4" />
            <ellipse className="p3a-blush" cx="144" cy="76" rx="6" ry="4" />
            <ellipse className="p3a-cream-light" cx="120" cy="77" rx="14" ry="10" />
            <ellipse className="p3a-nose" cx="120" cy="71.5" rx="5" ry="3.6" />
            <path className="p3a-mouth" d="M113.5 80 Q120 86.5 126.5 80" />
            <g className="p3a-whiskers">
              <path d="M104 76 L84 72 M104 79 L83 80 M105 82 L86 88" />
              <path d="M136 76 L156 72 M136 79 L157 80 M135 82 L154 88" />
            </g>
          </g>
        </g>
      </g>

      {/* The lip of the hole is in FRONT of the ferret, so it can sink behind it. */}
      <path className="p3a-lip" d="M66 148 Q120 180 174 148 L174 190 L66 190 Z" />
      <path className="p3a-lip-edge" d="M66 148 Q120 180 174 148" />

      <ellipse className="p3a-paw p3a-paw-l" cx="94" cy="160" rx="12" ry="8.5" />
      <g className="p3a-wave">
        <ellipse className="p3a-paw p3a-paw-r" cx="146" cy="160" rx="12" ry="8.5" />
      </g>

      <g className="p3a-sparks">
        {SPARKS.map(spark => (
          <circle
            key={`${spark.x}:${spark.y}`}
            className="p3a-spark"
            cx="120"
            cy="96"
            r="4.4"
            style={{ '--dx': `${spark.x}px`, '--dy': `${spark.y}px`, '--delay': `${spark.d}ms` } as React.CSSProperties}
          />
        ))}
      </g>
    </svg>
  );
}

export function OptionA({ stage, onPair, onCancel, detailsOpen = false }: OptionProps) {
  if (stage === 'paired') {
    return (
      <main className="p3 p3a" data-pairing-stage="paired" aria-labelledby="p3-title">
        <Lockup />
        <div className="p3a-hero">
          <Ferret stage={stage} />
          <span className="p3a-badge" aria-hidden="true">
            <CheckBadge size={22} />
          </span>
        </div>
        <div className="p3a-copy p3a-copy-done">
          <h1 id="p3-title" className="p3-title">
            Connected
          </h1>
          <p className="p3-sub">
            Paired with <strong>{FAKE.machine}</strong>. Welcome in.
          </p>
        </div>
      </main>
    );
  }
  return (
    <main className="p3 p3a" data-pairing-stage={stage} aria-labelledby="p3-title">
      <Lockup />
      <div className="p3a-hero">
        <Ferret stage={stage} />
      </div>
      <div className="p3a-copy">
        <h1 id="p3-title" className="p3-title">
          Pair this device?
        </h1>
        <p className="p3-sub">Your ferrets are waiting on the other side.</p>
      </div>
      <MachineCard startOpen={detailsOpen} />
      <NameField busy={stage === 'pairing'} />
      <Actions stage={stage} onPair={onPair} onCancel={onCancel} />
    </main>
  );
}
