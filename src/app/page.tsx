import Link from "next/link";
import { EntryRow } from "@/components/Entry";
import { person } from "@/content/cv";
import { featured, work } from "@/content/work";

export default function Home() {
  return (
    <>
      <section>
        <h1 className="font-display text-[clamp(2.75rem,6vw,3.5rem)] font-bold leading-none tracking-tight text-bright">
          {person.name}
        </h1>

        {/* The predicate does the work the old compiler eyebrow was doing,
            except it describes a person rather than a discipline. */}
        <p className="mt-5 max-w-[46ch] text-xl leading-snug text-body">
          {person.predicate}
        </p>

        <p className="mt-4 max-w-[58ch] text-muted">
          Compilers and malware scanners, real-time renderers and games, local
          tooling for drawing comics — and three objects in a museum I spent a
          year researching.
        </p>

        <div className="mt-7 flex flex-col gap-1 font-mono text-xs text-dim">
          <p>
            Stanford <span className="text-muted">BS/MS Computer Science</span>{" "}
            &rsquo;27 <span className="text-faint">·</span> minors in Fine Arts
            and Music
          </p>
          <p className="text-muted">{person.availability}</p>
          <p className="text-faint">
            Updated{" "}
            <time dateTime={person.lastUpdated}>{person.lastUpdatedLabel}</time>
          </p>
        </div>
      </section>

      <section className="mt-16" aria-labelledby="selected">
        <div className="flex items-baseline justify-between gap-4">
          <h2
            id="selected"
            className="font-mono text-xs uppercase tracking-[0.18em] text-faint"
          >
            Selected work
          </h2>
          <p className="font-mono text-xs text-faint">
            {featured.length} of {work.length}
          </p>
        </div>

        <div className="mt-4">
          {featured.map((entry) => (
            <EntryRow key={entry.slug} entry={entry} />
          ))}
        </div>

        <Link
          href="/work"
          className="mt-8 inline-block font-mono text-sm text-dim underline decoration-hair underline-offset-4 transition-colors hover:text-accent hover:decoration-accent"
        >
          Everything else — {work.length} entries
        </Link>
      </section>
    </>
  );
}
