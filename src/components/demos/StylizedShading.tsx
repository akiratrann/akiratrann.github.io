"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/*
  CS248A assignment 4 — the stylized renderer, running in the browser.

  Every stylization below is transcribed from the notebooks in
  cs248a-asst4/notebooks/: cel_shading.ipynb, guilty_gear_cel.ipynb,
  halftone.ipynb, kuwahara_filter.ipynb, gooch_shading.ipynb,
  watercolor.ipynb, stippling.ipynb, curvature_shading.ipynb —
  including their default arguments and their two different luma weightings.

  The thing that makes this project different from a toon *shader* is that
  none of it is a shader. Assignment 3 path-traces the frame; assignment 4
  takes that finished linear-RGB buffer and stylizes it in image space with
  numpy and scipy.ndimage. So the band edges land on luminance, not on N·L,
  and the outlines come from a Sobel over the already-quantized image rather
  than from geometry.

  The one thing that cannot come across the wire is the assignment 3 Slang
  path tracer and its .obj meshes. The baseline frame here is a small CPU
  ray trace of a sphere on a plane, using render.py's own camera (distance
  3.0, fov 45) — a stand-in for the input, clearly labelled as one. Every
  pixel after that point is the notebooks' arithmetic.
*/

const SIZE = 240;

/* render.py: create_default_renderer / render_mesh_scene_to_numpy defaults. */
const CAMERA_DISTANCE = 3.0;
const FOV = 45.0;

/* ---------------------------------------------------------------- helpers */

type V3 = [number, number, number];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function dot(a: V3, b: V3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v: V3): V3 {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
}

/** scipy.ndimage's default `mode="reflect"` — the edge sample is repeated. */
function symIdx(i: number, n: number): number {
  const period = 2 * n;
  let p = ((i % period) + period) % period;
  if (p >= n) p = period - 1 - p;
  return p;
}

/** numpy.pad's `mode="reflect"` — the edge sample is *not* repeated. */
function mirrorIdx(i: number, n: number): number {
  if (n === 1) return 0;
  const period = 2 * n - 2;
  const p = ((i % period) + period) % period;
  return p < n ? p : period - p;
}

/** The weights cel_shade() and gooch() use: Rec. 709 relative luminance. */
function luma709(rgb: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
  }
  return out;
}

/** The weights the *other* five functions use: Rec. 601 luma. */
function luma601(rgb: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  }
  return out;
}

/** scipy.ndimage.sobel(g, axis=1) and (…, axis=0), then the magnitude. */
function sobelMagnitude(gray: Float32Array, w: number, h: number): Float32Array {
  const mag = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = symIdx(y - 1, h) * w;
    const y1 = y * w;
    const y2 = symIdx(y + 1, h) * w;
    for (let x = 0; x < w; x++) {
      const x0 = symIdx(x - 1, w);
      const x2 = symIdx(x + 1, w);
      const gx =
        gray[y0 + x2] + 2 * gray[y1 + x2] + gray[y2 + x2] -
        (gray[y0 + x0] + 2 * gray[y1 + x0] + gray[y2 + x0]);
      const gy =
        gray[y2 + x0] + 2 * gray[y2 + x] + gray[y2 + x2] -
        (gray[y0 + x0] + 2 * gray[y0 + x] + gray[y0 + x2]);
      mag[y1 + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return mag;
}

function maxOf(a: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  return m;
}

/* -------------------------------------------------- the eight stylizations */

/*
  cel_shading.ipynb — cel_shade().

  bins = np.linspace(0, 1, n_bands + 1); idx = np.digitize(lum, bins) - 1.
  bins[idx] is the *lower* edge of the bin, so band 0 quantizes to exactly
  0.0 and the top band tops out at (n-1)/n. The colour is then rescaled by
  the ratio (lum_q + 1e-6) / (lum + 1e-6), which preserves hue and collapses
  the darkest band to black.
*/
function quantizeLuminance(lum: number, nBands: number): number {
  let d = 0; // np.digitize == searchsorted(bins, lum, side="right")
  for (let k = 0; k <= nBands; k++) if (k / nBands <= lum) d++;
  const idx = Math.min(Math.max(d - 1, 0), nBands - 1);
  return idx / nBands;
}

function celShade(rgb: Float32Array, n: number, nBands: number): Float32Array {
  const lum = luma709(rgb, n);
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const scale = (quantizeLuminance(lum[i], nBands) + 1e-6) / (lum[i] + 1e-6);
    out[i * 3] = clamp01(rgb[i * 3] * scale);
    out[i * 3 + 1] = clamp01(rgb[i * 3 + 1] * scale);
    out[i * 3 + 2] = clamp01(rgb[i * 3 + 2] * scale);
  }
  return out;
}

/*
  cel_shading.ipynb — sobel_outline(). Note the threshold is relative to
  mag.max() over the whole frame, and the notebook runs this on the *cel
  image*, not the baseline, so band terminators get outlined too.
*/
function sobelOutline(
  rgb: Float32Array,
  w: number,
  h: number,
  threshold: number,
): Float32Array {
  const n = w * h;
  const mag = sobelMagnitude(luma601(rgb, n), w, h);
  const cut = threshold * maxOf(mag);
  const out = rgb.slice();
  for (let i = 0; i < n; i++) {
    if (mag[i] > cut) {
      out[i * 3] = 0;
      out[i * 3 + 1] = 0;
      out[i * 3 + 2] = 0;
    }
  }
  return out;
}

/*
  guilty_gear_cel.ipynb — gg_cel(). Two thresholds, three flat palette
  colours, and the base colour discarded entirely. The "rim" is the XOR of
  the shadow mask against its four edge-padded neighbours.
*/
const GG_SHADOW: V3 = [0.05, 0.05, 0.1];
const GG_MID: V3 = [0.6, 0.6, 0.9];
const GG_HIGHLIGHT: V3 = [1.0, 0.95, 0.8];
const GG_RIM: V3 = [0.3, 0.3, 0.6];

function ggCel(
  rgb: Float32Array,
  w: number,
  h: number,
  tShadow: number,
  tMid: number,
  rimStrength: number,
): Float32Array {
  const n = w * h;
  const lum = luma709(rgb, n);
  const out = new Float32Array(n * 3);
  const shadow = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = lum[i] < tShadow ? GG_SHADOW : lum[i] < tMid ? GG_MID : GG_HIGHLIGHT;
    if (lum[i] < tShadow) shadow[i] = 1;
    out[i * 3] = c[0];
    out[i * 3 + 1] = c[1];
    out[i * 3 + 2] = c[2];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const s = shadow[i];
      const rim =
        s !== shadow[Math.max(y - 1, 0) * w + x] ||
        s !== shadow[Math.min(y + 1, h - 1) * w + x] ||
        s !== shadow[y * w + Math.max(x - 1, 0)] ||
        s !== shadow[y * w + Math.min(x + 1, w - 1)];
      if (rim) {
        out[i * 3] = clamp01(out[i * 3] + rimStrength * GG_RIM[0]);
        out[i * 3 + 1] = clamp01(out[i * 3 + 1] + rimStrength * GG_RIM[1]);
        out[i * 3 + 2] = clamp01(out[i * 3 + 2] + rimStrength * GG_RIM[2]);
      }
    }
  }
  return out;
}

