import type { MDXComponents } from "mdx/types";

/*
  Prose styling for MDX posts. Kept here rather than in a wrapper component so
  every post picks it up automatically.
*/
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: ({ children }) => (
      <h1 className="font-display text-4xl font-bold leading-tight tracking-tight text-bright">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className="mt-10 font-display text-2xl font-semibold tracking-tight text-bright">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="mt-8 text-bright">{children}</h3>
    ),
    p: ({ children }) => (
      <p className="mt-5 max-w-[68ch] leading-[1.8] text-body">{children}</p>
    ),
    ul: ({ children }) => (
      <ul className="mt-5 max-w-[68ch] space-y-2">{children}</ul>
    ),
    li: ({ children }) => (
      <li className="flex gap-2.5 leading-relaxed text-body">
        <span className="mt-[3px] text-faint" aria-hidden="true">
          ·
        </span>
        <span>{children}</span>
      </li>
    ),
    a: ({ href, children }) => (
      <a
        href={href}
        className="text-accent underline decoration-accent-soft underline-offset-4 transition-colors hover:decoration-accent"
      >
        {children}
      </a>
    ),
    strong: ({ children }) => (
      <strong className="font-bold text-bright">{children}</strong>
    ),
    em: ({ children }) => <em className="not-italic text-accent">{children}</em>,
    blockquote: ({ children }) => (
      <blockquote className="mt-6 border-l-2 border-accent-soft pl-5 text-muted">
        {children}
      </blockquote>
    ),
    code: ({ children }) => (
      <code className="rounded-sm bg-raised px-1.5 py-0.5 text-[0.92em] text-accent">
        {children}
      </code>
    ),
    pre: ({ children }) => (
      <pre className="scroll-x mt-6 rounded border border-hair bg-sunken p-4 text-[13px] leading-relaxed text-body">
        {children}
      </pre>
    ),
    hr: () => <hr className="mt-10 border-hair" />,
    ...components,
  };
}
