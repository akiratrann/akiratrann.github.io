"use client";

import { useEffect, useRef, useState } from "react";

/*
  The cel-shading from Aetherion's Toon.shader, running on a canvas.

  Banded(), the half-lambert wrap, the fresnel rim and the hard specular step
  are transcribed from Assets/Aetherion/Shaders/Toon.shader — including the
  defaults its Properties block ships with. Ray-marching a sphere on the CPU
  stands in for the GPU rasteriser; the lighting maths is the shader's.

  This is the technique that recurs across the work: the same banding turns up
  in the game, in the CS248A stylized-shading renderer, and in the panel art
  stage of Manhwa Studio.
*/

/** Quantise a 0..1 lighting value into N soft bands. From Toon.shader. */
function banded(value: number, bands: number, softness: number): number {
  const scaled = clamp01(value) * bands;
  const level = Math.floor(scaled);
  const frac = scaled - level;
  const edge = softness * bands;
  const stepped = level + smoothstep(0.5 - edge, 0.5 + edge, frac);
  return clamp01(stepped / bands);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/* Defaults straight from the shader's Properties block. */
const DEFAULTS = {
  bands: 2,
  rampSmooth: 0.03,
  shadowOffset: 0,
  specSize: 0.12,
  specSmooth: 0.02,
  rimPower: 4,
  rimStrength: 0.9,
  outlineWidth: 0.012,
};

const BASE_COLOR: [number, number, number] = [0.82, 0.44, 0.38];
const SHADOW_TINT: [number, number, number] = [0.55, 0.58, 0.72];
const RIM_COLOR: [number, number, number] = [1, 1, 1];
const OUTLINE_COLOR: [number, number, number] = [0.06, 0.05, 0.09];

const SIZE = 260;

export function CelShading() {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [p, setP] = useState(DEFAULTS);
  const [lightAngle, setLightAngle] = useState(-0.6);
  const [spin, setSpin] = useState(true);

  // Light orbits unless the viewer is dragging it or prefers reduced motion.
  useEffect(() => {
    if (!spin) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let last = 0;
    const step = (now: number) => {
      const dt = Math.min((now - (last || now)) / 1000, 0.1);
      last = now;
      setLightAngle((a) => a + dt * 0.55);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [spin]);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = SIZE * dpr;
    cv.height = SIZE * dpr;

    const img = ctx.createImageData(SIZE * dpr, SIZE * dpr);
    const data = img.data;

    // Light direction, orbiting in the XZ plane and tilted up.
    const L: [number, number, number] = normalize([
      Math.cos(lightAngle),
      0.55,
      Math.sin(lightAngle),
    ]);
    const V: [number, number, number] = [0, 0, 1];

    const px = SIZE * dpr;
    const radius = px * 0.36;
    const cx = px / 2;
    const cy = px / 2;
    // Inverted-hull outline: a slightly larger silhouette behind the surface.
    const outlineR = radius * (1 + p.outlineWidth * 6);

    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const dx = (x - cx) / radius;
        const dy = (y - cy) / radius;
        const d2 = dx * dx + dy * dy;
        const i = (y * px + x) * 4;

        const inOutline = (x - cx) ** 2 + (y - cy) ** 2 <= outlineR * outlineR;

        if (d2 > 1) {
          if (inOutline) {
            data[i] = OUTLINE_COLOR[0] * 255;
            data[i + 1] = OUTLINE_COLOR[1] * 255;
            data[i + 2] = OUTLINE_COLOR[2] * 255;
            data[i + 3] = 255;
          } else {
            data[i + 3] = 0;
          }
          continue;
        }

        // Sphere normal at this pixel.
        const nz = Math.sqrt(Math.max(0, 1 - d2));
        const N: [number, number, number] = [dx, -dy, nz];

        // --- banded diffuse (half-lambert keeps back faces readable) ---
        const ndotl = dot(N, L) * 0.5 + 0.5;
        const lit = banded(clamp01(ndotl + p.shadowOffset), p.bands, p.rampSmooth);

        let r = lerp(BASE_COLOR[0] * SHADOW_TINT[0], BASE_COLOR[0], lit);
        let g = lerp(BASE_COLOR[1] * SHADOW_TINT[1], BASE_COLOR[1], lit);
        let b = lerp(BASE_COLOR[2] * SHADOW_TINT[2], BASE_COLOR[2], lit);

        // --- hard specular ---
        const H = normalize([L[0] + V[0], L[1] + V[1], L[2] + V[2]]);
        const ndoth = clamp01(dot(N, H));
        const spec = smoothstep(
          1 - p.specSize - p.specSmooth,
          1 - p.specSize + p.specSmooth,
          ndoth,
        );
        r += spec * lit;
        g += spec * lit;
        b += spec * lit;

        // --- fresnel rim ---
        const fres = Math.pow(clamp01(1 - dot(N, V)), p.rimPower);
        const rim = fres * p.rimStrength * clamp01(ndotl + 0.25);
        r += rim * RIM_COLOR[0];
        g += rim * RIM_COLOR[1];
        b += rim * RIM_COLOR[2];

        data[i] = clamp01(r) * 255;
        data[i + 1] = clamp01(g) * 255;
        data[i + 2] = clamp01(b) * 255;
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [p, lightAngle]);

  const set = <K extends keyof typeof DEFAULTS>(k: K, v: number) =>
    setP((prev) => ({ ...prev, [k]: v }));

  return (
    <section className="mt-10 rounded border border-hair bg-raised">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hair px-4 py-3">
        <h2 className="font-prose text-base font-semibold text-bright">
          Cel shading — playable
        </h2>
        <p className="font-mono text-xs text-dim">ported from Toon.shader</p>
      </header>

      <div className="px-4 py-4">
        <p className="max-w-[60ch] text-sm text-muted">
          The banding function is the shader&rsquo;s:{" "}
          <span className="font-mono text-xs text-body">
            floor(v·bands)
          </span>{" "}
          plus a smoothstep across each edge. Drop the band count to 2 and the
          surface splits into lit and shadow with one soft terminator — the
          whole look comes from that one quantisation.
        </p>

        <div className="mt-4 grid gap-5 sm:grid-cols-[auto_1fr]">
          <div className="flex flex-col gap-2">
            <canvas
              ref={canvas}
              width={SIZE}
              height={SIZE}
              className="rounded bg-sunken"
              style={{ width: SIZE, height: SIZE }}
              aria-label="A sphere rendered with the game's cel shader"
              role="img"
            />
            <button
              type="button"
              onClick={() => setSpin((s) => !s)}
              className="rounded-sm border border-hair px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:border-muted hover:text-body"
            >
              {spin ? "pause light" : "orbit light"}
            </button>
          </div>

          <div className="flex flex-col gap-3">
            <Slider
              label="_Bands"
              value={p.bands}
              min={1}
              max={6}
              step={1}
              onChange={(v) => set("bands", v)}
              hint="light bands"
            />
            <Slider
              label="_RampSmooth"
              value={p.rampSmooth}
              min={0.001}
              max={0.4}
              step={0.001}
              onChange={(v) => set("rampSmooth", v)}
              hint="band softness"
            />
            <Slider
              label="_ShadowOffset"
              value={p.shadowOffset}
              min={-1}
              max={1}
              step={0.01}
              onChange={(v) => set("shadowOffset", v)}
              hint="terminator threshold"
            />
            <Slider
              label="_SpecSize"
              value={p.specSize}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => set("specSize", v)}
              hint="specular size"
            />
            <Slider
              label="_RimPower"
              value={p.rimPower}
              min={0.5}
              max={12}
              step={0.1}
              onChange={(v) => set("rimPower", v)}
              hint="fresnel falloff"
            />
            <Slider
              label="_RimStrength"
              value={p.rimStrength}
              min={0}
              max={3}
              step={0.05}
              onChange={(v) => set("rimStrength", v)}
              hint="rim intensity"
            />
            <Slider
              label="_OutlineWidth"
              value={p.outlineWidth}
              min={0}
              max={0.05}
              step={0.001}
              onChange={(v) => set("outlineWidth", v)}
              hint="inverted hull"
            />
            <button
              type="button"
              onClick={() => setP(DEFAULTS)}
              className="mt-1 self-start rounded-sm border border-hair px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:border-muted hover:text-body"
            >
              reset to shader defaults
            </button>
          </div>
        </div>
      </div>
    </section>
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
          {step >= 1 ? value.toFixed(0) : value.toFixed(3)}
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

function dot(a: [number, number, number], b: [number, number, number]) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v: [number, number, number]): [number, number, number] {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