/*
  halftone.ipynb — halftone(). Dot radius max_r * (1 - gray) about the centre
  of each cell_size×cell_size cell; pure black on pure white.
*/
function halftone(rgb: Float32Array, w: number, h: number, cell: number): Float32Array {
  const n = w * h;
  const gray = luma601(rgb, n);
  const out = new Float32Array(n * 3).fill(1);
  const maxR = cell * 0.5;
  for (let y = 0; y < h; y++) {
    const yc = Math.floor(y / cell) * cell + cell / 2;
    for (let x = 0; x < w; x++) {
      const xc = Math.floor(x / cell) * cell + cell / 2;
      const i = y * w + x;
      const dist = Math.hypot(y - yc, x - xc);
      if (dist <= maxR * (1 - gray[i])) {
        out[i * 3] = 0;
        out[i * 3 + 1] = 0;
        out[i * 3 + 2] = 0;
      }
    }
  }
  return out;
}

/*
  stippling.ipynb — stipple(). n = int(max_points * (1 - mean intensity))
  single black pixels scattered inside each cell.
*/
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stipple(
  rgb: Float32Array,
  w: number,
  h: number,
  cell: number,
  maxPoints: number,
): Float32Array {
  const n = w * h;
  const gray = luma601(rgb, n);
  const out = new Float32Array(n * 3).fill(1);
  const rand = mulberry32(0); // stands in for np.random.default_rng(0)
  for (let cy = 0; cy < h; cy += cell) {
    for (let cx = 0; cx < w; cx += cell) {
      const yEnd = Math.min(cy + cell, h);
      const xEnd = Math.min(cx + cell, w);
      let sum = 0;
      let count = 0;
      for (let y = cy; y < yEnd; y++) {
        for (let x = cx; x < xEnd; x++) {
          sum += gray[y * w + x];
          count++;
        }
      }
      if (count === 0) continue;
      const pts = Math.trunc(maxPoints * (1 - sum / count));
      for (let k = 0; k < pts; k++) {
        const ry = cy + Math.floor(rand() * (yEnd - cy));
        const rx = cx + Math.floor(rand() * (xEnd - cx));
        const i = ry * w + rx;
        out[i * 3] = 0;
        out[i * 3 + 1] = 0;
        out[i * 3 + 2] = 0;
      }
    }
  }
  return out;
}

