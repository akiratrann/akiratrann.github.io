"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/*
  A faithful browser port of Aetherion's elemental aura model.

  Every constant and the resolution order come from the Unity source —
  Assets/Aetherion/Scripts/Elements/ElementalAura.cs and ReactionTable.cs —
  so the numbers on screen are the numbers the game runs on. This is the
  system itself, not a reimagining of it.

  State is immutable and advanced by pure functions, so the render never
  reads a mutable ref and React can bail out when a frame changes nothing.
*/

const AURA_TAX = 0.8;
const decayRateFor = (units: number) => units / (2.5 * units + 7);
const freezeSecondsFor = (gauge: number) => 1.0 + 1.45 * Math.sqrt(Math.max(gauge, 0));

type El = "Pyro" | "Hydro" | "Electro" | "Cryo" | "Anemo" | "Geo" | "Dendro";

const ELEMENTS: { key: El; color: string }[] = [
  { key: "Pyro", color: "#ff5c33" },
  { key: "Hydro", color: "#3da8ff" },
  { key: "Electro", color: "#b573ff" },
  { key: "Cryo", color: "#99edff" },
  { key: "Anemo", color: "#73edc7" },
  { key: "Geo", color: "#ffca4a" },
  { key: "Dendro", color: "#99e633" },
];

const COLOR = Object.fromEntries(ELEMENTS.map((e) => [e.key, e.color])) as Record<El, string>;

/** Anemo and Geo react and leave; they never form a lasting aura. */
const canFormAura = (e: El) =>
  e === "Pyro" || e === "Hydro" || e === "Electro" || e === "Cryo" || e === "Dendro";

/** ReactionTable.Resolve — what `trigger` does to an existing `aura`. */
function resolve(aura: El, trigger: El): string | null {
  if (aura === trigger) return null;
  const t = trigger;
  switch (aura) {
    case "Pyro":
      return t === "Hydro" ? "Vaporize" : t === "Cryo" ? "Melt"
        : t === "Electro" ? "Overloaded" : t === "Anemo" ? "Swirl"
        : t === "Geo" ? "Crystallize" : t === "Dendro" ? "Burning" : null;
    case "Hydro":
      return t === "Pyro" ? "Vaporize" : t === "Cryo" ? "Frozen"
        : t === "Electro" ? "Electro-Charged" : t === "Anemo" ? "Swirl"
        : t === "Geo" ? "Crystallize" : t === "Dendro" ? "Bloom" : null;
    case "Electro":
      return t === "Pyro" ? "Overloaded" : t === "Hydro" ? "Electro-Charged"
        : t === "Cryo" ? "Superconduct" : t === "Anemo" ? "Swirl"
        : t === "Geo" ? "Crystallize" : t === "Dendro" ? "Quicken" : null;
    case "Cryo":
      return t === "Pyro" ? "Melt" : t === "Hydro" ? "Frozen"
        : t === "Electro" ? "Superconduct" : t === "Anemo" ? "Swirl"
        : t === "Geo" ? "Crystallize" : null;
    case "Dendro":
      // Dendro is immune to Anemo, Geo and Cryo.
      return t === "Pyro" ? "Burning" : t === "Hydro" ? "Bloom"
        : t === "Electro" ? "Quicken" : null;
    default:
      return null;
  }
}

/*
  The asymmetry that makes Hydro auras sticky against Pyro while Cryo auras
  get wiped by it: Pyro onto Hydro eats 0.5 gauge per unit, Hydro onto Pyro
  eats 2.0.
*/
function gaugeCoefficient(reaction: string, trigger: El): number {
  if (reaction === "Vaporize") return trigger === "Pyro" ? 0.5 : 2.0;
  if (reaction === "Melt") return trigger === "Pyro" ? 2.0 : 0.5;
  return 1.0;
}

type Aura = { element: El; gauge: number; decayRate: number; appliedUnits: number };
type LogLine = { id: number; reaction: string; aura: El | "—"; trigger: El };

type Sim = {
  auras: Aura[];
  frozenGauge: number;
  frozenDecayRate: number;
  quickenGauge: number;
  log: LogLine[];
  nextId: number;
};

const freshSim = (): Sim => ({
  auras: [],
  frozenGauge: 0,
  frozenDecayRate: 0,
  quickenGauge: 0,
  log: [],
  nextId: 1,
});

