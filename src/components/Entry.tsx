import Link from "next/link";
import type { Entry, Status } from "@/content/work";

/*
  One entry, one shape — whether it is a compiler, a game, or a year spent
  researching three objects in a museum. Metadata stays in mono; the sentence
  a human reads is set in the prose face.
*/

/* "shipped" is the right word for software and the wrong one for a museum
   study or a season of television, so the label follows the form. */
function statusLabel(entry: Entry): string {
  if (entry.status === "shipped" && entry.form === "study") return "complete";
  return entry.status;
}

/* State is carried by the mark as well as the colour, so it survives a
   greyscale print and a colour-blind reader. */
const statusMark: Record<Status, string> = {
  active: "●",
  shipped: "◆",
  archived: "○",
};

const statusTone: Record<Status, string> = {
  active: "text-accent",
  shipped: "text-muted",
  archived: "text-dim",
};

function Meta({ entry }: { entry: Entry }) {
  return (
    <div className="flex shrink-0 items-baseline gap-2 font-mono text-xs">
      <span className={statusTone[entry.status]}>
        <span aria-hidden="true">{statusMark[entry.status]} </span>
        {statusLabel(entry)}
      </span>
      <span className="text-faint" aria-hidden="true">
        ·
      </span>
      <span className="tabular-nums text-dim">{entry.year}</span>
    </div>
  );
}

export function EntryRow({ entry }: { entry: Entry }) {
  const linked = entry.depth === "case-study";
  const title = linked ? (
    <Link
      href={`/work/${entry.slug}`}
      className="text-bright underline decoration-hair underline-offset-4 transition-colors hover:decoration-accent"
    >
      {entry.name}
    </Link>
  ) : (
    <span className="text-bright">{entry.name}</span>
  );

  return (
    <article className="border-t border-hair-soft py-5 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="flex flex-wrap items-baseline gap-2 font-prose text-lg font-semibold leading-snug">
          {title}
          {/* Signals there is something to actually use, not just read. */}
          {!!entry.interactive?.length && (
            <span className="rounded-sm border border-accent px-1.5 py-0.5 font-mono text-[10px] font-normal uppercase tracking-[0.12em] text-accent">
              playable
            </span>
          )}
        </h3>
        <Meta entry={entry} />
      </div>

      <p className="mt-1 font-mono text-xs text-muted">{entry.role}</p>

      <p className="mt-2 max-w-[62ch] font-prose text-[0.975rem] leading-relaxed text-body">
        {entry.summary}
      </p>

      <dl className="mt-3 flex flex-col gap-1 font-mono text-xs">
        <div className="flex gap-2">
          <dt className="w-10 shrink-0 text-faint">with</dt>
          <dd className="text-dim">{entry.with}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-10 shrink-0 text-faint">also</dt>
          <dd className="text-dim">
            {entry.also.join(" · ")}
            {entry.stack ? (
              <>
                <span className="text-faint"> — </span>
                {entry.stack.join(" · ")}
              </>
            ) : null}
          </dd>
        </div>
      </dl>

      {(entry.repo || linked || !!entry.interactive?.length) && (
        <div className="mt-3 flex flex-wrap gap-4 font-mono text-xs">
          {/* Deep-link past the prose to the thing you can touch. */}
          {!!entry.interactive?.length && (
            <Link
              href={`/work/${entry.slug}#try`}
              className="text-accent underline decoration-accent-soft underline-offset-4 transition-colors hover:decoration-accent"
            >
              try it
            </Link>
          )}
          {linked && (
            <Link
              href={`/work/${entry.slug}`}
              className="text-dim underline decoration-hair underline-offset-4 transition-colors hover:text-accent hover:decoration-accent"
            >
              read more
            </Link>
          )}
          {entry.repo && (
            <a
              href={entry.repo}
              className="text-dim underline decoration-hair underline-offset-4 transition-colors hover:text-accent hover:decoration-accent"
            >
              source
            </a>
          )}
        </div>
      )}
    </article>
  );
}