/*
  kuwahara_filter.ipynb — kuwahara(). Four overlapping quadrants of the
  (2r+1) window; the pixel takes the mean of whichever quadrant has the
  lowest variance. Variance is taken across position *and* channel, exactly
  as ((q - mean) ** 2).mean() does.
*/
function kuwahara(rgb: Float32Array, w: number, h: number, radius: number): Float32Array {
  const out = new Float32Array(w * h * 3);
  const quads: [number, number, number, number][] = [
    [-radius, 0, -radius, 0],
    [-radius, 0, 0, radius],
    [0, radius, -radius, 0],
    [0, radius, 0, radius],
  ];
  const mean: V3 = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let bestVar = 1e9;
      let bestR = 0;
      let bestG = 0;
      let bestB = 0;
      for (const [dy0, dy1, dx0, dx1] of quads) {
        mean[0] = 0;
        mean[1] = 0;
        mean[2] = 0;
        let count = 0;
        for (let dy = dy0; dy <= dy1; dy++) {
          const sy = mirrorIdx(y + dy, h) * w;
          for (let dx = dx0; dx <= dx1; dx++) {
            const j = (sy + mirrorIdx(x + dx, w)) * 3;
            mean[0] += rgb[j];
            mean[1] += rgb[j + 1];
            mean[2] += rgb[j + 2];
            count++;
          }
        }
        mean[0] /= count;
        mean[1] /= count;
        mean[2] /= count;
        let variance = 0;
        for (let dy = dy0; dy <= dy1; dy++) {
          const sy = mirrorIdx(y + dy, h) * w;
          for (let dx = dx0; dx <= dx1; dx++) {
            const j = (sy + mirrorIdx(x + dx, w)) * 3;
            const a = rgb[j] - mean[0];
            const b = rgb[j + 1] - mean[1];
            const c = rgb[j + 2] - mean[2];
            variance += a * a + b * b + c * c;
          }
        }
        variance /= count * 3;
        if (variance < bestVar) {
          bestVar = variance;
          bestR = mean[0];
          bestG = mean[1];
          bestB = mean[2];
        }
      }
      const i = (y * w + x) * 3;
      out[i] = bestR;
      out[i + 1] = bestG;
      out[i + 2] = bestB;
    }
  }
  return out;
}

/* gooch_shading.ipynb — gooch(). A straight lerp along Rec. 709 luminance. */
const GOOCH_COOL: V3 = [0.0, 0.0, 0.6];
const GOOCH_WARM: V3 = [0.9, 0.9, 0.0];

function gooch(rgb: Float32Array, n: number): Float32Array {
  const lum = luma709(rgb, n);
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = clamp01(lum[i]);
    out[i * 3] = (1 - t) * GOOCH_COOL[0] + t * GOOCH_WARM[0];
    out[i * 3 + 1] = (1 - t) * GOOCH_COOL[1] + t * GOOCH_WARM[1];
    out[i * 3 + 2] = (1 - t) * GOOCH_COOL[2] + t * GOOCH_WARM[2];
  }
  return out;
}

/* scipy.ndimage.gaussian_filter1d — truncate=4.0, mode="reflect". */
function gaussianBlur(rgb: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return rgb.slice();
  const lw = Math.trunc(4.0 * sigma + 0.5);
  const weights = new Float64Array(2 * lw + 1);
  let total = 0;
  for (let i = -lw; i <= lw; i++) {
    const v = Math.exp((-0.5 * i * i) / (sigma * sigma));
    weights[i + lw] = v;
    total += v;
  }
  for (let i = 0; i < weights.length; i++) weights[i] /= total;

  const tmp = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = -lw; k <= lw; k++) {
        const j = (y * w + symIdx(x + k, w)) * 3;
        const wt = weights[k + lw];
        r += wt * rgb[j];
        g += wt * rgb[j + 1];
        b += wt * rgb[j + 2];
      }
      const i = (y * w + x) * 3;
      tmp[i] = r;
      tmp[i + 1] = g;
      tmp[i + 2] = b;
    }
  }
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = -lw; k <= lw; k++) {
        const j = (symIdx(y + k, h) * w + x) * 3;
        const wt = weights[k + lw];
        r += wt * tmp[j];
        g += wt * tmp[j + 1];
        b += wt * tmp[j + 2];
      }
      const i = (y * w + x) * 3;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
    }
  }
  return out;
}

/* watercolor.ipynb — watercolor(). Blur, then multiply by 1 - strength·|∇|. */
function watercolor(
  rgb: Float32Array,
  w: number,
  h: number,
  sigma: number,
  edgeStrength: number,
): Float32Array {
  const n = w * h;
  const blurred = gaussianBlur(rgb, w, h, sigma);
  const mag = sobelMagnitude(luma601(rgb, n), w, h);
  const peak = maxOf(mag) + 1e-6;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const mask = clamp01(1 - edgeStrength * (mag[i] / peak));
    out[i * 3] = clamp01(blurred[i * 3] * mask);
    out[i * 3 + 1] = clamp01(blurred[i * 3 + 1] * mask);
    out[i * 3 + 2] = clamp01(blurred[i * 3 + 2] * mask);
  }
  return out;
}

/*
  curvature_shading.ipynb — curvature_shade(). scipy.ndimage.laplace of the
  luma, min-max normalized across the frame, then a blue→orange ramp.
*/
const CURV_BLUE: V3 = [0.0, 0.2, 0.8];
const CURV_ORANGE: V3 = [1.0, 0.6, 0.1];

