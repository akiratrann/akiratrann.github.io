"use client";

import { useMemo, useState } from "react";

/*
  A working port of Payback's bill-splitting math.

  The arithmetic below is lifted from the app: src/lib/money.ts (integer-cent
  allocation), src/lib/split.ts (per-person shares) and src/lib/payments.ts
  (the Venmo deep link). No floats touch the money anywhere in the pipeline —
  every figure on screen is an integer number of cents, formatted only at the
  last moment.

  The rule worth watching is allocate(). Splitting $34.00 three ways gives
  $11.333..., and naive rounding either drops a penny or invents one. Largest
  remainder floors everyone, then hands the leftover pennies to whoever the
  floor robbed most — so shares sum to exactly the amount being split, and
  "everyone's totals add up to the bill" is true rather than nearly true.

  State is immutable: every toggle rebuilds the Bill and re-derives the totals,
  the same way the real AssignStep does.
*/

/* ---------------------------------------------------------------- types.ts */

type Person = {
  id: string;
  name: string;
  /** index into PERSON_COLORS */
  color: number;
  venmo?: string;
};

type Item = {
  id: string;
  name: string;
  /** line total in cents (price x quantity, as printed on the receipt) */
  cents: number;
  quantity: number;
  /** person ids sharing this line */
  sharedBy: string[];
};

type Bill = {
  merchant: string;
  items: Item[];
  taxCents: number;
  tipCents: number;
  /** discounts, comps, credits. Stored negative. */
  discountCents: number;
  /** delivery, service charge, anything else proportional */
  feeCents: number;
  people: Person[];
};

const PERSON_COLORS = ["#C6F24E", "#5EE6C4", "#7BA9FF", "#FF9F6B"];

/* ---------------------------------------------------------------- money.ts */

/**
 * Largest-remainder apportionment. Floor every share, then give the leftover
 * pennies to the people with the biggest fractional loss, ties broken by index
 * so the result is deterministic. Always sums to exactly `totalCents`.
 */
function allocate(totalCents: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];

  const weightSum = weights.reduce((a, b) => a + b, 0);
  // No weights to go on (e.g. a bill that is pure tax) — split evenly.
  const w = weightSum === 0 ? weights.map(() => 1) : weights;
  const wSum = weightSum === 0 ? n : weightSum;

  const exact = w.map((x) => (totalCents * x) / wSum);
  const shares = exact.map(Math.floor);

  // Math.floor always rounds down, so the remainder is in [0, n) even when
  // totalCents is negative (discounts).
  const remainder = totalCents - shares.reduce((a, b) => a + b, 0);

  const byLoss = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  for (let k = 0; k < remainder; k++) shares[byLoss[k % n].i] += 1;
  return shares;
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

function percentOf(cents: number, percent: number): number {
  return Math.round((cents * percent) / 100);
}

/**
 * Display-only, derived from allocate's own output: which indices came out a
 * penny above their floor. Nothing downstream depends on it — it just lets the
 * demo point at the cent that would otherwise go missing.
 */
function remainderPennies(totalCents: number, weights: number[]): boolean[] {
  const shares = allocate(totalCents, weights);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const w = weightSum === 0 ? weights.map(() => 1) : weights;
  const wSum = weightSum === 0 ? weights.length : weightSum;
  return shares.map((s, i) => s !== Math.floor((totalCents * w[i]) / wSum));
}

/* ---------------------------------------------------------------- split.ts */

type PersonShare = {
  personId: string;
  /** their portion of the items they were assigned to */
  itemsCents: number;
  taxCents: number;
  tipCents: number;
  feeCents: number;
  discountCents: number;
  totalCents: number;
  /** what they're on the hook for, line by line */
  lines: { itemId: string; name: string; cents: number; sharedWith: number }[];
};

type Totals = {
  subtotalCents: number;
  /** items nobody has claimed yet — excluded from everyone's totals */
  unassignedCents: number;
  assignedSubtotalCents: number;
  taxCents: number;
  tipCents: number;
  feeCents: number;
  discountCents: number;
  /** the full bill including unassigned items */
  billTotalCents: number;
  /** what the shares actually add up to */
  claimedTotalCents: number;
  shares: PersonShare[];
  unassignedItems: Item[];
};

