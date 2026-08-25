import type { Metadata } from "next";
import { education, honors, person, roles, skills } from "@/content/cv";

export const metadata: Metadata = {
  title: "CV",
  description: `Résumé for ${person.name} — compilers research, security research, and prior work.`,
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
      <h2 id={id} className="text-xs uppercase tracking-[0.18em] text-faint">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Tags({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-wrap gap-x-2 gap-y-2">
      {items.map((item) => (
        <li
          key={item}
          className="rounded-sm border border-hair px-2 py-0.5 text-xs text-body"
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

export default function CvPage() {
  return (
    <>
      <h1 className="font-display text-4xl font-bold tracking-tight text-bright">
        CV
      </h1>
      <p className="mt-4 max-w-[62ch] text-muted">{person.blurb}</p>

      <Section id="education" title="Education">
        <div className="border-l border-hair pl-5">
          <h3 className="text-bright">{education.school}</h3>
          <p className="text-body">{education.degree}</p>
          <p className="text-dim">{education.minors}</p>
          <p className="mt-1 text-xs text-faint">
            Graduating {education.graduation} · GPA {education.gpa}
          </p>
          <p className="mt-3 text-xs text-faint">Relevant coursework</p>
          <div className="mt-2">
            <Tags items={education.coursework} />
          </div>
        </div>
      </Section>

      <Section id="experience" title="Experience">
        <ol className="space-y-9">
          {roles.map((role) => (
            <li key={`${role.org}-${role.dates}`} className="border-l border-hair pl-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <h3 className="text-bright">
                  {role.title}
                  {role.current && (
                    <span className="ml-2 align-middle text-[10px] uppercase tracking-[0.14em] text-accent">
                      current
                    </span>
                  )}
                </h3>
                <span className="text-xs text-faint">{role.dates}</span>
              </div>
              <p className="text-dim">
                {role.org} · {role.place}
              </p>
              <ul className="mt-2.5 space-y-1.5">
                {role.points.map((point, i) => (
                  <li key={i} className="flex gap-2.5 text-body">
                    <span className="mt-[3px] text-faint" aria-hidden="true">
                      ·
                    </span>
                    <span className="max-w-[64ch] leading-relaxed">{point}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="skills" title="Skills">
        <div className="space-y-5">
          <div>
            <p className="mb-2 text-xs text-faint">Languages</p>
            <Tags items={skills.languages} />
          </div>
          <div>
            <p className="mb-2 text-xs text-faint">Areas</p>
            <Tags items={skills.areas} />
          </div>
          <div>
            <p className="mb-2 text-xs text-faint">Tools</p>
            <Tags items={skills.tools} />
          </div>
        </div>
      </Section>

      <Section id="honors" title="Honours">
        <ul className="space-y-2">
          {honors.map((h) => (
            <li
              key={h.event}
              className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-hair-soft pb-2"
            >
              <span className="text-body">
                <span className="text-accent">{h.award}</span> — {h.event}
              </span>
              <span className="text-xs text-faint">{h.year}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="contact" title="Contact">
        <ul className="space-y-1.5">
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