function curvatureShade(rgb: Float32Array, w: number, h: number): Float32Array {
  const n = w * h;
  const gray = luma601(rgb, n);
  const curv = new Float32Array(n);
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v =
        gray[y * w + symIdx(x - 1, w)] +
        gray[y * w + symIdx(x + 1, w)] +
        gray[symIdx(y - 1, h) * w + x] +
        gray[symIdx(y + 1, h) * w + x] -
        4 * gray[i];
      curv[i] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = (curv[i] - lo) / (hi - lo + 1e-6);
    out[i * 3] = (1 - t) * CURV_BLUE[0] + t * CURV_ORANGE[0];
    out[i * 3 + 1] = (1 - t) * CURV_BLUE[1] + t * CURV_ORANGE[1];
    out[i * 3 + 2] = (1 - t) * CURV_BLUE[2] + t * CURV_ORANGE[2];
  }
  return out;
}

/* ------------------------------------------------- the stand-in baseline */

const SPHERE_R = 0.9;
const GROUND_Y = -0.95;
const SPHERE_ALBEDO: V3 = [0.74, 0.57, 0.47];
const GROUND_ALBEDO: V3 = [0.58, 0.6, 0.66];
const SKY_TOP: V3 = [0.34, 0.42, 0.54];
const SKY_BOTTOM: V3 = [0.1, 0.12, 0.15];

/** Deterministic per-pixel hash, so the grain is stable across re-renders. */
function hash01(seed: number): number {
  let t = seed >>> 0;
  t = Math.imul(t ^ (t >>> 15), 0x2c1b3c6d);
  t = Math.imul(t ^ (t >>> 12), 0x297a2d39);
  t ^= t >>> 15;
  return (t >>> 0) / 4294967296;
}

/** ~N(0, 1) from three hashed uniforms. */
function grain(seed: number): number {
  return (hash01(seed) + hash01(seed * 2654435761) + hash01(seed * 40503) - 1.5) * 2;
}

/**
 * A stand-in for the assignment 3 Slang path trace: one sphere, one plane,
 * one light, in linear RGB. Camera matches render.py's defaults, and the
 * surfaces carry relative Monte Carlo variance scaled by 1/sqrt(spp) —
 * because the notebooks are written against spp=8 and spp=16 renders, and
 * kuwahara() and watercolor() have almost nothing to do on a clean image.
 */
function renderBaseline(size: number, lightAngle: number, spp: number): Float32Array {
  const out = new Float32Array(size * size * 3);
  const tanHalf = Math.tan(((FOV * Math.PI) / 180) * 0.5);
  const eye: V3 = [0, 0, CAMERA_DISTANCE];
  const L = normalize([Math.cos(lightAngle) * 1.6, 1.3, Math.sin(lightAngle) * 1.6]);
  const noise = spp > 0 ? 0.28 / Math.sqrt(spp) : 0;

  for (let y = 0; y < size; y++) {
    const sy = 1 - ((y + 0.5) / size) * 2;
    for (let x = 0; x < size; x++) {
      const sx = ((x + 0.5) / size) * 2 - 1;
      const d = normalize([sx * tanHalf, sy * tanHalf, -1]);
      const i = (y * size + x) * 3;

      // Sphere at the origin.
      const b = dot(eye, d);
      const c = dot(eye, eye) - SPHERE_R * SPHERE_R;
      const disc = b * b - c;
      const tSphere = disc > 0 ? -b - Math.sqrt(disc) : -1;
      const tPlane = d[1] < 0 ? (GROUND_Y - eye[1]) / d[1] : -1;

      let col: V3;
      let grainy = true;
      if (tSphere > 0) {
        const p: V3 = [eye[0] + d[0] * tSphere, eye[1] + d[1] * tSphere, eye[2] + d[2] * tSphere];
        const nrm: V3 = [p[0] / SPHERE_R, p[1] / SPHERE_R, p[2] / SPHERE_R];
        const diff = Math.max(dot(nrm, L), 0);
        const H = normalize([L[0] - d[0], L[1] - d[1], L[2] - d[2]]);
        const spec = Math.pow(Math.max(dot(nrm, H), 0), 48) * 0.55;
        const amb = 0.13 * (0.5 + 0.5 * nrm[1]);
        col = [
          SPHERE_ALBEDO[0] * (amb + 0.95 * diff) + spec,
          SPHERE_ALBEDO[1] * (amb + 0.95 * diff) + spec,
          SPHERE_ALBEDO[2] * (amb + 0.95 * diff) + spec,
        ];
      } else if (tPlane > 0 && tPlane < 40) {
        const p: V3 = [eye[0] + d[0] * tPlane, eye[1] + d[1] * tPlane, eye[2] + d[2] * tPlane];
        // Hard shadow ray against the sphere.
        const sb = dot(p, L);
        const sc = dot(p, p) - SPHERE_R * SPHERE_R;
        const shadow = sb * sb - sc > 0 && -sb - Math.sqrt(sb * sb - sc) > 1e-3 ? 0.12 : 1;
        const diff = Math.max(L[1], 0) * shadow;
        const fade = clamp01(1 - (p[2] < -6 ? (-p[2] - 6) / 10 : 0));
        col = [
          GROUND_ALBEDO[0] * (0.12 + 0.8 * diff) * fade,
          GROUND_ALBEDO[1] * (0.12 + 0.8 * diff) * fade,
          GROUND_ALBEDO[2] * (0.12 + 0.8 * diff) * fade,
        ];
      } else {
        // The environment is sampled cleanly, as an env map would be.
        grainy = false;
        const t = clamp01((sy + 1) * 0.5);
        col = [
          SKY_BOTTOM[0] + (SKY_TOP[0] - SKY_BOTTOM[0]) * t,
          SKY_BOTTOM[1] + (SKY_TOP[1] - SKY_BOTTOM[1]) * t,
          SKY_BOTTOM[2] + (SKY_TOP[2] - SKY_BOTTOM[2]) * t,
        ];
      }

      for (let c = 0; c < 3; c++) {
        const g = grainy && noise > 0 ? 1 + grain((y * size + x) * 3 + c + spp * 7919) * noise : 1;
        out[i + c] = clamp01(col[c] * g);
      }
    }
  }
  return out;
}

