import Link from "next/link";

/*
  The one place a compiler diagnostic is literally true: this really is an
  error, and the notation really is describing it. Used once it is a joke;
  used as the whole site's grammar it was a claim about who he is.
*/
export default function NotFound() {
  return (
    <section>
      <p className="font-mono text-sm">
        <span className="text-error">error[E404]</span>
        <span className="text-bright">: no such page</span>
      </p>

      <div className="mt-1 font-mono text-sm text-faint" aria-hidden="true">
        <p className="pl-2">--&gt; akiratran.com</p>
        <p className="pl-2">|</p>
        <p className="pl-2">
          | <span className="text-muted">the link that got you here</span>
        </p>
        <p className="pl-2">
          | <span className="text-error">^^^^^^^^^^^^^^^^^^^^^^^^^</span> not
          found
        </p>
      </div>

      <p className="mt-6 max-w-[46ch] text-muted">
        Either it moved or it never existed. The work index is the best place to
        start over.
      </p>

      <nav className="mt-6 flex gap-5 font-mono text-sm">
        <Link
          href="/"
          className="text-accent underline decoration-accent-soft underline-offset-4 transition-colors hover:decoration-accent"
        >
          home
        </Link>
        <Link
          href="/work"
          className="text-accent underline decoration-accent-soft underline-offset-4 transition-colors hover:decoration-accent"
        >
          work
        </Link>
        <Link
          href="/cv"
          className="text-accent underline decoration-accent-soft underline-offset-4 transition-colors hover:decoration-accent"
        >
          cv
        </Link>
      </nav>
    </section>
  );
}
