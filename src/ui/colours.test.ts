// Colour roles (plan 2026-11-16-mobile-ux D1/D2): reads the tokens in styles.css and checks that text colours are
// readable (WCAG 4.5:1) and that no two hues that mean different things look alike (CIEDE2000 >= 15).
// @ts-expect-error the project has no @types/node; vitest runs on Node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css: string = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

/** Body of the block that opens at `start` (balanced braces). */
function block(start: number): string {
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error('unbalanced css');
}
function tokens(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].replace(/\/\*.*?\*\//g, '').trim();
  return out;
}
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const light = tokens(block(css.indexOf(':root {')));
// The dark block wraps a `:root { … }`; its tokens override the light ones.
const dark = { ...light, ...tokens(block(darkStart + css.slice(darkStart).indexOf(':root'))) };

function hex(theme: Record<string, string>, name: string): [number, number, number] {
  let v = theme[name];
  for (let i = 0; i < 5 && v?.startsWith('var('); i++) v = theme[v.slice(4, -1).trim()];
  if (!v || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${name} is not a hex colour: ${v}`);
  return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) as [number, number, number];
}
const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
function contrast(a: number[], b: number[]): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function lab([r, g, b]: number[]): [number, number, number] {
  const [R, G, B] = [r, g, b].map(lin);
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
/** CIEDE2000 (Sharma, Wu, Dalal 2005). */
const de2000 = (c1: number[], c2: number[]) => deltaE(lab(c1), lab(c2));
function deltaE([L1, a1, b1]: number[], [L2, a2, b2]: number[]): number {
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
  const hp = (b: number, a: number) => (b === 0 && a === 0 ? 0 : ((Math.atan2(b, a) * deg) + 360) % 360);
  const h1 = hp(b1, ap1), h2 = hp(b2, ap2);
  const dL = L2 - L1, dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh * rad) / 2);
  const Lb = (L1 + L2) / 2, Cpb = (Cp1 + Cp2) / 2;
  let hb = h1 + h2;
  if (Cp1 * Cp2 !== 0) {
    if (Math.abs(h1 - h2) > 180) hb += h1 + h2 < 360 ? 360 : -360;
    hb /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hb - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpb ** 7 / (Cpb ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const Sc = 1 + 0.045 * Cpb, Sh = 1 + 0.015 * Cpb * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

describe('CIEDE2000 implementation', () => {
  it('matches published reference pairs (Sharma et al. 2005)', () => {
    expect(deltaE([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
    expect(deltaE([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 3);
    expect(deltaE([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387])).toBeCloseTo(1.2644, 3);
  });
});

const themes = { light, dark } as const;
const words = ['--label', '--label-2', '--label-3', '--t1', '--t2', '--t3', '--t4', '--t5', '--green', '--yellow', '--blue', '--wrong', '--accent'];
const statuses = ['--green', '--badge-green', '--yellow', '--badge-yellow', '--blue', '--badge-blue', '--wrong'];
const tones = ['--t1', '--t2', '--t3', '--t4'];

for (const [name, theme] of Object.entries(themes)) {
  describe(`${name} theme`, () => {
    for (const bg of ['--bg', '--bg-elev']) {
      it(`word colours reach 4.5:1 on ${bg}`, () => {
        for (const t of words) expect(contrast(hex(theme, t), hex(theme, bg)), `${t} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      });
    }
    it('on-accent text reads on the accent fill', () => {
      expect(contrast(hex(theme, '--on-accent'), hex(theme, '--accent'))).toBeGreaterThanOrEqual(4.5);
    });
    it('tones differ from every status hue and from Wrong (CIEDE2000 >= 15)', () => {
      for (const t of tones) for (const s of statuses) expect(de2000(hex(theme, t), hex(theme, s)), `${t} vs ${s}`).toBeGreaterThanOrEqual(15);
    });
    it('tones differ from each other (CIEDE2000 >= 15)', () => {
      for (let i = 0; i < tones.length; i++)
        for (let j = i + 1; j < tones.length; j++) expect(de2000(hex(theme, tones[i]), hex(theme, tones[j])), `${tones[i]} vs ${tones[j]}`).toBeGreaterThanOrEqual(15);
    });
  });
}