/* ----------------------------------------------------------------- styles */

type StyleId =
  | "cel"
  | "gg"
  | "halftone"
  | "kuwahara"
  | "gooch"
  | "watercolor"
  | "stipple"
  | "curvature";

type StyleMeta = {
  id: StyleId;
  label: string;
  file: string;
  call: string;
  /** The notebooks gamma-correct with ** (1/2.2) before imshow — except the
   *  two that output pure black on white, which they show raw. */
  gamma: boolean;
  blurb: string;
};

const STYLES: StyleMeta[] = [
  {
    id: "cel",
    label: "cel + Sobel",
    file: "cel_shading.ipynb",
    call: "sobel_outline(cel_shade(rgb, n_bands=4), threshold=0.2)",
    gamma: true,
    blurb:
      "Quantize Rec. 709 luminance into n bands, rescale RGB by the ratio, then run a Sobel over the result and paint every strong gradient black.",
  },
  {
    id: "gg",
    label: "guilty gear",
    file: "guilty_gear_cel.ipynb",
    call: "gg_cel(rgb, t_shadow=0.2, t_mid=0.6, rim_strength=0.5)",
    gamma: true,
    blurb:
      "Two thresholds, three flat palette colours, base colour discarded. The rim is the XOR of the shadow mask against its four neighbours — an outline made of set arithmetic, not geometry.",
  },
  {
    id: "halftone",
    label: "halftone",
    file: "halftone.ipynb",
    call: "halftone(rgb, cell_size=8)",
    gamma: false,
    blurb:
      "One dot per cell, radius cell_size/2 × (1 − gray). Darker means bigger. Output is pure black on pure white, so the notebook skips the gamma step on display.",
  },
  {
    id: "kuwahara",
    label: "kuwahara",
    file: "kuwahara_filter.ipynb",
    call: "kuwahara(rgb, radius=3)",
    gamma: true,
    blurb:
      "Each pixel takes the mean of whichever of the four overlapping window quadrants has the lowest variance. Flattens interiors, keeps edges crisp — the oil-paint look.",
  },
  {
    id: "gooch",
    label: "gooch",
    file: "gooch_shading.ipynb",
    call: "gooch(rgb, cool=(0,0,0.6), warm=(0.9,0.9,0))",
    gamma: true,
    blurb:
      "No quantization at all: luminance drives a straight lerp from cool to warm, so the whole tonal range survives as a hue shift instead of a brightness one.",
  },
  {
    id: "watercolor",
    label: "watercolor",
    file: "watercolor.ipynb",
    call: "watercolor(rgb, blur_sigma=2.0, edge_strength=0.8)",
    gamma: true,
    blurb:
      "Gaussian blur, then multiply by 1 − edge_strength × normalized |∇|. Soft washes with darkened boundaries, the way pigment pools at the edge of a stroke.",
  },
  {
    id: "stipple",
    label: "stippling",
    file: "stippling.ipynb",
    call: "stipple(rgb, cell_size=6, max_points=5)",
    gamma: false,
    blurb:
      "int(max_points × (1 − mean intensity)) single black pixels scattered per cell. Tone becomes density — five discrete grey levels, whatever the input.",
  },
  {
    id: "curvature",
    label: "curvature",
    file: "curvature_shading.ipynb",
    call: "curvature_shade(rgb)",
    gamma: true,
    blurb:
      "Laplacian of the luma, min-max normalized across the frame, mapped to a blue→orange ramp. The normalization keys off the silhouette outliers, so the interior compresses into the middle of the ramp — faithful to the notebook, and the reason this one stays the weakest of the eight.",
  },
];

const DEFAULTS = {
  celBands: 4,
  celThreshold: 0.2,
  ggShadow: 0.2,
  ggMid: 0.6,
  ggRim: 0.5,
  halftoneCell: 8,
  kuwaharaRadius: 3,
  stippleCell: 6,
  stipplePoints: 5,
  wcSigma: 2.0,
  wcEdge: 0.8,
};

type Params = typeof DEFAULTS;

