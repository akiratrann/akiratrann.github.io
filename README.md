# akiratran.com

Personal site and portfolio. Next.js 16 (App Router) + Tailwind 4, statically
generated, deployed on Vercel.

## The idea

One index, one entry type, no second half. Work is grouped by the **form** an
artifact takes — languages and runtimes, adversarial work, worlds and pictures,
studies and scripts, apps — rather than by discipline. That is what lets a
compiler FFI and a year of museum object research sit in the same list without
either being a guest.

Each entry carries an `also` line naming the substrate it is built on.
Techniques recur across forms — cel-shading turns up in a game, a comic
pipeline and a graphics assignment — so the coherence is something a reader
notices in the data rather than something the bio asserts.

Typography splits the same way: prose is set in Archivo, and JetBrains Mono is
reserved for metadata, dates, status, stack and code.

## Running it

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm build        # production build
```

## Where things live

| Path | What it is |
| --- | --- |
| `src/content/work.ts` | Every entry, plus the form groups. This is the file you edit most. |
| `src/content/cv.ts` | Résumé data, the predicate line, availability, and the freshness date. |
| `src/content/posts.ts` | Post index (title, date, summary, draft flag). |
| `src/app/writing/<slug>/page.mdx` | The posts themselves. |
| `src/components/Entry.tsx` | Renders one entry, whatever form it takes. |
| `src/app/globals.css` | Design tokens — palette, fonts, focus styles. |

## Adding an entry

Append to `work` in `src/content/work.ts`:

```ts
{
  slug: "thing",
  name: "Thing",
  form: "app",              // language | adversarial | world | study | app
  role: "What you did — the verb, not a job title",
  with: "Solo",             // or the group, lab, studio or client
  status: "shipped",        // active | shipped | archived
  year: "2026",
  summary: "One sentence. Most entries only get this.",
  also: ["technique", "technique"],
  depth: "entry",           // "case-study" also generates a page from `body`
}
```

`depth: "case-study"` adds `/work/<slug>`, generated from the `body` paragraphs.
Only case studies are linked and routed; everything else is a one-liner in the
index. Non-code work uses exactly the same shape — see `cantor-objects`.

Optional `media` entries render on a case-study page. Nothing is listed until a
real capture exists rather than a placeholder — the visual work should be shown,
and `public/` currently holds no screenshots.

## Adding a post

1. Create `src/app/writing/<slug>/page.mdx`.
2. Add a matching entry to `posts` in `src/content/posts.ts`.

Drafts (`draft: true`) are visible in `pnpm dev` and hidden in production. While
every post is a draft, **Writing disappears from the nav by itself** — it comes
back as soon as one post has `draft: false`, so the nav never points at an empty
page.

## Deploying

The site builds to static output — no server-side dependencies.

```bash
pnpm dlx vercel
```

The canonical host comes from `NEXT_PUBLIC_SITE_URL`, falling back to the Vercel
deployment URL. `akiratran.com` is not registered yet; set that variable once it
is, and nothing else needs touching.
