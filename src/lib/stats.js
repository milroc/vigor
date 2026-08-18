// OLS trend + exact two-tailed t-test p-value (regularized incomplete beta,
// Numerical Recipes continued fraction). Shared by the fitness panel charts.

export function gammaln(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function betacf(a, b, x) {
  const EPS = 3e-9, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

export function regIncBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b)
    + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? bt * betacf(a, b, x) / a
    : 1 - bt * betacf(b, a, 1 - x) / b;
}

// Least-squares fit over points [{t, v}] with the slope's two-tailed p.
export function fitTrend(pts) {
  if (pts.length < 3) return null;
  const mean = a => a.reduce((sum, v) => sum + v, 0) / a.length;
  const mx = mean(pts.map(p => p.t)), my = mean(pts.map(p => p.v));
  const sxx = pts.reduce((sum, p) => sum + (p.t - mx) ** 2, 0);
  if (!(sxx > 0)) return null;
  const slope = pts.reduce((sum, p) => sum + (p.t - mx) * (p.v - my), 0) / sxx;
  const fit = t => my + slope * (t - mx);
  const sse = pts.reduce((sum, p) => sum + (p.v - fit(p.t)) ** 2, 0);
  const df = pts.length - 2;
  let p = null;
  if (df > 0 && sse > 0) {
    const tStat = slope / Math.sqrt(sse / df / sxx);
    p = regIncBeta(df / 2, 0.5, df / (df + tStat * tStat));
  }
  return { slope, mean: my, fit, p };
}

export const fmtP = p => p == null ? '' : p < 0.001 ? 'p<0.001' : `p=${p.toFixed(3)}`;
