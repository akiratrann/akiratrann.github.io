import type { Metadata } from "next";
import { Diagnostic } from "@/components/Diagnostic";
import { projects } from "@/content/projects";

export const metadata: Metadata = {
  title: "Work",
  description:
    "Compilers, security research, games and tools — the full list, each entry as a compiler diagnostic.",
};

export default function WorkPage() {
  const warnings = projects.filter((p) => p.level !== "note").length;
  const plural = warnings === 1 ? "warning" : "warnings";

  return (
    <>
      <h1 className="font-display text-4xl font-bold tracking-tight text-bright">
        Work
      </h1>

      <p className="mt-4 max-w-[62ch] text-muted">
        Research, games, and tools. Entries with a public repository link to it;
        the compiler and security research is not mine to open-source.
      </p>

      <p className="mt-6 text-xs text-faint" aria-hidden="true">
        {projects.length} entries, {warnings} {plural}
      </p>

      <div className="mt-2">
        {projects.map((project) => (
          <Diagnostic key={project.slug} project={project} />
        ))}
      </div>
    </>
  );
}
