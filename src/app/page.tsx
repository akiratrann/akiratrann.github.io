import Link from "next/link";
import { Diagnostic } from "@/components/Diagnostic";
import { featured } from "@/content/projects";
import { person } from "@/content/cv";

const stages = ["source", "ast", "ir", "wasm"];

export default function Home() {
  return (
    <>
      <section>
        {/* The compilation pipeline, used as an eyebrow: it names what the
            work actually is before the prose does. */}
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-faint"
          aria-hidden="true"
        >
          {stages.map((stage, i) => (
            <span key={stage} className="flex items-center gap-2">
              <span className={i === 0 ? "text-accent" : "text-dim"}>
                {stage}
              </span>
              {i < stages.length - 1 && <span>→</span>}
            </span>
          ))}
        </div>

        <h1 className="mt-4 font-display text-5xl font-bold leading-none tracking-tight text-bright sm:text-6xl">
          {person.name}
        </h1>

        <p className="mt-5 max-w-[62ch] text-muted">
          Stanford{" "}
          <span className="text-body">BS/MS Computer Science &rsquo;27</span>,
          minors in Fine Arts and Music. I work on{" "}
          <span className="text-accent">compiler internals</span> for Morphic, a
          pure functional language, and on{" "}
          <span className="text-accent">security research</span> at Socket.dev —
          teaching scanners to catch the malicious code they currently miss.
        </p>
        <p className="mt-3 max-w-[62ch] text-dim">
          Off the clock I guide tours at the Cantor Arts Center and build
          software for people who draw.
        </p>
      </section>

      <section className="mt-14" aria-labelledby="selected">
        <h2
          id="selected"
          className="text-xs uppercase tracking-[0.18em] text-faint"
        >
          Selected work
        </h2>

        <div className="mt-2">
          {featured.map((project) => (
            <Diagnostic key={project.slug} project={project} />
          ))}
        </div>

        <Link
          href="/work"
          className="mt-6 inline-block text-dim transition-colors hover:text-accent"
        >
          <span aria-hidden="true">$ </span>
          see all work
        </Link>
      </section>
    </>
  );
}
