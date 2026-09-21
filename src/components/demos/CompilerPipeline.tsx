"use client";

import { useState } from "react";

/*
  Morphic's compilation pipeline, as the compiler actually runs it.

  Pass order is transcribed from crates/morphic_frontend/src/lib.rs and
  crates/morphic_backend/src/lib.rs. The AST module for each stage is a real
  file under crates/morphic_common/src/data/, the pretty-printer column is the
  real contents of crates/morphic_common/src/pretty_print/, and the artifact
  names are the literal strings passed to artifact_path() in the backend.

  The printable column is the point: a pure functional compiler that cannot
  show you its own intermediate state is very hard to develop against, and
  adding that output across the representations is the work this demo is about.
*/

type Stage = {
  pass: string;
  half: "frontend" | "backend";
  /** Module under crates/morphic_common/src/data/, without the _ast.rs suffix. */
  ast: string | null;
  /** Module under crates/morphic_common/src/pretty_print/, if one exists. */
  printer: string | null;
  /** Literal string handed to artifact_path() in the backend driver. */
  artifact: string | null;
  what: string;
};

const STAGES: Stage[] = [
  {
    pass: "resolve",
    half: "frontend",
    ast: "resolved_ast",
    printer: null,
    artifact: null,
    what: "Turns parsed source into a program with names bound to definitions, resolving module imports and the `expose` lists.",
  },
  {
    pass: "check_purity",
    half: "frontend",
    ast: null,
    printer: null,
    artifact: null,
    what: "Rejects programs that perform effects where the language promises none. Morphic separates pure functions from procs, and this is where that is enforced.",
  },
  {
    pass: "type_infer",
    half: "frontend",
    ast: "typed_ast",
    printer: "typed",
    artifact: null,
    what: "Infers a type for every expression. The first representation with a pretty-printer, so this is the earliest stage you can actually read back.",
  },
  {
    pass: "fix_purity",
    half: "frontend",
    ast: "typed_ast",
    printer: "typed",
    artifact: null,
    what: "Re-infers purity from builtins and constraints, so later passes see correct purity rather than the pre-inference approximation.",
  },
  {
    pass: "monomorphize",
    half: "frontend",
    ast: "mono_ast",
    printer: "mono",
    artifact: null,
    what: "Specialises every polymorphic function to the concrete types it is called at, so nothing generic survives into the backend.",
  },
  {
    pass: "shield_functions",
    half: "frontend",
    ast: "mono_ast",
    printer: "mono",
    artifact: null,
    what: "Wraps functions so that later closure work has a uniform shape to operate on.",
  },
  {
    pass: "lambda_lift",
    half: "frontend",
    ast: "lambda_lifted_ast",
    printer: null,
    artifact: null,
    what: "Hoists nested lambdas to the top level, turning captured variables into explicit parameters.",
  },
  {
    pass: "annot_closures",
    half: "frontend",
    ast: "closure_annot_ast",
    printer: null,
    artifact: null,
    what: "Annotates each function value with the set of closures that can flow to it — a control-flow analysis that makes the next pass possible.",
  },
  {
    pass: "closure_specialize",
    half: "frontend",
    ast: "closure_specialized_ast",
    printer: null,
    artifact: null,
    what: "Specialises call sites against those closure sets, so indirect calls become direct ones wherever the analysis is precise enough.",
  },
  {
    pass: "lower_closures",
    half: "frontend",
    ast: "first_order_ast",
    printer: "first_order",
    artifact: "first_order.mor",
    what: "Eliminates first-class functions entirely. The result is a first-order program, dumped as real Morphic source you can read and re-check.",
  },
  {
    pass: "split_custom_types",
    half: "backend",
    ast: "anon_sum_ast",
    printer: null,
    artifact: null,
    what: "Breaks user-declared types into anonymous sums and products the backend can reason about structurally.",
  },
  {
    pass: "flatten",
    half: "backend",
    ast: "flat_ast",
    printer: "flat",
    artifact: "flat",
    what: "Flattens nested expressions into straight-line local bindings — the point where the program stops being a tree and starts being a sequence.",
  },
  {
    pass: "guard_types",
    half: "backend",
    ast: "guarded_ast",
    printer: "guarded",
    artifact: "guarded",
    what: "Inserts the guards that keep recursive type definitions well-founded once they are represented concretely.",
  },
  {
    pass: "annot_modes",
    half: "backend",
    ast: "mode_annot_ast",
    printer: "mode_annot",
    artifact: "mode_annot",
    what: "Annotates every binding with whether it is owned or borrowed. This is the analysis that lets a pure functional language avoid copying.",
  },
  {
    pass: "annot_obligations",
    half: "backend",
    ast: "obligation_annot_ast",
    printer: "obligation_annot",
    artifact: "ob_annot",
    what: "Derives, from those modes, where each value's last use is — the obligation to release it.",
  },
  {
    pass: "annot_rcs",
    half: "backend",
    ast: "rc_annot_ast",
    printer: "rc_annot",
    artifact: "rc_annot",
    what: "Places retain and release operations against those obligations, turning an ownership analysis into actual reference counting.",
  },
  {
    pass: "type_check_borrows",
    half: "backend",
    ast: null,
    printer: "borrow_common",
    artifact: null,
    what: "Re-checks the borrow annotations after the fact. A verification pass, not a transformation — it exists to catch the previous three passes lying.",
  },
  {
    pass: "rc_specialize",
    half: "backend",
    ast: "rc_specialized_ast",
    printer: null,
    artifact: null,
    what: "Specialises the generic retain/release operations to the concrete layouts they act on.",
  },
  {
    pass: "tail_call_elim",
    half: "backend",
    ast: "tail_rec_ast",
    printer: "tail",
    artifact: "tail_rec",
    what: "Rewrites tail-recursive calls into loops, so recursion in a functional language does not consume stack.",
  },
  {
    pass: "lower_structures",
    half: "backend",
    ast: "low_ast",
    printer: "low",
    artifact: null,
    what: "Lowers aggregates to flat machine-level structures. The last representation before code generation.",
  },
  {
    pass: "code_gen",
    half: "backend",
    ast: null,
    printer: null,
    artifact: "ll",
    what: "Emits LLVM IR, then an optimised module, assembly and an object file. The WebAssembly target needed targeting, entry-point naming, runtime linking and a symbol-table fix before it completed at all.",
  },
];