function computeTotals(bill: Bill): Totals {
  const people = bill.people;
  const idx = new Map(people.map((p, i) => [p.id, i]));

  const itemsCents = people.map(() => 0);
  const lines: PersonShare["lines"][] = people.map(() => []);

  let subtotalCents = 0;
  let unassignedCents = 0;
  const unassignedItems: Item[] = [];

  for (const item of bill.items) {
    subtotalCents += item.cents;

    const sharers = item.sharedBy.filter((id) => idx.has(id));
    if (sharers.length === 0) {
      unassignedCents += item.cents;
      unassignedItems.push(item);
      continue;
    }

    // Split this line evenly among whoever is on it, to the cent.
    const cut = allocate(
      item.cents,
      sharers.map(() => 1),
    );
    sharers.forEach((id, k) => {
      const i = idx.get(id);
      if (i === undefined) return;
      itemsCents[i] += cut[k];
      lines[i].push({
        itemId: item.id,
        name: item.name,
        cents: cut[k],
        sharedWith: sharers.length,
      });
    });
  }

  const assignedSubtotalCents = subtotalCents - unassignedCents;

  // Tax, tip, fees and discounts ride along in proportion to what each person
  // actually ordered. If nothing is assigned yet these all come out zero
  // rather than being dumped on an arbitrary person.
  const weights = itemsCents;
  const anyAssigned = assignedSubtotalCents !== 0 || weights.some((w) => w !== 0);

  const zero = people.map(() => 0);
  const taxSplit = anyAssigned ? allocate(bill.taxCents, weights) : zero;
  const tipSplit = anyAssigned ? allocate(bill.tipCents, weights) : zero;
  const feeSplit = anyAssigned ? allocate(bill.feeCents, weights) : zero;
  const discountSplit = anyAssigned ? allocate(bill.discountCents, weights) : zero;

  const shares: PersonShare[] = people.map((p, i) => ({
    personId: p.id,
    itemsCents: itemsCents[i],
    taxCents: taxSplit[i],
    tipCents: tipSplit[i],
    feeCents: feeSplit[i],
    discountCents: discountSplit[i],
    totalCents:
      itemsCents[i] + taxSplit[i] + tipSplit[i] + feeSplit[i] + discountSplit[i],
    lines: lines[i].sort((a, b) => b.cents - a.cents),
  }));

  return {
    subtotalCents,
    unassignedCents,
    assignedSubtotalCents,
    taxCents: bill.taxCents,
    tipCents: bill.tipCents,
    feeCents: bill.feeCents,
    discountCents: bill.discountCents,
    billTotalCents:
      subtotalCents + bill.taxCents + bill.tipCents + bill.feeCents + bill.discountCents,
    claimedTotalCents: shares.reduce((a, s) => a + s.totalCents, 0),
    shares,
    unassignedItems,
  };
}

function summaryText(bill: Bill, totals: Totals): string {
  const nameOf = (id: string) =>
    bill.people.find((p) => p.id === id)?.name ?? "Someone";
  const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;

  const header = bill.merchant
    ? `${bill.merchant} — ${fmt(totals.billTotalCents)}`
    : `Bill — ${fmt(totals.billTotalCents)}`;
  const lines = totals.shares
    .filter((s) => s.totalCents !== 0)
    .sort((a, b) => b.totalCents - a.totalCents)
    .map((s) => `${nameOf(s.personId)}: ${fmt(s.totalCents)}`);

  return [header, ...lines, "", "Split with Payback"].join("\n");
}

/* ------------------------------------------------------------- payments.ts */

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "");
}

/**
 * `txn=charge` asks the named person to send money — the host collecting from
 * the table. The app never moves money; it opens Venmo with the fields filled
 * in and the human confirms it there.
 */
function venmoWebLink(person: Person, amountCents: number, note: string): string {
  const handle = normalizeHandle(person.venmo ?? "");
  const amount = (amountCents / 100).toFixed(2);
  const query = `txn=charge&amount=${amount}&note=${encodeURIComponent(note)}`;
  return handle
    ? `https://venmo.com/${encodeURIComponent(handle)}?${query}`
    : `https://venmo.com/?${query}`;
}

/* -------------------------------------------------------------- demo bill */

const PEOPLE: Person[] = [
  { id: "ana", name: "Ana", color: 0, venmo: "ana-reyes" },
  { id: "devon", name: "Devon", color: 1, venmo: "devon-okafor" },
  { id: "mika", name: "Mika", color: 2, venmo: "mika-t" },
];

/** Tip presets, from the real ItemsStep. */
const TIP_PRESETS = [15, 18, 20, 25];

const COMP_CENTS = -1000;

