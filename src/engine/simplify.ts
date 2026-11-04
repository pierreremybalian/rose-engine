// Ramer–Douglas–Peucker polyline simplification over a slice of the toolpath arrays.

/**
 * Simplify samples [start, start + count) of (xs, ys). Returns the kept sample indices (absolute,
 * ascending). Open paths always keep both endpoints. Closed loops are split at the point farthest
 * from the start and each half is simplified separately; the first index is NOT repeated at the end
 * (the consumer closes the loop, e.g. SVG 'Z'). tolerance <= 0 keeps every non-collinear point.
 */
export function simplifyPolyline(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  start: number,
  count: number,
  tolerance: number,
  closed: boolean,
): number[] {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return [];
  if (n <= 2) {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(start + i);
    return out;
  }
  const tol2 = tolerance > 0 ? tolerance * tolerance : 0;
  const keep = new Uint8Array(n); // local indices; index n stands for "back to start" in closed mode
  const stack: number[] = [];

  // Local index -> coordinates. Local n wraps to 0 (closing point).
  const X = (i: number) => xs[start + (i === n ? 0 : i)];
  const Y = (i: number) => ys[start + (i === n ? 0 : i)];

  const rdp = (a: number, b: number) => {
    stack.push(a, b);
    while (stack.length) {
      const hi = stack.pop() as number;
      const lo = stack.pop() as number;
      if (hi - lo < 2) continue;
      const ax = X(lo);
      const ay = Y(lo);
      const dx = X(hi) - ax;
      const dy = Y(hi) - ay;
      const len2 = dx * dx + dy * dy;
      let best = -1;
      let bestD = tol2;
      for (let i = lo + 1; i < hi; i++) {
        const px = X(i) - ax;
        const py = Y(i) - ay;
        let d2: number;
        if (len2 > 1e-24) {
          const c = px * dy - py * dx;
          d2 = (c * c) / len2;
        } else {
          d2 = px * px + py * py;
        }
        if (d2 > bestD) {
          bestD = d2;
          best = i;
        }
      }
      if (best >= 0) {
        keep[best] = 1;
        stack.push(lo, best, best, hi);
      }
    }
  };

  keep[0] = 1;
  if (!closed) {
    keep[n - 1] = 1;
    rdp(0, n - 1);
  } else {
    // Split at the point farthest from the start.
    const x0 = X(0);
    const y0 = Y(0);
    let far = 1;
    let farD = -1;
    for (let i = 1; i < n; i++) {
      const dx = X(i) - x0;
      const dy = Y(i) - y0;
      const d = dx * dx + dy * dy;
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    keep[far] = 1;
    rdp(0, far);
    rdp(far, n); // n = back to the start point
  }

  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(start + i);
  return out;
}
