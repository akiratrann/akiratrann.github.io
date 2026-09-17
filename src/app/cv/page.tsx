import type { Metadata } from "next";
import { education, honors, person, roles, skills } from "@/content/cv";

export const metadata: Metadata = {
  title: "CV",
  description: `Résumé for ${person.name} — research, engineering, museum and writing work.`,
};

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-12" aria-labelledby={id}>
      <h2
        id={id}
        className="font-mono text-xs uppercase tracking-[0.18em] text-faint"
      >
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default function CvPage() {
  return (
    <>
      <h1 className="font-display text-4xl font-bold tracking-tight text-bright">
        CV
      </h1>
      <p className="mt-4 max-w-[62ch] text-muted">{person.blurb}</p>
      <p className="mt-3 font-mono text-xs text-muted">{person.availability}</p>

      <Section id="education" title="Education">
        <div className="border-l border-hair pl-5">
          <h3 className="font-prose text-lg font-semibold text-bright">
            {education.school}
          </h3>
          <p className="text-body">{education.degree}</p>
          <p className="text-dim">{education.minors}</p>
          <p className="mt-1 font-mono text-xs text-faint">
            Graduating {education.graduation} · GPA {education.gpa}
          </p>
          <p className="mt-3 font-mono text-xs text-faint">
            Coursework{" "}
            <span className="text-dim">
              {education.coursework.join(" · ")}
            </span>
          </p>
        </div>
      </Section>

      <Section id="experience" title="Experience">
        <ol className="space-y-9">
          {roles.map((role) => (
            <li
              key={`${role.org}-${role.dates}`}
              className="border-l border-hair pl-5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <h3 className="font-prose text-lg font-semibold text-bright">
                  {role.title}
                  {role.current && (
                    <span className="ml-2 align-middle font-mono text-[10px] uppercase tracking-[0.14em] text-accent">
                      current
                    </span>
                  )}
                </h3>
                <span className="font-mono text-xs text-faint">
                  {role.dates}
                </span>
              </div>
              <p className="font-mono text-xs text-dim">
                {role.org} · {role.place}
              </p>
              <ul className="mt-2.5 space-y-1.5">
                {role.points.map((point, i) => (
                  <li key={i} className="flex gap-2.5 text-body">
                    <span className="mt-[9px] text-faint" aria-hidden="true">
                      ·
                    </span>
                    <span className="max-w-[64ch]">{point}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </Section>

      {/* Set as running text rather than badge clouds — the project index is
          the real evidence, and inert tags read as keyword stuffing. */}
      <Section id="skills" title="Skills">
        <dl className="flex flex-col gap-2 font-mono text-xs">
          <div className="flex gap-3">
            <dt className="w-24 shrink-0 text-faint">languages</dt>
            <dd className="max-w-[58ch] text-body">
              {skills.languages.join(" · ")}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-24 shrink-0 text-faint">areas</dt>
            <dd className="max-w-[58ch] text-body">
              {skills.areas.join(" · ")}
            </dd>
          </div>
        </dl>
      </Section>

      <Section id="honours" title="Honours">
        <ul className="space-y-2">
          {honors.map((h) => (
            <li
              key={h.event}
              className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-hair-soft pb-2 font-mono text-xs"
            >
              <span className="text-dim">
                <span className="text-body">{h.award}</span> — {h.event}
              </span>
              <span className="tabular-nums text-faint">{h.year}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="contact" title="Contact">
        <ul className="space-y-1.5 font-mono text-sm">
          <li>
            <a
              href={`mailto:${person.email}`}
              className="text-accent underline decoration-accent-soft underline-offset-4 transition-colors hover:decoration-accent"
            >
              {person.email}
            </a>
          </li>
          <li>
            <a
              href={person.github}
              className="text-body underline decoration-hair underline-offset-4 transition-colors hover:decoration-accent"
            >
              {person.githubHandle}
            </a>
          </li>
          <li>
            <a
              href={person.linkedin}
              className="text-body underline decoration-hair underline-offset-4 transition-colors hover:decoration-accent"
            >
              {person.linkedinHandle}
            </a>
          </li>
        </ul>
      </Section>
    </>
  );
}
