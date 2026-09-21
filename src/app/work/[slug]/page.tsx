import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { demos } from "@/components/demos/registry";
import { caseStudies, findEntry } from "@/content/work";

type Params = { params: Promise<{ slug: string }> };

// Only case studies get a page; every other entry is a one-liner in the index.
export function generateStaticParams() {
  return caseStudies.map((e) => ({ slug: e.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const entry = findEntry(slug);
  if (!entry) return {};
  return { title: entry.name, description: entry.summary };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-16 shrink-0 text-faint">{label}</dt>
      <dd className="text-body">{children}</dd>
    </div>
  );
}

export default async function EntryPage({ params }: Params) {
  const { slug } = await params;
  const entry = findEntry(slug);
  if (!entry || entry.depth !== "case-study") notFound();

  return (
    <article>
      <Link
        href="/work"
        className="font-mono text-xs text-dim transition-colors hover:text-accent"
      >
        <span aria-hidden="true">← </span>
        work
      </Link>

      <h1 className="mt-6 font-display text-4xl font-bold leading-tight tracking-tight text-bright">
        {entry.name}
      </h1>

      <p className="mt-3 max-w-[52ch] text-xl leading-snug text-body">
        {entry.summary}
      </p>

      <dl className="mt-8 flex flex-col gap-2 border-y border-hair py-5 font-mono text-xs">
        <Field label="role">{entry.role}</Field>
        <Field label="with">{entry.with}</Field>
        <Field label="when">
          <span className="tabular-nums">{entry.year}</span>
          <span className="text-faint"> · </span>
          <span className="text-muted">{entry.status}</span>
        </Field>
        {entry.stack && <Field label="stack">{entry.stack.join(" · ")}</Field>}
        <Field label="also">{entry.also.join(" · ")}</Field>
        <Field label="source">
          {entry.repo ? (
            <a
              href={entry.repo}
              className="text-accent underline decoration-accent-soft underline-offset-4 transition-colors hover:decoration-accent"
            >
              {entry.repo.replace("https://", "")}
            </a>
          ) : (
            <span className="text-dim">not public — research code</span>
          )}
        </Field>
      </dl>

      <div className="mt-8 flex max-w-[68ch] flex-col gap-5 text-body">
        {entry.body?.map((paragraph) => (
          <p key={paragraph.slice(0, 40)}>{paragraph}</p>
        ))}
      </div>

      {!!entry.interactive?.length && (
        <div id="try" className="scroll-mt-20">
          {entry.interactive.map((key) => {
            const Demo = demos[key];
            return <Demo key={key} />;
          })}
        </div>
      )}

      {entry.media?.length ? (
        <div className="mt-10 flex flex-col gap-6">
          {entry.media.map((m) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={m.src}
              src={m.src}
              alt={m.alt}
              width={m.width}
              height={m.height}
              loading="lazy"
              className="w-full rounded border border-hair"
            />
          ))}
        </div>
      ) : null}

      <Link
        href="/work"
        className="mt-12 inline-block font-mono text-xs text-dim transition-colors hover:text-accent"
      >
        <span aria-hidden="true">← </span>
        all work
      </Link>
    </article>
  );
}
