import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { projects, projectBySlug } from "@/content/projects";

type Params = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return projects.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const project = projectBySlug(slug);
  if (!project) return {};
  return { title: project.name, description: project.headline };
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 text-faint">{label}</dt>
      <dd className="text-body">{children}</dd>
    </div>
  );
}

export default async function ProjectPage({ params }: Params) {
  const { slug } = await params;
  const project = projectBySlug(slug);
  if (!project) notFound();

  const index = projects.findIndex((p) => p.slug === slug);
  const next = projects[index + 1];

  return (
    <article>
      <Link
        href="/work"
        className="text-xs text-dim transition-colors hover:text-accent"
      >
        <span aria-hidden="true">← </span>work
      </Link>

      <h1 className="mt-5 font-display text-4xl font-bold leading-tight tracking-tight text-bright">
        {project.name}
      </h1>
      <p className="mt-3 max-w-[62ch] text-muted">{project.headline}</p>

      <dl className="mt-7 space-y-1.5 border-y border-hair py-5 text-[13px]">
        <Meta label="stack">{project.stack.join(" · ")}</Meta>
        <Meta label="context">{project.context}</Meta>
        <Meta label="year">{project.year}</Meta>
        <Meta label="source">
          {project.repo ? (
            <a
              href={project.repo}
              className="text-accent underline decoration-accent-soft underline-offset-4 transition-colors hover:decoration-accent"
            >
              {project.repo.replace("https://github.com/", "")}
            </a>
          ) : (
            <span className="text-faint">
              not public — {project.context.includes("Socket") || project.context.includes("Aiken")
                ? "research code"
                : "private repository"}
            </span>
          )}
        </Meta>
      </dl>

      <div className="mt-8 space-y-5">
        {project.body.map((para, i) => (
          <p key={i} className="max-w-[68ch] leading-[1.75] text-body">
            {para}
          </p>
        ))}
      </div>

      <p className="mt-10 text-dim">
        <span className="text-note">help</span>: {project.help}
      </p>

      {next && (
        <nav className="mt-12 border-t border-hair pt-5">
          <Link
            href={`/work/${next.slug}`}
            className="text-dim transition-colors hover:text-accent"
          >
            next: {next.name}
            <span aria-hidden="true"> →</span>
          </Link>
        </nav>
      )}
    </article>
  );
}
