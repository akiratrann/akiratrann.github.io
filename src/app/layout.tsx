import type { Metadata } from "next";
import { JetBrains_Mono, Archivo } from "next/font/google";
import Link from "next/link";
import { person } from "@/content/cv";
import { publishedPosts } from "@/content/posts";
import "./globals.css";

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
});

// 400/500 carry running prose, 600/700 carry headings. next/font self-hosts
// these at build time, so there is no font CDN at runtime.
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

/*
  akiratran.com is not registered yet, so the canonical host comes from the
  environment and falls back to the Vercel deployment. Set
  NEXT_PUBLIC_SITE_URL once the domain is live; nothing else needs touching.
*/
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: `${person.name} — ${person.tagline}`,
    template: `%s — ${person.name}`,
  },
  description: person.blurb,
  openGraph: {
    title: `${person.name} — ${person.tagline}`,
    description: person.blurb,
    url: siteUrl,
    siteName: person.name,
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};

/*
  Writing only appears once something is actually published — a nav item that
  leads to "nothing published yet" costs more than the missing link does.
  Flip a post's `draft` to false in content/posts.ts and it returns by itself.
*/
const nav = [
  { href: "/work", label: "work" },
  ...(publishedPosts.length > 0
    ? [{ href: "/writing", label: "writing" }]
    : []),
  { href: "/cv", label: "cv" },
];

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${jetbrains.variable} ${archivo.variable}`}>
      <body className="min-h-screen flex flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-3 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-ground"
        >
          Skip to content
        </a>

        <header className="border-b border-hair">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-4">
            <Link
              href="/"
              className="font-mono text-sm text-dim transition-colors hover:text-bright"
            >
              {person.name}
            </Link>
            <nav className="flex gap-5 font-mono text-sm" aria-label="Main">
              {nav.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-dim transition-colors hover:text-accent"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>

        <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
          {children}
        </main>

        <footer className="border-t border-hair">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-6 py-5 font-mono text-xs text-dim">
            <a
              href={`mailto:${person.email}`}
              className="transition-colors hover:text-accent"
            >
              {person.email}
            </a>
            <div className="flex gap-4">
              <a
                href={person.github}
                className="transition-colors hover:text-accent"
              >
                {person.githubHandle}
              </a>
              <a
                href={person.linkedin}
                className="transition-colors hover:text-accent"
              >
                {person.linkedinHandle}
              </a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
