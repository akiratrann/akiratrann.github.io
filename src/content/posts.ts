export type Post = {
  slug: string;
  title: string;
  date: string; // ISO
  summary: string;
  /** Drafts are hidden from the index but still reachable by URL. */
  draft?: boolean;
};

/*
  Add a post by creating src/app/writing/<slug>/page.mdx and adding an entry
  here. The index reads this list; routing comes from the file itself.
*/
export const posts: Post[] = [
  {
    slug: "making-an-ast-print-itself",
    title: "Making an AST print itself",
    date: "2026-02-14",
    summary:
      "A pure functional compiler that cannot show you its own intermediate state is very hard to develop against. Notes on adding debugging output to twenty-five syntax tree structures.",
    draft: true,
  },
  {
    slug: "what-a-scanner-misses",
    title: "What a scanner misses",
    date: "2026-05-02",
    summary:
      "Dependency scanners read source. Attackers ship binaries. Notes on the gap between those two facts.",
    draft: true,
  },
];

export const publishedPosts = posts
  .filter((p) => !p.draft)
  .sort((a, b) => b.date.localeCompare(a.date));

export const allPosts = [...posts].sort((a, b) => b.date.localeCompare(a.date));

export function formatDate(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
