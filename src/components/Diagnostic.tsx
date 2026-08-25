import Link from "next/link";
import type { Level, Project } from "@/content/projects";

const levelColor: Record<Level, string> = {
  note: "text-note",
  warning: "text-accent",
  error: "text-error",
};

/** The `-->` location line, rendered the way rustc prints it. */
function Location({ loc }: { loc: string }) {
  return (
    <div className="pl-4 text-faint">
      <span aria-hidden="true">--&gt; </span>
      <span className="sr-only">at </span>
      <span className="text-muted">{loc}</span>
    </div>
  );
}

/**
 * The highlighted source span. The gutter, pipe and caret row are decorative —
 * they are hidden from assistive tech so the label still reads as one sentence.
 */
function Span({ span }: { span: NonNullable<Project["span"]> }) {
  return (
    <div className="scroll-x mt-2">
      <pre className="w-max min-w-full font-mono text-[13px] leading-relaxed">
        <span className="text-faint" aria-hidden="true">
          {String(span.line).padStart(4, " ")} |{" "}
        </span>
        <span className="text-body">{span.code}</span>
        {"\n"}
        <span className="text-faint" aria-hidden="true">
          {"     | "}
        </span>
        <span className="text-accent" aria-hidden="true">
          {span.underline}
        </span>
        <span className="text-accent"> {span.label}</span>
      </pre>
    </div>
  );
}

export function Diagnostic({
  project,
  headingLevel = "h2",
}: {
  project: Project;
  headingLevel?: "h1" | "h2";
}) {
  const Heading = headingLevel;

  return (
    <article className="border-b border-hair-soft py-7">
      <Heading className="text-[13.5px] font-normal leading-relaxed">
        <span className={`font-bold ${levelColor[project.level]}`}>
          {project.level}
        </span>
        <span className="text-muted">: </span>
        <Link
          href={`/work/${project.slug}`}
          className="text-bright underline decoration-hair underline-offset-4 transition-colors hover:decoration-accent"
        >
          {project.name}
        </Link>
        <span className="text-muted"> — {project.headline}</span>
      </Heading>

      <Location loc={project.loc} />
      {project.span && <Span span={project.span} />}

      <p className="mt-3 pl-4 text-dim sm:pl-14">
        <span className="text-note">help</span>: {project.help}
      </p>

      <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1 pl-4 text-xs text-faint sm:pl-14">
        <div className="flex gap-2">
          <dt className="sr-only">Stack</dt>
          <dd>{project.stack.join(" · ")}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="sr-only">Context</dt>
          <dd>{project.context}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="sr-only">Year</dt>
          <dd>{project.year}</dd>
        </div>
      </dl>
    </article>
  );
}
