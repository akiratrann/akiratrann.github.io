import type { Metadata } from "next";
import Link from "next/link";
import { allPosts, formatDate, publishedPosts } from "@/content/posts";

export const metadata: Metadata = {
  title: "Writing",
  description: "Notes on compilers, security research, and building tools.",
};

export default function WritingPage() {
  // Drafts stay visible in development so they can be worked on.
  const visible =
    process.env.NODE_ENV === "development" ? allPosts : publishedPosts;

  return (
    <>
      <h1 className="font-display text-4xl font-bold tracking-tight text-bright">
        Writing
      </h1>
      <p className="mt-4 max-w-[62ch] text-muted">
        Notes on compilers, security research, and building tools.
      </p>

      {visible.length === 0 ? (
        <p className="mt-10 text-dim">
          <span className="text-note">note</span>: nothing published yet.
        </p>
      ) : (
        <ul className="mt-10">
          {visible.map((post) => (
            <li key={post.slug} className="border-b border-hair-soft py-6">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <h2 className="text-[15px]">
                  <Link
                    href={`/writing/${post.slug}`}
                    className="text-bright underline decoration-hair underline-offset-4 transition-colors hover:decoration-accent"
                  >
                    {post.title}
                  </Link>
                  {post.draft && (
                    <span className="ml-2 align-middle text-[10px] uppercase tracking-[0.14em] text-accent">
                      draft
                    </span>
                  )}
                </h2>
                <time
                  dateTime={post.date}
                  className="text-xs text-faint tabular-nums"
                >
                  {formatDate(post.date)}
                </time>
              </div>
              <p className="mt-2 max-w-[64ch] text-dim">{post.summary}</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
