// Canadian Forest Fire Weather Index (FWI) System — van Wagner & Pickett (1987).
// Computed daily from noon weather; the moisture codes accumulate day to day.
// Inputs: temp °C, RH %, wind km/h, 24 h rain mm, calendar month (1-12), and the
// previous day's FFMC/DMC/DC (startup defaults used on the first run).

export interface FwiInput {
  temp: number; rh: number; wind: number; rain: number; month: number;
  ffmc0: number; dmc0: number; dc0: number;
}
export interface FwiOutput {
  ffmc: number; dmc: number; dc: number; isi: number; bui: number; fwi: number;
}

// Standard startup values (spring).
export const FWI_START = { ffmc: 85, dmc: 6, dc: 15 };

// Day-length factors by month (Northern Hemisphere).
const LE = [6.5, 7.5, 9.0, 12.8, 13.9, 13.9, 12.4, 10.9, 9.4, 8.0, 7.0, 6.0]; // DMC
const LF = [-1.6, -1.6, -1.6, 0.9, 3.8, 5.8, 6.4, 5.0, 2.4, 0.4, -1.6, -1.6]; // DC

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function computeFwi(i: FwiInput): FwiOutput {
  const { temp: T, rh: Hraw, wind: W, rain: ro, month } = i;
  const H = clamp(Hraw, 0, 100);
  const mth = clamp(month, 1, 12) - 1;

  // --- FFMC ---
  let mo = (147.2 * (101 - i.ffmc0)) / (59.5 + i.ffmc0);
  if (ro > 0.5) {
    const rf = ro - 0.5;
    let mr = mo + 42.5 * rf * Math.exp(-100 / (251 - mo)) * (1 - Math.exp(-6.93 / rf));
    if (mo > 150) mr += 0.0015 * (mo - 150) ** 2 * Math.sqrt(rf);
    mo = Math.min(mr, 250);
  }
  const Ed = 0.942 * H ** 0.679 + 11 * Math.exp((H - 100) / 10) + 0.18 * (21.1 - T) * (1 - Math.exp(-0.115 * H));
  let m: number;
  if (mo > Ed) {
    const ko = 0.424 * (1 - (H / 100) ** 1.7) + 0.0694 * Math.sqrt(W) * (1 - (H / 100) ** 8);
    m = Ed + (mo - Ed) * 10 ** (-ko * 0.581 * Math.exp(0.0365 * T));
  } else {
    const Ew = 0.618 * H ** 0.753 + 10 * Math.exp((H - 100) / 10) + 0.18 * (21.1 - T) * (1 - Math.exp(-0.115 * H));
    if (mo < Ew) {
      const kl = 0.424 * (1 - ((100 - H) / 100) ** 1.7) + 0.0694 * Math.sqrt(W) * (1 - ((100 - H) / 100) ** 8);
      m = Ew - (Ew - mo) * 10 ** (-kl * 0.581 * Math.exp(0.0365 * T));
    } else {
      m = mo;
    }
  }
  const ffmc = clamp(59.5 * (250 - m) / (147.2 + m), 0, 101);

  // --- DMC ---
  const Td = Math.max(T, -1.1);
  const rk = 1.894 * (Td + 1.1) * (100 - H) * LE[mth] * 1e-4;
  let dmcPrev = i.dmc0;
  if (ro > 1.5) {
    const re = 0.92 * ro - 1.27;
    const m0 = 20 + Math.exp(5.6348 - dmcPrev / 43.43);
    let b: number;
    if (dmcPrev <= 33) b = 100 / (0.5 + 0.3 * dmcPrev);
    else if (dmcPrev <= 65) b = 14 - 1.3 * Math.log(dmcPrev);
    else b = 6.2 * Math.log(dmcPrev) - 17.2;
    const mr = m0 + (1000 * re) / (48.77 + b * re);
    dmcPrev = Math.max(244.72 - 43.43 * Math.log(mr - 20), 0);
  }
  const dmc = Math.max(dmcPrev + rk, 0);

  // --- DC ---
  const Tc = Math.max(T, -2.8);
  const pe = Math.max((0.36 * (Tc + 2.8) + LF[mth]) / 2, 0);
  let dcPrev = i.dc0;
  if (ro > 2.8) {
    const rd = 0.83 * ro - 1.27;
    const Qo = 800 * Math.exp(-dcPrev / 400);
    const Qr = Qo + 3.937 * rd;
    dcPrev = Math.max(400 * Math.log(800 / Qr), 0);
  }
  const dc = Math.max(dcPrev + pe, 0);

  // --- ISI ---
  const fW = Math.exp(0.05039 * W);
  const fF = 91.9 * Math.exp(-0.1386 * m) * (1 + m ** 5.31 / 4.93e7);
  const isi = 0.208 * fW * fF;

  // --- BUI ---
  let bui: number;
  if (dmc <= 0.4 * dc) bui = (0.8 * dmc * dc) / (dmc + 0.4 * dc || 1);
  else bui = dmc - (1 - (0.8 * dc) / (dmc + 0.4 * dc)) * (0.92 + (0.0114 * dmc) ** 1.7);
  bui = Math.max(bui, 0);

  // --- FWI ---
  const fD = bui <= 80 ? 0.626 * bui ** 0.809 + 2 : 1000 / (25 + 108.64 * Math.exp(-0.023 * bui));
  const B = 0.1 * isi * fD;
  const fwi = B > 1 ? Math.exp(2.72 * (0.434 * Math.log(B)) ** 0.647) : B;

  const r1 = (v: number) => Math.round(v * 10) / 10;
  return { ffmc: r1(ffmc), dmc: r1(dmc), dc: r1(dc), isi: r1(isi), bui: r1(bui), fwi: r1(fwi) };
}