function stylize(
  base: Float32Array,
  w: number,
  h: number,
  style: StyleId,
  p: Params,
  outline: boolean,
): Float32Array {
  const n = w * h;
  switch (style) {
    case "cel": {
      const cel = celShade(base, n, p.celBands);
      return outline ? sobelOutline(cel, w, h, p.celThreshold) : cel;
    }
    case "gg":
      return ggCel(base, w, h, p.ggShadow, p.ggMid, p.ggRim);
    case "halftone":
      return halftone(base, w, h, p.halftoneCell);
    case "kuwahara":
      return kuwahara(base, w, h, p.kuwaharaRadius);
    case "gooch":
      return gooch(base, n);
    case "watercolor":
      return watercolor(base, w, h, p.wcSigma, p.wcEdge);
    case "stipple":
      return stipple(base, w, h, p.stippleCell, p.stipplePoints);
    case "curvature":
      return curvatureShade(base, w, h);
  }
}

/** Linear float RGB → 8-bit, with the notebooks' `** (1/2.2)` if requested. */
function toImageData(rgb: Float32Array, w: number, h: number, gamma: boolean): ImageData {
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) {
      const v = clamp01(rgb[i * 3 + c]);
      img.data[i * 4 + c] = Math.round((gamma ? Math.pow(v, 1 / 2.2) : v) * 255);
    }
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

/* -------------------------------------------------------------- component */