/* Distinct printer modules, not stages — typed and mono each cover two passes. */
const PRINTERS = new Set(STAGES.map((s) => s.printer).filter(Boolean)).size;
const PRINTABLE_STAGES = STAGES.filter((s) => s.printer).length;
const ARTIFACTS = STAGES.filter((s) => s.artifact).length;

export function CompilerPipeline() {
  const [selected, setSelected] = useState(9); // lower_closures — the frontend/backend seam
  const [onlyPrintable, setOnlyPrintable] = useState(false);

  const stage = STAGES[selected];
  const shown = onlyPrintable ? STAGES.filter((s) => s.printer) : STAGES;

  return (
    <section className="mt-10 rounded border border-hair bg-raised">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hair px-4 py-3">
        <h2 className="font-prose text-base font-semibold text-bright">
          The pipeline — inspectable
        </h2>
        <p className="font-mono text-xs text-dim">
          ported from morphic_frontend/lib.rs + morphic_backend/lib.rs
        </p>
      </header>

      <div className="px-4 py-4">
        <p className="max-w-[62ch] text-sm text-muted">
          Every pass the compiler runs, in order. A program is rewritten through{" "}
          {new Set(STAGES.map((s) => s.ast).filter(Boolean)).size} distinct
          representations on its way to machine code.{" "}
          <span className="text-body">
            {PRINTERS} pretty-printers cover {PRINTABLE_STAGES} of these stages
          </span>{" "}
          &mdash; which is what makes the middle of the compiler developable at all —
          and {ARTIFACTS} of them dump an artifact to disk you can diff between
          runs.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setOnlyPrintable((v) => !v)}
            aria-pressed={onlyPrintable}
            className={`rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors ${
              onlyPrintable
                ? "border-accent text-accent"
                : "border-hair text-dim hover:border-muted hover:text-body"
            }`}
          >
            only stages with a printer
          </button>
          <span className="font-mono text-xs text-faint">
            {shown.length} of {STAGES.length} passes
          </span>
        </div>

        <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,17rem)_1fr]">
          {/* Pass list */}
          <ol className="flex flex-col">
            {shown.map((s) => {
              const idx = STAGES.indexOf(s);
              const active = idx === selected;
              const prevHalf = shown[shown.indexOf(s) - 1]?.half;
              return (
                <li key={s.pass}>
                  {s.half !== prevHalf && (
                    <p className="mt-3 mb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-faint first:mt-0">
                      {s.half}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => setSelected(idx)}
                    aria-current={active ? "true" : undefined}
                    className={`flex w-full items-baseline gap-2 border-l-2 py-1 pl-2.5 pr-2 text-left font-mono text-xs transition-colors ${
                      active
                        ? "border-accent bg-sunken text-bright"
                        : "border-hair-soft text-dim hover:border-muted hover:text-body"
                    }`}
                  >
                    <span className="truncate">{s.pass}</span>
                    {s.printer && (
                      <span
                        className="ml-auto shrink-0 text-accent"
                        title="has a pretty-printer"
                        aria-label="has a pretty-printer"
                      >
                        ●
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>

          {/* Detail */}
          <div className="min-w-0">
            <h3 className="font-mono text-sm text-bright">{stage.pass}</h3>
            <p className="mt-2 max-w-[56ch] text-sm text-body">{stage.what}</p>

            <dl className="mt-4 flex flex-col gap-2 border-t border-hair-soft pt-3 font-mono text-xs">
              <Row label="produces">
                {stage.ast ? (
                  <span className="text-body">data/{stage.ast}.rs</span>
                ) : (
                  <span className="text-faint">
                    no new representation — checks or emits
                  </span>
                )}
              </Row>
              <Row label="printer">
                {stage.printer ? (
                  <span className="text-accent">
                    pretty_print/{stage.printer}.rs
                  </span>
                ) : (
                  <span className="text-faint">none — opaque at this stage</span>
                )}
              </Row>
              <Row label="artifact">
                {stage.artifact ? (
                  <span className="text-body">{stage.artifact}</span>
                ) : (
                  <span className="text-faint">not written to disk</span>
                )}
              </Row>
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 text-faint">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