/** ElementalAuraHolder.Update() — returns the same object when nothing moved. */
function tick(s: Sim, dt: number): Sim {
  if (!s.auras.length && s.frozenGauge <= 0 && s.quickenGauge <= 0) return s;

  const auras: Aura[] = [];
  for (const a of s.auras) {
    const gauge = a.gauge - a.decayRate * dt;
    if (gauge > 0.0001) auras.push({ ...a, gauge });
  }

  // The thaw rate was latched when the freeze landed. Recomputing it from the
  // shrinking gauge made freeze decelerate and stretched a 2U/2U to ~23s.
  const frozenGauge = s.frozenGauge > 0 ? Math.max(0, s.frozenGauge - s.frozenDecayRate * dt) : 0;
  const quickenGauge = s.quickenGauge > 0 ? Math.max(0, s.quickenGauge - 0.1 * dt) : 0;

  return { ...s, auras, frozenGauge, quickenGauge };
}

/** ElementalAuraHolder.ApplyElement, step for step. */
function applyElement(prev: Sim, incoming: El, units: number): Sim {
  const s: Sim = {
    ...prev,
    auras: prev.auras.map((a) => ({ ...a })),
  };
  let remaining = units;
  const fired: LogLine[] = [];
  const push = (reaction: string, aura: El | "—") => {
    fired.push({ id: s.nextId++, reaction, aura, trigger: incoming });
  };

  // 1. The frozen shell sits on top of the aura stack and is consumed first.
  if (s.frozenGauge > 0 && remaining > 0) {
    if (incoming === "Pyro" || incoming === "Anemo" || incoming === "Geo") {
      const coeff = incoming === "Pyro" ? 2 : 1;
      const consumed = Math.min(s.frozenGauge, remaining * coeff);
      s.frozenGauge -= consumed;
      remaining -= consumed / coeff;
      push(incoming === "Pyro" ? "Melt" : incoming === "Anemo" ? "Swirl" : "Shattered", "Cryo");
    }
  }

  // 2. Quicken turns the next Dendro/Electro hit additive without eating its gauge.
  if (s.quickenGauge > 0 && remaining > 0) {
    if (incoming === "Dendro" || incoming === "Electro") {
      push(incoming === "Dendro" ? "Spread" : "Aggravate", "Dendro");
      s.quickenGauge = Math.max(0, s.quickenGauge - 0.4);
    }
  }

  // 3. React against each aura, oldest first.
  for (let i = 0; i < s.auras.length && remaining > 0; i++) {
    const aura = s.auras[i];
    const reaction = resolve(aura.element, incoming);
    if (!reaction) continue;

    const coeff = gaugeCoefficient(reaction, incoming);
    const consumedFromAura = Math.min(aura.gauge, remaining * coeff);
    remaining -= consumedFromAura / Math.max(coeff, 0.0001);
    aura.gauge -= consumedFromAura;
    push(reaction, aura.element);

    if (reaction === "Frozen") {
      const g = Math.max(s.frozenGauge, consumedFromAura);
      s.frozenGauge = g;
      s.frozenDecayRate = Math.max(g / freezeSecondsFor(g), 0.0001);
    } else if (reaction === "Quicken") {
      s.quickenGauge = Math.max(s.quickenGauge, consumedFromAura);
    }
  }
  s.auras = s.auras.filter((a) => a.gauge > 0.0001);

  // 4. Surviving gauge becomes, or refreshes, an aura.
  if (remaining > 0 && canFormAura(incoming)) {
    const existing = s.auras.find((a) => a.element === incoming);
    const incomingGauge = remaining * AURA_TAX;
    if (existing) {
      // A weaker application never shortens a stronger aura.
      if (incomingGauge > existing.gauge) {
        existing.gauge = incomingGauge;
        existing.appliedUnits = remaining;
        existing.decayRate = decayRateFor(remaining);
      }
    } else {
      s.auras.push({
        element: incoming,
        gauge: incomingGauge,
        appliedUnits: remaining,
        decayRate: decayRateFor(remaining),
      });
    }
  }

  if (!fired.length) push("—", "—");
  s.log = [...fired.reverse(), ...s.log].slice(0, 7);
  return s;
}

