import type { Metadata } from "next";
import { WorkIndex } from "@/components/WorkIndex";
import { forms, recurringTechniques, work } from "@/content/work";

export const metadata: Metadata = {
  title: "Work",
  description:
    "Compilers, renderers, malware scanners, games, comics, and museum object research — one index, grouped by the form the work takes, most of it playable in the browser.",
};

export default function WorkPage() {
  const playable = work.filter((e) => e.interactive?.length).length;

  return (
    <>
      <header>
        <h1 className="font-display text-4xl font-bold tracking-tight text-bright">
          Work
        </h1>
        <p className="mt-4 max-w-[58ch] text-muted">
          Grouped by the form a thing takes rather than by discipline, because
          the same techniques keep turning up in different mediums.{" "}
          <span className="text-body">
            {playable} of these run in the browser
          </span>{" "}
          — the demos port the real logic out of each project rather than
          mocking it up, so the numbers on screen are the numbers the thing
          actually runs on.
        </p>
      </header>

      <WorkIndex
        entries={work}
        forms={forms}
        recurring={recurringTechniques()}
      />
    </>
  );
}
