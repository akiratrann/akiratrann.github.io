# akiratran.com

Personal site and portfolio. Next.js 16 (App Router) + Tailwind 4, statically
generated, deployed on Vercel.

The design direction is **Diagnostic**: every project is presented in the shape
of a compiler error message — severity word, `-->` source location, a
highlighted span with a caret underline, and a trailing `help:` line. It borrows
rustc's grammar specifically, because that is the code I actually work on.

## Running it

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm build        # production build
```

## Where things live

| Path | What it is |
| --- | --- |
| `src/content/projects.ts` | Every project, including its diagnostic span. Edit here to change the work list. |
| `src/content/cv.ts` | Résumé data — education, roles, skills, honours. |
| `src/content/posts.ts` | Post index (title, date, summary, draft flag). |
| `src/app/writing/<slug>/page.mdx` | The posts themselves. |
| `src/components/Diagnostic.tsx` | Renders one project as a compiler diagnostic. |
| `src/app/globals.css` | Design tokens — palette, fonts, focus styles. |

## Adding a project

Append an entry to `projects` in `src/content/projects.ts`. The detail page and
its static route are generated from the list; nothing else needs touching.

The `span` field is the highlighted source line. `underline` must line up with
`code` character-for-character — spaces to the token, then carets across it:

```
code:      'verdict = classify(skill.deps, binaries=True)'
underline: '          ^^^^^^^^'
```

Set `featured: true` to surface it on the home page.

## Adding a post

1. Create `src/app/writing/<slug>/page.mdx`.
2. Add a matching entry to `posts` in `src/content/posts.ts`.

Drafts (`draft: true`) are visible in `pnpm dev` and hidden in production.

## Deploying

The site has no server-side dependencies — it builds to static output.

```bash
pnpm dlx vercel
```

To attach the custom domain once it is registered: add `akiratran.com` in the
Vercel project's Domains tab, then point the registrar at the records Vercel
gives you (an `A` record for the apex, `CNAME` for `www`). Until then the
`*.vercel.app` URL works fine.

`metadataBase` in `src/app/layout.tsx` is set to `https://akiratran.com` — update
it if the domain changes, or Open Graph URLs will point at the wrong host.