export function ElementalSandbox() {
  const [sim, setSim] = useState<Sim>(freshSim);
  const [units, setUnits] = useState(2);
  const last = useRef(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const step = (now: number) => {
      const dt = Math.min((now - (last.current || now)) / 1000, 0.1);
      last.current = now;
      setSim((s) => tick(s, dt));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, []);

  const apply = useCallback(
    (incoming: El) => setSim((s) => applyElement(s, incoming, units)),
    [units],
  );

  const lifetime = (u: number) => (u * AURA_TAX) / decayRateFor(u);
  const empty = !sim.auras.length && sim.frozenGauge <= 0 && sim.quickenGauge <= 0;

  return (
    <section className="mt-10 rounded border border-hair bg-raised">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hair px-4 py-3">
        <h2 className="font-prose text-base font-semibold text-bright">
          Elemental reactions — playable
        </h2>
        <p className="font-mono text-xs text-dim">ported from ElementalAura.cs</p>
      </header>

      <div className="px-4 py-4">
        <p className="max-w-[60ch] text-sm text-muted">
          Hit the target with an element. Auras decay in real time at{" "}
          <span className="font-mono text-xs text-body">U / (2.5U + 7)</span> units per
          second, so a 1U application lives {lifetime(1).toFixed(1)}s and 4U lives{" "}
          {lifetime(4).toFixed(1)}s. Land Hydro then Cryo to freeze, then Pyro to melt
          the shell.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="font-mono text-xs text-faint">gauge units</span>
          <div className="flex gap-1" role="group" aria-label="Application size">
            {[1, 2, 4].map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => setUnits(u)}
                aria-pressed={units === u}
                className={`rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors ${
                  units === u
                    ? "border-accent text-accent"
                    : "border-hair text-dim hover:border-muted hover:text-body"
                }`}
              >
                {u}U
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setSim(freshSim())}
            className="ml-auto rounded-sm border border-hair px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:border-muted hover:text-body"
          >
            reset
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {ELEMENTS.map((e) => (
            <button
              key={e.key}
              type="button"
              onClick={() => apply(e.key)}
              className="rounded-sm border px-3 py-1.5 font-mono text-xs transition-all hover:brightness-125"
              style={{ borderColor: e.color, color: e.color }}
            >
              {e.key}
            </button>
          ))}
        </div>

        <div className="mt-5 grid gap-5 sm:grid-cols-[1fr_14rem]">
          <div>
            <p className="font-mono text-xs text-faint">auras on target</p>
            <div className="mt-2 flex flex-col gap-2">
              {sim.frozenGauge > 0 && (
                <Bar
                  label="Frozen"
                  detail={`thaws in ${(sim.frozenGauge / sim.frozenDecayRate).toFixed(1)}s`}
                  value={sim.frozenGauge}
                  max={Math.max(sim.frozenGauge, 4 * AURA_TAX)}
                  color="#cbefff"
                />
              )}
              {sim.quickenGauge > 0 && (
                <Bar
                  label="Quicken"
                  detail="additive"
                  value={sim.quickenGauge}
                  max={Math.max(sim.quickenGauge, 4 * AURA_TAX)}
                  color="#99e633"
                />
              )}
              {sim.auras.map((a) => (
                <Bar
                  key={a.element}
                  label={a.element}
                  detail={`${a.gauge.toFixed(2)}U · −${a.decayRate.toFixed(3)}/s`}
                  value={a.gauge}
                  max={a.appliedUnits * AURA_TAX}
                  color={COLOR[a.element]}
                />
              ))}
              {empty && <p className="font-mono text-xs text-faint">clean — no aura</p>}
            </div>
          </div>

          <div>
            <p className="font-mono text-xs text-faint">reactions</p>
            <ol className="mt-2 flex flex-col gap-1">
              {sim.log.length === 0 && (
                <li className="font-mono text-xs text-faint">none yet</li>
              )}
              {sim.log.map((l) => (
                <li key={l.id} className="font-mono text-xs">
                  {l.reaction === "—" ? (
                    <span className="text-faint">{l.trigger} applied, no reaction</span>
                  ) : (
                    <>
                      <span style={{ color: COLOR[l.trigger] }}>{l.trigger}</span>
                      <span className="text-faint"> on </span>
                      <span className="text-dim">{l.aura}</span>
                      <span className="text-faint"> → </span>
                      <span className="text-bright">{l.reaction}</span>
                    </>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

function Bar({
  label,
  detail,
  value,
  max,
  color,
}: {
  label: string;
  detail: string;
  value: number;
  max: number;
  color: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / Math.max(max, 0.0001)) * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 font-mono text-xs">
        <span style={{ color }}>{label}</span>
        <span className="text-faint">{detail}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-sm bg-sunken">
        <div className="h-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}
