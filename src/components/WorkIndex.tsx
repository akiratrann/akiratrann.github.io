"use client";

import { useMemo, useState } from "react";
import { EntryRow } from "@/components/Entry";
import type { Entry, Form } from "@/content/work";

/*
  The index is the page people actually poke around in, so it filters rather
  than making you scroll sixteen entries hunting for the one you want.

  Filters are additive within a row and intersect across rows. Counts are live,
  and a filter that would return nothing is disabled rather than letting you
  walk into an empty list.
*/

type Props = {
  entries: Entry[];
  forms: { key: Form; title: string; note: string }[];
  recurring: [string, number][];
};

type Lens = "all" | "playable" | "source";

const LENSES: { key: Lens; label: string; hint: string }[] = [
  { key: "all", label: "everything", hint: "every entry" },
  { key: "playable", label: "playable", hint: "has a demo you can use" },
  { key: "source", label: "has source", hint: "public repository" },
];

export function WorkIndex({ entries, forms, recurring }: Props) {
  const [form, setForm] = useState<Form | "all">("all");
  const [lens, setLens] = useState<Lens>("all");
  const [technique, setTechnique] = useState<string | null>(null);

  const matchesLens = useMemo(
    () => (e: Entry) =>
      lens === "all" ||
      (lens === "playable" && !!e.interactive?.length) ||
      (lens === "source" && !!e.repo),
    [lens],
  );

  const visible = useMemo(
    () =>
      entries.filter(
        (e) =>
          (form === "all" || e.form === form) &&
          matchesLens(e) &&
          (!technique || e.also.includes(technique)),
      ),
    [entries, form, matchesLens, technique],
  );

  const countFor = (f: Form | "all") =>
    entries.filter(
      (e) =>
        (f === "all" || e.form === f) &&
        matchesLens(e) &&
        (!technique || e.also.includes(technique)),
    ).length;

  const lensCount = (l: Lens) =>
    entries.filter(
      (e) =>
        (form === "all" || e.form === form) &&
        (l === "all" ||
          (l === "playable" && !!e.interactive?.length) ||
          (l === "source" && !!e.repo)) &&
        (!technique || e.also.includes(technique)),
    ).length;

  const grouped = forms
    .map((g) => ({ ...g, items: visible.filter((e) => e.form === g.key) }))
    .filter((g) => g.items.length > 0);

  const reset = () => {
    setForm("all");
    setLens("all");
    setTechnique(null);
  };
  const filtered = form !== "all" || lens !== "all" || technique !== null;

  return (
    <>
      {/* Controls */}
      <div className="mt-8 flex flex-col gap-3 border-y border-hair py-4">
        <Row label="show">
          {LENSES.map((l) => (
            <Chip
              key={l.key}
              active={lens === l.key}
              disabled={lensCount(l.key) === 0 && lens !== l.key}
              onClick={() => setLens(l.key)}
              title={l.hint}
            >
              {l.label}
              <Count n={lensCount(l.key)} />
            </Chip>
          ))}
        </Row>

        <Row label="form">
          <Chip
            active={form === "all"}
            disabled={false}
            onClick={() => setForm("all")}
          >
            all
            <Count n={countFor("all")} />
          </Chip>
          {forms.map((g) => (
            <Chip
              key={g.key}
              active={form === g.key}
              disabled={countFor(g.key) === 0 && form !== g.key}
              onClick={() => setForm(g.key)}
              title={g.note}
            >
              {g.title.toLowerCase()}
              <Count n={countFor(g.key)} />
            </Chip>
          ))}
        </Row>

        {/* Techniques double as a cross-cutting filter — this is where the
            recurrence stops being a claim and becomes navigable. */}
        <Row label="technique">
          {recurring.map(([t, n]) => (
            <Chip
              key={t}
              active={technique === t}
              disabled={false}
              onClick={() => setTechnique(technique === t ? null : t)}
              title={`appears in ${n} entries`}
            >
              {t}
              <Count n={n} />
            </Chip>
          ))}
        </Row>

        <div className="flex items-baseline gap-3 font-mono text-xs">
          <span className="text-faint" aria-live="polite">
            {visible.length} of {entries.length} shown
          </span>
          {filtered && (
            <button
              type="button"
              onClick={reset}
              className="text-dim underline decoration-hair underline-offset-4 transition-colors hover:text-accent hover:decoration-accent"
            >
              clear
            </button>
          )}
        </div>
      </div>

      {/* Results */}
      {grouped.length === 0 ? (
        <p className="mt-12 font-mono text-sm text-faint">
          Nothing matches those filters.
        </p>
      ) : (
        <div className="mt-12 flex flex-col gap-14">
          {grouped.map((g) => (
            <section key={g.key} aria-labelledby={`form-${g.key}`}>
              <div className="border-b border-hair pb-3">
                <h2
                  id={`form-${g.key}`}
                  className="font-display text-lg font-semibold text-accent"
                >
                  {g.title}
                </h2>
                <p className="mt-1 font-mono text-xs text-dim">{g.note}</p>
              </div>
              <div className="mt-2">
                {g.items.map((entry) => (
                  <EntryRow key={entry.slug} entry={entry} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-2">
      <span className="w-20 shrink-0 font-mono text-xs text-faint">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Chip({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={`rounded-sm border px-2 py-0.5 font-mono text-xs transition-colors ${
        active
          ? "border-accent text-accent"
          : disabled
            ? "cursor-not-allowed border-hair-soft text-faint opacity-50"
            : "border-hair text-dim hover:border-muted hover:text-body"
      }`}
    >
      {children}
    </button>
  );
}

function Count({ n }: { n: number }) {
  return <span className="ml-1.5 tabular-nums text-faint">{n}</span>;
}