function demoBill(): Bill {
  return {
    merchant: "Cadence Tavern",
    people: PEOPLE,
    items: [
      { id: "i1", name: "Shishito peppers", cents: 900, quantity: 1, sharedBy: ["ana", "devon", "mika"] },
      { id: "i2", name: "Sourdough + butter", cents: 700, quantity: 1, sharedBy: ["ana", "mika"] },
      { id: "i3", name: "Cast-iron ribeye", cents: 4200, quantity: 1, sharedBy: ["devon"] },
      { id: "i4", name: "Mushroom risotto", cents: 2600, quantity: 1, sharedBy: ["ana"] },
      { id: "i5", name: "Little gem salad", cents: 1400, quantity: 1, sharedBy: ["mika"] },
      { id: "i6", name: "Sangria pitcher", cents: 3400, quantity: 1, sharedBy: ["ana", "devon", "mika"] },
    ],
    taxCents: 1155, // 8.75% as printed on the receipt
    tipCents: 2640, // 20% of the $132.00 subtotal
    discountCents: 0,
    feeCents: 0,
  };
}

/* -------------------------------------------------------------- component */

export function ReceiptSplitter() {
  const [bill, setBill] = useState<Bill>(demoBill);
  const [open, setOpen] = useState<string | null>(null);

  const totals = useMemo(() => computeTotals(bill), [bill]);
  const everyone = bill.people.map((p) => p.id);
  const subtotal = totals.subtotalCents;
  const tipPercent = subtotal > 0 ? Math.round((bill.tipCents / subtotal) * 100) : 0;

  const weights = totals.shares.map((s) => s.itemsCents);
  const taxPenny = remainderPennies(bill.taxCents, weights);
  const tipPenny = remainderPennies(bill.tipCents, weights);
  const compPenny = remainderPennies(bill.discountCents, weights);

  const update = (patch: Partial<Bill>) => setBill((b) => ({ ...b, ...patch }));

  const toggle = (itemId: string, personId: string) =>
    update({
      items: bill.items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              sharedBy: item.sharedBy.includes(personId)
                ? item.sharedBy.filter((id) => id !== personId)
                : [...item.sharedBy, personId],
            }
          : item,
      ),
    });

  const setAll = (itemId: string, all: boolean) =>
    update({
      items: bill.items.map((item) =>
        item.id === itemId ? { ...item, sharedBy: all ? everyone : [] } : item,
      ),
    });

  const splitEverythingEvenly = () =>
    update({ items: bill.items.map((item) => ({ ...item, sharedBy: everyone })) });

  const clearEverything = () =>
    update({ items: bill.items.map((item) => ({ ...item, sharedBy: [] })) });

  const exact = totals.unassignedCents === 0;
  const owing = totals.shares
    .filter((s) => s.totalCents !== 0)
    .sort((a, b) => b.totalCents - a.totalCents);
  const note = `${bill.merchant} — split with Payback`;
  const topOwing = owing[0];
  const topPerson = topOwing
    ? bill.people.find((p) => p.id === topOwing.personId)
    : undefined;

  return (
    <section className="mt-10 rounded border border-hair bg-raised">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hair px-4 py-3">
        <h2 className="font-prose text-base font-semibold text-bright">
          Splitting the bill — playable
        </h2>
        <p className="font-mono text-xs text-dim">ported from split.ts + money.ts</p>
      </header>

      <div className="px-4 py-4">
        <p className="max-w-[62ch] text-sm text-muted">
          Tap a name onto a line to put that person on it. A line with two names on it
          splits <em>evenly</em> between them, to the cent; tax and tip then ride along{" "}
          <em>proportionally</em>, weighted by what each person actually ordered — so
          the salad doesn&rsquo;t subsidise the ribeye. Every amount here is an integer
          number of cents.
        </p>

        {/* ------------------------------------------------ receipt + shares */}
        <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_16rem]">
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-mono text-xs text-faint">{bill.merchant.toLowerCase()}</p>
              <p className="font-mono text-xs text-faint tabular-nums">
                subtotal {formatCents(subtotal)}
              </p>
            </div>

            <ul className="mt-2 flex flex-col gap-1.5">
              {bill.items.map((item) => {
                const sharers = item.sharedBy;
                const claimed = sharers.length;
                const cut = claimed > 0 ? allocate(item.cents, sharers.map(() => 1)) : [];
                const uneven = cut.length > 1 && cut[0] !== cut[cut.length - 1];

                return (
                  <li
                    key={item.id}
                    className={`rounded-sm border px-3 py-2 ${
                      claimed === 0 ? "border-dashed border-hair bg-sunken" : "border-hair-soft"
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span
                        className={`truncate text-sm ${
                          claimed === 0 ? "text-dim" : "text-body"
                        }`}
                      >
                        {item.name}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-body tabular-nums">
                        {formatCents(item.cents)}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {bill.people.map((person) => {
                        const on = sharers.includes(person.id);
                        const color = PERSON_COLORS[person.color % PERSON_COLORS.length];
                        return (
                          <button
                            key={person.id}
                            type="button"
                            onClick={() => toggle(item.id, person.id)}
                            aria-pressed={on}
                            aria-label={`${person.name} on ${item.name}`}
                            className="rounded-sm border px-2 py-0.5 font-mono text-xs transition-colors"
                            style={
                              on
                                ? { borderColor: color, background: color, color: "#0a0d10" }
                                : { borderColor: "var(--color-hair)", color: "var(--color-dim)" }
                            }
                          >
                            {person.name}
                          </button>
                        );
                      })}

                      <button
                        type="button"
                        onClick={() => setAll(item.id, claimed !== bill.people.length)}
                        className="ml-auto rounded-sm px-1.5 py-0.5 font-mono text-xs text-faint transition-colors hover:text-body"
                      >
                        {claimed === bill.people.length ? "clear" : "all"}
                      </button>
                    </div>

                    {claimed > 1 && (
                      <p className="mt-1.5 font-mono text-xs text-faint tabular-nums">
                        ÷{claimed} ={" "}
                        {uneven ? (
                          <>
                            {cut.map(formatCents).join(" / ")}{" "}
                            <span className="text-warning">← remainder cent</span>
                          </>
                        ) : (
                          `${formatCents(cut[0])} each`
                        )}
                      </p>
                    )}
                    {claimed === 0 && (
                      <p className="mt-1.5 font-mono text-xs text-warning">
                        unclaimed — held out of everyone&rsquo;s total
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={splitEverythingEvenly}
                className="rounded-sm border border-hair px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:border-muted hover:text-body"
              >
                split everything evenly
              </button>
              <button
                type="button"
                onClick={clearEverything}
                className="rounded-sm border border-hair px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:border-muted hover:text-body"
              >
                unclaim all
              </button>
              <button
                type="button"
                onClick={() => {
                  setBill(demoBill());
                  setOpen(null);
                }}
                className="ml-auto rounded-sm border border-hair px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:border-muted hover:text-body"
              >
                reset
              </button>
            </div>
          </div>

          {/* ------------------------------------------------------- shares */}
          <div>
            <p className="font-mono text-xs text-faint">what each person owes</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {bill.people.map((person, i) => {
                const share = totals.shares[i];
                const color = PERSON_COLORS[person.color % PERSON_COLORS.length];
                const expanded = open === person.id;
                return (
                  <li key={person.id} className="rounded-sm border border-hair-soft">
                    <button
                      type="button"
                      onClick={() => setOpen(expanded ? null : person.id)}
                      aria-expanded={expanded}
                      className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left"
                    >
                      <span className="font-mono text-xs" style={{ color }}>
                        {person.name}
                      </span>
                      <span className="font-mono text-sm text-bright tabular-nums">
                        {formatCents(share.totalCents)}
                      </span>
                    </button>

                    {expanded && (
                      <div className="border-t border-hair-soft px-3 py-2">
                        <ul className="flex flex-col gap-1">
                          {share.lines.map((line) => (
                            <li
                              key={line.itemId}
                              className="flex justify-between gap-3 font-mono text-xs tabular-nums"
                            >
                              <span className="truncate text-dim">
                                {line.name}
                                {line.sharedWith > 1 && (
                                  <span className="text-faint"> ÷{line.sharedWith}</span>
                                )}
                              </span>
                              <span className="shrink-0 text-body">
                                {formatCents(line.cents)}
                              </span>
                            </li>
                          ))}
                          {share.lines.length === 0 && (
                            <li className="font-mono text-xs text-faint">nothing claimed</li>
                          )}
                        </ul>
                        <div className="mt-1.5 flex flex-col gap-1 border-t border-hair-soft pt-1.5">
                          <Row label="tax" cents={share.taxCents} penny={taxPenny[i]} />
                          <Row label="tip" cents={share.tipCents} penny={tipPenny[i]} />
                          {share.feeCents !== 0 && (
                            <Row label="fees" cents={share.feeCents} penny={false} />
                          )}
                          {share.discountCents !== 0 && (
                            <Row label="comp" cents={share.discountCents} penny={compPenny[i]} />
                          )}
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="mt-1.5 font-mono text-xs text-faint">tap a name for the breakdown</p>
          </div>
        </div>

        {/* --------------------------------------------------- tip + comp */}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-faint">tip</span>
          {TIP_PRESETS.map((pct) => {
            const active = bill.tipCents > 0 && tipPercent === pct;
            return (
              <button
                key={pct}
                type="button"
                onClick={() => update({ tipCents: percentOf(subtotal, pct) })}
                aria-pressed={active}
                className={`rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors ${
                  active
                    ? "border-accent text-accent"
                    : "border-hair text-dim hover:border-muted hover:text-body"
                }`}
              >
                {pct}%
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => update({ tipCents: 0 })}
            aria-pressed={bill.tipCents === 0}
            className={`rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors ${
              bill.tipCents === 0
                ? "border-accent text-accent"
                : "border-hair text-dim hover:border-muted hover:text-body"
            }`}
          >
            none
          </button>
          <button
            type="button"
            onClick={() =>
              update({ discountCents: bill.discountCents === 0 ? COMP_CENTS : 0 })
            }
            aria-pressed={bill.discountCents !== 0}
            className={`ml-auto rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors ${
              bill.discountCents !== 0
                ? "border-accent text-accent"
                : "border-hair text-dim hover:border-muted hover:text-body"
            }`}
          >
            comp −$10.00
          </button>
        </div>

        {/* -------------------------------------------------- the invariant */}
        <div className="mt-5 rounded-sm border border-hair bg-sunken px-3 py-3">
          <div className="grid gap-x-6 gap-y-1 font-mono text-xs tabular-nums sm:grid-cols-2">
            <Total label="items" cents={totals.subtotalCents} />
            <Total label="tax" cents={totals.taxCents} />
            <Total label="tip" cents={totals.tipCents} />
            {totals.discountCents !== 0 && (
              <Total label="comp" cents={totals.discountCents} />
            )}
            <Total label="bill total" cents={totals.billTotalCents} strong />
            <Total label="Σ everyone's shares" cents={totals.claimedTotalCents} strong />
          </div>

          <p
            className={`mt-2.5 border-t border-hair pt-2.5 font-mono text-xs ${
              exact ? "text-accent" : "text-warning"
            }`}
          >
            {exact
              ? "shares sum to the bill exactly — no cent lost, none invented"
              : `${formatCents(totals.unassignedCents)} of items are unclaimed, so the shares
                 are ${formatCents(totals.billTotalCents - totals.claimedTotalCents)} short of
                 the bill. Payback holds that out rather than spreading it silently.`}
          </p>
        </div>

        {/* ------------------------------------------------------- outputs */}
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div>
            <p className="font-mono text-xs text-faint">summaryText() — the copied message</p>
            <pre className="mt-2 overflow-x-auto rounded-sm border border-hair-soft bg-sunken px-3 py-2 font-mono text-xs whitespace-pre text-body">
              {summaryText(bill, totals)}
            </pre>
          </div>
          <div>
            <p className="font-mono text-xs text-faint">
              venmoLink() — prefilled, never auto-sent
            </p>
            <pre className="mt-2 overflow-x-auto rounded-sm border border-hair-soft bg-sunken px-3 py-2 font-mono text-xs whitespace-pre text-body">
              {topPerson && topOwing
                ? venmoWebLink(topPerson, topOwing.totalCents, note)
                : "— nothing claimed yet"}
            </pre>
          </div>
        </div>

        <p className="mt-4 max-w-[62ch] font-mono text-xs text-faint">
          The real app fills this bill in by photographing the receipt; the scan step and
          localStorage persistence are left out here. The arithmetic is the shipped
          arithmetic, line for line.
        </p>
      </div>
    </section>
  );
}

function Row({ label, cents, penny }: { label: string; cents: number; penny: boolean }) {
  return (
    <div className="flex justify-between gap-3 font-mono text-xs tabular-nums">
      <span className="text-faint">
        {label}
        {penny && cents !== 0 && <span className="text-warning"> +1¢</span>}
      </span>
      <span className="text-dim">{formatCents(cents)}</span>
    </div>
  );
}

function Total({
  label,
  cents,
  strong = false,
}: {
  label: string;
  cents: number;
  strong?: boolean;
}) {
  return (
    <div className="flex justify-between gap-3">
      <span className={strong ? "text-body" : "text-faint"}>{label}</span>
      <span className={strong ? "text-bright" : "text-dim"}>{formatCents(cents)}</span>
    </div>
  );
}
