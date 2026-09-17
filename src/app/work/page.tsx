import type { Metadata } from "next";
import { EntryRow } from "@/components/Entry";
import { byForm, forms, recurringTechniques, work } from "@/content/work";

export const metadata: Metadata = {
  title: "Work",
  description:
    "Compilers, renderers, malware scanners, games, comics, and museum object research — one index, grouped by the form the work takes.",
};

export default function WorkIndex() {
  const recurring = recurringTechniques();

  return (
    <>
      <header>
        <h1 className="font-display text-4xl font-bold tracking-tight text-bright">
          Work
        </h1>
        <p className="mt-4 max-w-[58ch] text-muted">
          Grouped by the form a thing takes rather than by discipline, because
          the same techniques keep turning up in different mediums. Entries with
          a public repository link to it; the compiler and security research
          belong to other people and are not mine to open-source.
        </p>

        {/* Recurrence is the argument for coherence — better shown as data
            than asserted in the bio. */}
        <dl className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-xs">
          <dt className="text-faint">recurring</dt>
          {recurring.map(([technique, count], i) => (
            <dd key={technique} className="text-dim">
              {i > 0 && (
                <span className="mr-3 text-faint" aria-hidden="true">
                  ·
                </span>
              )}
              {technique}
              <span className="text-faint"> ×{count}</span>
            </dd>
          ))}
        </dl>
      </header>

      <div className="mt-14 flex flex-col gap-14">
        {forms.map((group) => {
          const entries = byForm(group.key);
          if (entries.length === 0) return null;

          return (
            <section key={group.key} aria-labelledby={`form-${group.key}`}>
              <div className="border-b border-hair pb-3">
                <h2
                  id={`form-${group.key}`}
                  className="font-display text-lg font-semibold text-accent"
                >
                  {group.title}
                </h2>
                <p className="mt-1 font-mono text-xs text-dim">{group.note}</p>
              </div>

              <div className="mt-2">
                {entries.map((entry) => (
                  <EntryRow key={entry.slug} entry={entry} />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <p className="mt-14 border-t border-hair pt-4 font-mono text-xs text-faint">
        {work.length} entries.
      </p>
    </>
  );
}