export function StylizedShading() {
  const baseCanvas = useRef<HTMLCanvasElement | null>(null);
  const outCanvas = useRef<HTMLCanvasElement | null>(null);
  const [style, setStyle] = useState<StyleId>("cel");
  const [p, setP] = useState<Params>(DEFAULTS);
  const [outline, setOutline] = useState(true);
  const [lightAngle, setLightAngle] = useState(0.9);
  const [spp, setSpp] = useState(16);

  const baseline = useMemo(
    () => renderBaseline(SIZE, lightAngle, spp),
    [lightAngle, spp],
  );
  const meta = STYLES.find((s) => s.id === style) ?? STYLES[0];

  useEffect(() => {
    const ctx = baseCanvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(toImageData(baseline, SIZE, SIZE, true), 0, 0);
  }, [baseline]);

  useEffect(() => {
    const ctx = outCanvas.current?.getContext("2d");
    if (!ctx) return;
    const styled = stylize(baseline, SIZE, SIZE, style, p, outline);
    ctx.putImageData(toImageData(styled, SIZE, SIZE, meta.gamma), 0, 0);
  }, [baseline, style, p, outline, meta.gamma]);

  const set = <K extends keyof Params>(k: K, v: number) =>
    setP((prev) => ({ ...prev, [k]: v }));

  return (
    <section className="mt-10 rounded border border-hair bg-raised">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hair px-4 py-3">
        <h2 className="font-prose text-base font-semibold text-bright">
          Stylized renderer — eight passes
        </h2>
        <p className="font-mono text-xs text-dim">ported from cs248a-asst4/notebooks</p>
      </header>

      <div className="px-4 py-4">
        <p className="max-w-[62ch] text-sm text-muted">
          None of this is a shader. Assignment 3 path-traces the frame; assignment 4
          takes the finished linear-RGB buffer and stylizes it in image space with
          numpy and <span className="font-mono text-xs text-body">scipy.ndimage</span>.
          The band edges therefore land on <em>luminance</em>, not on N·L — and the
          outlines come from a Sobel over the already-quantized image rather than from
          geometry.
        </p>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {STYLES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setStyle(s.id)}
              aria-pressed={style === s.id}
              className={`rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors ${
                style === s.id
                  ? "border-accent text-accent"
                  : "border-hair text-dim hover:border-muted hover:text-body"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-4">
          <figure className="flex flex-col gap-1.5">
            <canvas
              ref={baseCanvas}
              width={SIZE}
              height={SIZE}
              className="rounded bg-sunken"
              style={{ width: SIZE, height: SIZE, imageRendering: "pixelated" }}
              role="img"
              aria-label="The unstylized baseline frame"
            />
            <figcaption className="font-mono text-[10px] leading-snug text-faint">
              base_rgb — stand-in for the asst3 path trace, spp={spp || "∞"}
            </figcaption>
          </figure>
          <figure className="flex flex-col gap-1.5">
            <canvas
              ref={outCanvas}
              width={SIZE}
              height={SIZE}
              className="rounded bg-sunken"
              style={{ width: SIZE, height: SIZE, imageRendering: "pixelated" }}
              role="img"
              aria-label={`The baseline frame after the ${meta.label} pass`}
            />
            <figcaption className="font-mono text-[10px] leading-snug text-faint">
              {meta.file}
              {meta.gamma ? " — shown ** (1/2.2)" : " — shown raw, no gamma"}
            </figcaption>
          </figure>
        </div>

        <div className="mt-4 scroll-x">
          <code className="block whitespace-nowrap rounded-sm bg-sunken px-3 py-2 font-mono text-xs text-note">
            {meta.call}
          </code>
        </div>
        <p className="mt-2 max-w-[62ch] text-sm text-muted">{meta.blurb}</p>

        <div className="mt-5 grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {style === "cel" && (
            <>
              <Slider
                label="n_bands"
                value={p.celBands}
                min={2}
                max={8}
                step={1}
                onChange={(v) => set("celBands", v)}
                hint="linspace(0, 1, n+1) bin edges"
              />
              <Slider
                label="threshold"
                value={p.celThreshold}
                min={0.02}
                max={0.9}
                step={0.01}
                onChange={(v) => set("celThreshold", v)}
                hint="fraction of mag.max(), frame-wide"
              />
            </>
          )}
          {style === "gg" && (
            <>
              <Slider
                label="t_shadow"
                value={p.ggShadow}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => set("ggShadow", v)}
                hint="lum below this → shadow_color"
              />
              <Slider
                label="t_mid"
                value={p.ggMid}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => set("ggMid", v)}
                hint="above this → highlight_color"
              />
              <Slider
                label="rim_strength"
                value={p.ggRim}
                min={0}
                max={1.5}
                step={0.05}
                onChange={(v) => set("ggRim", v)}
                hint="added along the shadow-mask XOR"
              />
              <Swatches
                caption="palette — the base colour never survives"
                items={[
                  ["shadow_color", GG_SHADOW],
                  ["mid_color", GG_MID],
                  ["highlight_color", GG_HIGHLIGHT],
                  ["rim_color", GG_RIM],
                ]}
              />
            </>
          )}
          {style === "halftone" && (
            <Slider
              label="cell_size"
              value={p.halftoneCell}
              min={2}
              max={20}
              step={1}
              onChange={(v) => set("halftoneCell", v)}
              hint="px; max dot radius is half of it"
            />
          )}
          {style === "kuwahara" && (
            <Slider
              label="radius"
              value={p.kuwaharaRadius}
              min={1}
              max={5}
              step={1}
              onChange={(v) => set("kuwaharaRadius", v)}
              hint="window is 2r+1; cost is O(r²) per px"
            />
          )}
          {style === "stipple" && (
            <>
              <Slider
                label="cell_size"
                value={p.stippleCell}
                min={2}
                max={16}
                step={1}
                onChange={(v) => set("stippleCell", v)}
                hint="px per tone sample"
              />
              <Slider
                label="max_points"
                value={p.stipplePoints}
                min={1}
                max={12}
                step={1}
                onChange={(v) => set("stipplePoints", v)}
                hint="dots at full black; tone has this many levels"
              />
            </>
          )}
          {style === "watercolor" && (
            <>
              <Slider
                label="blur_sigma"
                value={p.wcSigma}
                min={0}
                max={6}
                step={0.1}
                onChange={(v) => set("wcSigma", v)}
                hint="gaussian_filter, truncate=4.0"
              />
              <Slider
                label="edge_strength"
                value={p.wcEdge}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => set("wcEdge", v)}
                hint="darkening along normalized |∇|"
              />
            </>
          )}
          {style === "gooch" && (
            <Swatches
              caption="gooch() takes these as arguments; these are its defaults"
              items={[
                ["cool", GOOCH_COOL],
                ["warm", GOOCH_WARM],
              ]}
            />
          )}
          {style === "curvature" && (
            <Swatches
              caption="the ramp is hard-coded; there are no tunable arguments"
              items={[
                ["blue", CURV_BLUE],
                ["orange", CURV_ORANGE],
              ]}
            />
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {style === "cel" && (
            <button
              type="button"
              onClick={() => setOutline((o) => !o)}
              className="rounded-sm border border-hair px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:border-muted hover:text-body"
            >
              {outline ? "drop sobel_outline" : "apply sobel_outline"}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setP(DEFAULTS);
              setOutline(true);
            }}
            className="rounded-sm border border-hair px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:border-muted hover:text-body"
          >
            reset to notebook defaults
          </button>
        </div>

        {style === "cel" && <BandStrip bands={p.celBands} />}

        <div className="mt-5 rounded-sm border border-hair-soft bg-sunken px-3 py-3">
          <p className="font-mono text-[11px] uppercase tracking-wide text-faint">
            where this diverges from the Toon.shader port
          </p>
          <ul className="mt-2 flex flex-col gap-2 text-sm text-muted">
            <li>
              <span className="text-body">Bands quantize to the bin&rsquo;s lower edge.</span>{" "}
              <span className="font-mono text-xs text-note">bins[idx]</span> is the floor of
              the bin, so band 0 becomes exactly 0.0 and the whole darkest band collapses to
              black — while the top band never exceeds{" "}
              <span className="font-mono text-xs tabular-nums text-note">
                {((p.celBands - 1) / p.celBands).toFixed(3)}
              </span>
              , dimming every highlight. The Unity shader smoothsteps across each edge and
              normalizes back to 1.0 instead, so it never clips either end.
            </li>
            <li>
              <span className="text-body">The outline is a filter, not a hull.</span> Toon.shader
              extrudes a second, larger silhouette. Here the Sobel runs over the{" "}
              <em>cel-shaded</em> image with a threshold relative to the frame&rsquo;s own{" "}
              <span className="font-mono text-xs text-note">mag.max()</span> — so band
              terminators get inked as heavily as the silhouette, and changing the light
              changes which edges qualify.
            </li>
            <li>
              <span className="text-body">Two different luma weightings, one repo.</span>{" "}
              <span className="font-mono text-xs text-note">cel_shade</span> and{" "}
              <span className="font-mono text-xs text-note">gooch</span> use Rec. 709
              (0.2126 / 0.7152 / 0.0722); the Sobel, halftone, stipple, watercolor and
              curvature passes use Rec. 601 (0.299 / 0.587 / 0.114). That inconsistency is in
              the notebooks and is reproduced rather than tidied up.
            </li>
            <li>
              <span className="text-body">Thresholds sit in linear light.</span> The buffer
              coming out of the renderer is linear and only gets{" "}
              <span className="font-mono text-xs text-note">** (1/2.2)</span> at{" "}
              <span className="font-mono text-xs text-note">imshow</span> time, so a
              t_shadow of 0.2 is far darker than it looks on screen.
            </li>
          </ul>
        </div>

        <div className="mt-5 flex flex-col gap-3 border-t border-hair-soft pt-4">
          <p className="font-mono text-[11px] uppercase tracking-wide text-faint">
            the input frame — stand-in, not ported
          </p>
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Slider
              label="light θ"
              value={lightAngle}
              min={-1.6}
              max={2.4}
              step={0.02}
              onChange={setLightAngle}
              hint="moves the terminator through the thresholds"
            />
            <div className="flex flex-col gap-1">
              <span className="font-mono text-xs text-dim">spp</span>
              <div className="flex flex-wrap gap-1.5">
                {[8, 16, 64, 0].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setSpp(v)}
                    aria-pressed={spp === v}
                    className={`rounded-sm border px-2 py-0.5 font-mono text-xs tabular-nums transition-colors ${
                      spp === v
                        ? "border-accent text-accent"
                        : "border-hair text-dim hover:border-muted hover:text-body"
                    }`}
                  >
                    {v === 0 ? "∞" : v}
                  </button>
                ))}
              </div>
              <span className="font-mono text-[10px] text-faint">
                grain ∝ 1/√spp — the notebooks render at 8 and 16
              </span>
            </div>
          </div>
          <p className="max-w-[62ch] font-mono text-[11px] leading-relaxed text-faint">
            The assignment 3 Slang path tracer and its .obj meshes cannot ship to a static
            page, so the input frame is a small CPU ray trace of a sphere on a plane using
            render.py&rsquo;s own camera (distance {CAMERA_DISTANCE.toFixed(1)}, fov{" "}
            {FOV.toFixed(0)}) with synthetic Monte Carlo variance standing in for real
            sampling — set spp to ∞ and{" "}
            <span className="text-note">kuwahara</span> and{" "}
            <span className="text-note">watercolor</span> have almost nothing left to do,
            which is itself the point of them. Everything downstream of{" "}
            <span className="text-note">base_rgb</span> is the notebooks&rsquo; arithmetic at{" "}
            {SIZE}×{SIZE} instead of 512×512, so the pixel-space parameters — cell_size,
            radius, sigma — cover more of the frame here than they do there.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- pieces */

function BandStrip({ bands }: { bands: number }) {
  const cells = 56;
  return (
    <div className="mt-4">
      <p className="font-mono text-[11px] text-faint">
        luminance transfer — input ramp above, bins[idx] below
      </p>
      <div className="mt-1.5 flex h-4 w-full overflow-hidden rounded-sm">
        {Array.from({ length: cells }, (_, i) => {
          const v = Math.pow(i / (cells - 1), 1 / 2.2) * 255;
          return (
            <span
              key={i}
              className="flex-1"
              style={{ background: `rgb(${v},${v},${v})` }}
            />
          );
        })}
      </div>
      <div className="mt-0.5 flex h-4 w-full overflow-hidden rounded-sm">
        {Array.from({ length: cells }, (_, i) => {
          const q = quantizeLuminance(i / (cells - 1), bands);
          const v = Math.pow(q, 1 / 2.2) * 255;
          return (
            <span
              key={i}
              className="flex-1"
              style={{ background: `rgb(${v},${v},${v})` }}
            />
          );
        })}
      </div>
      <p className="mt-1.5 font-mono text-[11px] tabular-nums text-dim">
        lum_q ∈ {"{"}
        {Array.from({ length: bands }, (_, k) => (k / bands).toFixed(3)).join(", ")}
        {"}"}
      </p>
    </div>
  );
}

function Swatches({
  caption,
  items,
}: {
  caption: string;
  items: [string, V3][];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-xs text-dim">{caption}</span>
      <div className="flex flex-col gap-1">
        {items.map(([name, c]) => (
          <span key={name} className="flex items-center gap-2 font-mono text-[11px]">
            <span
              className="h-3.5 w-6 shrink-0 rounded-[2px] border border-hair"
              style={{
                background: `rgb(${c.map((v) => Math.round(Math.pow(v, 1 / 2.2) * 255)).join(",")})`,
              }}
            />
            <span className="text-dim">{name}</span>
            <span className="tabular-nums text-faint">
              ({c.map((v) => v.toFixed(2)).join(", ")})
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between gap-3 font-mono text-xs">
        <span className="text-dim">{label}</span>
        <span className="tabular-nums text-body">
          {step >= 1 ? value.toFixed(0) : value.toFixed(2)}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-sm bg-sunken accent-[#5fc98d]"
      />
      <span className="font-mono text-[10px] text-faint">{hint}</span>
    </label>
  );
}
