import type { Metadata } from "next";
import { JetBrains_Mono, Archivo } from "next/font/google";
import Link from "next/link";
import { person } from "@/content/cv";
import "./globals.css";

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
});

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  weight: ["600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://akiratran.com"),
  title: {
    default: `${person.name} — ${person.tagline}`,
    template: `%s — ${person.name}`,
  },
  description: person.blurb,
  openGraph: {
    title: `${person.name} — ${person.tagline}`,
    description: person.blurb,
    url: "https://akiratran.com",
    siteName: person.name,
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};

const nav = [
  { href: "/", label: "~" },
  { href: "/work", label: "work" },
  { href: "/writing", label: "writing" },
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
              className="text-dim transition-colors hover:text-bright"
            >
              akira-tran
            </Link>
            <nav className="flex gap-5" aria-label="Main">
              {nav.slice(1).map((item) => (
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
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-6 py-5 text-xs text-dim">
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
                linkedin
              </a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
