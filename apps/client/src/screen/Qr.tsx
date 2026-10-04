// The join QR code, drawn as one SVG path (sharp at any size, no image request).
import { useMemo } from 'react';
import { encode } from 'uqr';

/** Dark modules as one path: "M x y h1v1h-1z" per module. */
function qrPath(text: string): { size: number; d: string } {
  // "M" error correction: still reads when part of the code is hidden by glare or a head
  const { size, data } = encode(text, { ecc: 'M', border: 0 });
  let d = '';
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return { size, d };
}

/** A QR code for `text`: dark on ivory, with the quiet zone scanners need around it. */
export function Qr({ text, px }: { text: string; px: number }) {
  const { size, d } = useMemo(() => qrPath(text), [text]);
  const quiet = 4; // the blank border scanners need (4 modules, as the QR standard asks)
  const view = size + quiet * 2;
  return (
    <svg
      className="qr"
      width={px}
      height={px}
      viewBox={`${-quiet} ${-quiet} ${view} ${view}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code"
    >
      <rect x={-quiet} y={-quiet} width={view} height={view} className="qr-bg" />
      <path d={d} className="qr-ink" />
    </svg>
  );
}
