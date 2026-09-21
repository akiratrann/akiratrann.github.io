"use client";

import { useMemo, useState } from "react";

/*
  Alter Grab's fare and commission engine, running in the browser.

  Every constant, rounding rule and ordering below is transcribed from
  packages/shared/src/fare.ts — the rate cards, DEFAULT_COMMISSION_POLICY, the
  surge-on-metered-only rule, the minimum-fare floor, and the split that decides
  what the earner actually receives. The surge ladder comes from
  apps/backend/src/pricing/pricing.service.ts, the delivery-fee formula from the
  same file, the 25% incumbent comparison from apps/web/src/components/
  FareBreakdown.tsx, and the menu prices from apps/backend/prisma/seed.ts.

  Money is integer minor units throughout, exactly as the backend holds it. VND
  has no subunit, so one minor unit is ₫1 and nothing here ever divides by 100.

  Pure functions, no mutation of prior state, no network — the engine is small
  enough to port whole, so the numbers on screen are the numbers the API returns.
*/

/* ---- packages/shared/src/money.ts -------------------------------------- */

type Minor = number;

/** Round half-up to whole minor units. */
const roundMinor = (value: number): Minor => Math.round(value);

/** Take a percentage (0-100) of a minor amount, rounded. */
const pctOf = (amount: Minor, pct: number): Minor => roundMinor((amount * pct) / 100);

const vnd = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});
const money = (m: Minor) => vnd.format(m);

/* ---- packages/shared/src/fare.ts --------------------------------------- */

type RideClass = "BIKE" | "ECONOMY" | "COMFORT" | "XL";

interface RideRateCard {
  baseFare: Minor; // flag-down fare
  perKm: Minor;
  perMinute: Minor;
  minFare: Minor; // fare floor
  bookingFee: Minor; // fixed platform booking fee
}

interface CommissionPolicy {
  ridesCommissionPct: number;
  foodCommissionPct: number;
  processingPct: number; // Stripe-style percent per charge
  processingFixed: Minor; // plus a fixed fee per charge
  processingAbsorbedByPlatform: boolean;
}

/*
  DB-backed and editable in the admin dashboard; these are the defaults that
  ship in fare.ts and in the Prisma schema. The header comment there sets them
  against the market: Grab takes ~25-28% from drivers in Vietnam (effective up
  to ~32.8% incl. VAT), GrabFood ~25-30% from merchants.
*/
const DEFAULT_COMMISSION_POLICY: CommissionPolicy = {
  ridesCommissionPct: 15,
  foodCommissionPct: 18,
  processingPct: 2.9,
  processingFixed: 2000,
  processingAbsorbedByPlatform: true,
};

/** Whole đồng. Deliberately set just under Grab VN's published 2026 rates. */
const DEFAULT_RIDE_RATE_CARDS: Record<RideClass, RideRateCard> = {
  BIKE: { baseFare: 5000, perKm: 4000, perMinute: 150, minFare: 11000, bookingFee: 2000 },
  ECONOMY: { baseFare: 12000, perKm: 7500, perMinute: 300, minFare: 22000, bookingFee: 3000 },
  COMFORT: { baseFare: 15000, perKm: 9500, perMinute: 400, minFare: 27000, bookingFee: 4000 },
  XL: { baseFare: 18000, perKm: 9500, perMinute: 400, minFare: 29000, bookingFee: 5000 },
};

interface Fare {
  baseFare: Minor;
  distanceCharge: Minor;
  timeCharge: Minor;
  bookingFee: Minor;
  gross: Minor; // total charged to the rider, excluding tip
  tip: Minor; // paid 100% to the earner
  platformFee: Minor;
  processingFee: Minor;
  processingFeeBorneBy: "platform" | "earner";
  driverPayout: Minor; // what the earner actually receives, incl. tip
  commissionPct: number;
}

/**
 * computeRideFare. Surge multiplies the metered portion only — never the fixed
 * booking fee — and the minimum fare is applied after, as a floor on gross.
 */
function computeRideFare(input: {
  rideClass: RideClass;
  distanceMeters: number;
  durationSeconds: number;
  surgeMultiplier?: number;
  tip?: Minor;
  policy?: CommissionPolicy;
}): Fare {
  const policy = input.policy ?? DEFAULT_COMMISSION_POLICY;
  const rateCard = DEFAULT_RIDE_RATE_CARDS[input.rideClass];
  const surge = input.surgeMultiplier ?? 1.0;
  const tip = input.tip ?? 0;

  const km = input.distanceMeters / 1000;
  const minutes = input.durationSeconds / 60;

  const baseFare = rateCard.baseFare;
  const distanceCharge = roundMinor(rateCard.perKm * km);
  const timeCharge = roundMinor(rateCard.perMinute * minutes);
  const bookingFee = rateCard.bookingFee;

  const meteredBeforeSurge = baseFare + distanceCharge + timeCharge;
  const meteredAfterSurge = roundMinor(meteredBeforeSurge * surge);
  const subtotal = meteredAfterSurge + bookingFee;

  const gross = Math.max(subtotal, rateCard.minFare);

  return splitBreakdown({
    parts: { baseFare, distanceCharge, timeCharge, bookingFee, gross, tip },
    commissionPct: policy.ridesCommissionPct,
    policy,
  });
}

/**
 * computeFoodFare. The commission applies to the merchant's items total — that
 * is what the incumbents take from restaurants — while the delivery fee and the
 * whole tip go to the courier.
 */
function computeFoodFare(input: {
  itemsTotal: Minor;
  deliveryFee: Minor;
  tip?: Minor;
  policy?: CommissionPolicy;
}): Fare & { merchantPayout: Minor } {
  const policy = input.policy ?? DEFAULT_COMMISSION_POLICY;
  const tip = input.tip ?? 0;
  const { itemsTotal, deliveryFee } = input;

  const gross = itemsTotal + deliveryFee;
  const platformFee = pctOf(itemsTotal, policy.foodCommissionPct);
  const processingFee = roundMinor(pctOf(gross, policy.processingPct) + policy.processingFixed);

  return {
    baseFare: 0,
    distanceCharge: 0,
    timeCharge: 0,
    bookingFee: 0,
    gross,
    tip,
    platformFee,
    processingFee,
    processingFeeBorneBy: policy.processingAbsorbedByPlatform ? "platform" : "earner",
    merchantPayout: itemsTotal - platformFee,
    driverPayout: deliveryFee + tip, // the courier keeps delivery fee + tip
    commissionPct: policy.foodCommissionPct,
  };
}

function splitBreakdown(args: {
  parts: {
    baseFare: Minor;
    distanceCharge: Minor;
    timeCharge: Minor;
    bookingFee: Minor;
    gross: Minor;
    tip: Minor;
  };
  commissionPct: number;
  policy: CommissionPolicy;
}): Fare {
  const { parts, commissionPct, policy } = args;
  const platformFee = pctOf(parts.gross, commissionPct);
  const processingFee = roundMinor(
    pctOf(parts.gross, policy.processingPct) + policy.processingFixed,
  );

  // When the platform absorbs processing it comes out of the commission, so the
  // payout is simply gross − platformFee. Otherwise it reduces the payout.
  const driverPayout = policy.processingAbsorbedByPlatform
    ? parts.gross - platformFee + parts.tip
    : parts.gross - platformFee - processingFee + parts.tip;

  return {
    baseFare: parts.baseFare,
    distanceCharge: parts.distanceCharge,
    timeCharge: parts.timeCharge,
    bookingFee: parts.bookingFee,
    gross: parts.gross,
    tip: parts.tip,
    platformFee,
    processingFee,
    processingFeeBorneBy: policy.processingAbsorbedByPlatform ? "platform" : "earner",
    driverPayout,
    commissionPct,
  };
}

/**
 * recomputeSplit — re-split an existing fare at a different commission without
 * touching what the rider pays. dispatch.service.ts calls this with 0 when a
 * driver on the flat-fee Pro plan accepts: their cut goes to zero, the rider's
 * total is unchanged.
 */
function recomputeSplit(fare: Fare, commissionPct: number): Fare {
  const platformFee = pctOf(fare.gross, commissionPct);
  const earnerBearsProcessing = fare.processingFeeBorneBy === "earner";
  const driverPayout =
    fare.gross - platformFee - (earnerBearsProcessing ? fare.processingFee : 0) + fare.tip;
  return { ...fare, platformFee, commissionPct, driverPayout };
}

/* ---- apps/backend/src/pricing/pricing.service.ts ------------------------ */

/*
  getSurge() is supply/demand driven, not clock driven: it compares pending
  requests against drivers within 5 km and only ever returns one of three
  values. "Deliberately conservative — low, transparent pricing is the product."
*/
const SURGE_TIERS: { value: number; when: string }[] = [
  { value: 1.0, when: "pending ≤ 1.5× nearby drivers" },
  { value: 1.25, when: "pending > 1.5× nearby drivers" },
  { value: 1.5, when: "pending > 3×, or no driver within 5 km" },
];

/** Delivery fee, kept under Grab VN's ~₫15,000–25,000 on purpose. */
const deliveryFeeFor = (distanceMeters: number): Minor =>
  Math.round(12000 + (distanceMeters / 1000) * 2500);

/** Flat-fee Pro plan, PRO_MONTHLY_FEE_MINOR in configuration.ts. */
const PRO_MONTHLY_FEE: Minor = 490000;

/* ---- apps/web/src/components/FareBreakdown.tsx -------------------------- */

/** The shipped component's comparison: ~25% Grab VN driver take (up to ~28%). */
const INCUMBENT_PCT = 25;
const incumbentFeeFor = (gross: Minor): Minor => Math.round(gross * (INCUMBENT_PCT / 100));

/* ---- apps/backend/prisma/seed.ts --------------------------------------- */

const MENU: { name: string; priceMinor: Minor }[] = [
  { name: "Phở Bò Tái", priceMinor: 55000 },
  { name: "Bún Bò Huế", priceMinor: 60000 },
  { name: "Cơm Tấm Sườn Bì Chả", priceMinor: 50000 },
  { name: "Gỏi Cuốn (2 cuốn)", priceMinor: 35000 },
  { name: "Cà Phê Sữa Đá", priceMinor: 25000 },
  { name: "Trà Đá", priceMinor: 5000 },
];

/* ---- view --------------------------------------------------------------- */

type Service = "RIDE" | "FOOD";
type Line = { label: string; note?: string; value: Minor };

export function FareBreakdown() {
  const [service, setService] = useState<Service>("RIDE");
  const [rideClass, setRideClass] = useState<RideClass>("ECONOMY");
  const [distanceMeters, setDistanceMeters] = useState(5000);
  const [durationSeconds, setDurationSeconds] = useState(900);
  const [surge, setSurge] = useState(1.0);
  const [tip, setTip] = useState(0);
  const [pro, setPro] = useState(false);
  const [cart, setCart] = useState<number[]>([1, 0, 1, 0, 1, 0]);

  const view = useMemo(() => {
    if (service === "RIDE") {
      const card = DEFAULT_RIDE_RATE_CARDS[rideClass];
      const raw = computeRideFare({
        rideClass,
        distanceMeters,
        durationSeconds,
        surgeMultiplier: surge,
        tip,
      });
      // dispatch.service.ts re-splits at 0% the moment a Pro driver accepts.
      const fare = pro ? recomputeSplit(raw, 0) : raw;

      const metered = fare.baseFare + fare.distanceCharge + fare.timeCharge;
      const surgeUplift = roundMinor(metered * surge) - metered;
      const floorTopUp = fare.gross - (roundMinor(metered * surge) + fare.bookingFee);

      const lines: Line[] = [
        { label: "Base fare", note: "flag-down", value: fare.baseFare },
        {
          label: "Distance",
          note: `${(distanceMeters / 1000).toFixed(1)} km × ${money(card.perKm)}/km`,
          value: fare.distanceCharge,
        },
        {
          label: "Time",
          note: `${(durationSeconds / 60).toFixed(0)} min × ${money(card.perMinute)}/min`,
          value: fare.timeCharge,
        },
      ];
      if (surgeUplift > 0) {
        lines.push({
          label: "Surge uplift",
          note: `${surge}× on the metered portion only`,
          value: surgeUplift,
        });
      }
      lines.push({ label: "Booking fee", note: "fixed, never surged", value: fare.bookingFee });
      if (floorTopUp > 0) {
        lines.push({
          label: "Minimum fare top-up",
          note: `floor of ${money(card.minFare)} for ${rideClass}`,
          value: floorTopUp,
        });
      }

      return {
        fare,
        lines,
        merchantPayout: null as Minor | null,
        earnerTotal: fare.driverPayout,
        earnerLabel: "The driver receives",
        grossLabel: "Rider pays",
        feeBase: fare.gross,
        feeBaseLabel: "of the fare",
      };
    }

    const itemsTotal = cart.reduce((sum, qty, i) => sum + qty * MENU[i].priceMinor, 0);
    const deliveryFee = deliveryFeeFor(distanceMeters);
    const fare = computeFoodFare({ itemsTotal, deliveryFee, tip });

    const lines: Line[] = MENU.map((item, i) => ({
      label: `${cart[i]} × ${item.name}`,
      value: cart[i] * item.priceMinor,
    })).filter((_, i) => cart[i] > 0);
    lines.push({
      label: "Delivery fee",
      note: "₫12,000 + ₫2,500/km · paid to the courier",
      value: deliveryFee,
    });

    return {
      fare,
      lines,
      merchantPayout: fare.merchantPayout,
      earnerTotal: fare.merchantPayout + fare.driverPayout,
      earnerLabel: "Merchant + courier receive",
      grossLabel: "Customer pays",
      feeBase: itemsTotal,
      feeBaseLabel: "of the items total",
    };
  }, [service, rideClass, distanceMeters, durationSeconds, surge, tip, pro, cart]);

  const { fare } = view;
  const total = fare.gross + fare.tip;
  const incumbentFee = incumbentFeeFor(fare.gross);
  const saved = incumbentFee - fare.platformFee;
  const incumbentEarnerTotal = view.earnerTotal - saved;

  // The take rate as a share of everything the customer is charged, which is
  // what the headline percentage means to a driver. On food it lands below the
  // nominal 18% because the delivery fee is never commissioned.
  const effectivePct = fare.gross > 0 ? (fare.platformFee / fare.gross) * 100 : 0;

  // processingAbsorbedByPlatform is true, so the processor is paid out of the
  // commission. On small fares that leaves the platform underwater.
  const platformNet = fare.platformFee - fare.processingFee;

  const setQty = (index: number, qty: number) =>
    setCart((c) => c.map((v, i) => (i === index ? Math.max(0, Math.min(9, qty)) : v)));

  return (
    <section className="mt-10 rounded border border-hair bg-raised">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hair px-4 py-3">
        <h2 className="font-prose text-base font-semibold text-bright">
          Fare and commission — live
        </h2>
        <p className="font-mono text-xs text-dim">ported from fare.ts</p>
      </header>

      <div className="px-4 py-4">
        <p className="max-w-[62ch] text-sm text-muted">
          The engine that splits every trip. It runs in integer đồng, the same way the
          backend stores it, and writes the identical itemised breakdown into the rider
          app and the driver app — nobody sees a different number. Move the inputs and
          watch what the earner keeps against a 25% incumbent.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="flex gap-1" role="group" aria-label="Service">
            {(["RIDE", "FOOD"] as Service[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setService(s)}
                aria-pressed={service === s}
                className={`rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors ${
                  service === s
                    ? "border-accent text-accent"
                    : "border-hair text-dim hover:border-muted hover:text-body"
                }`}
              >
                {s === "RIDE" ? "ride" : "food"}
              </button>
            ))}
          </div>
          <span className="font-mono text-xs text-faint">
            policy default {service === "RIDE" ? "15%" : "18%"} · incumbent {INCUMBENT_PCT}%
          </span>
        </div>

        {/* ---- inputs ---- */}
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-3">
            {service === "RIDE" && (
              <div>
                <p className="font-mono text-xs text-faint">ride class</p>
                <div className="mt-1.5 flex flex-wrap gap-1" role="group" aria-label="Ride class">
                  {(Object.keys(DEFAULT_RIDE_RATE_CARDS) as RideClass[]).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setRideClass(c)}
                      aria-pressed={rideClass === c}
                      className={`rounded-sm border px-2 py-1 font-mono text-xs transition-colors ${
                        rideClass === c
                          ? "border-accent text-accent"
                          : "border-hair text-dim hover:border-muted hover:text-body"
                      }`}
                    >
                      {c.toLowerCase()}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <Slider
              label={service === "RIDE" ? "distance" : "delivery distance"}
              display={`${(distanceMeters / 1000).toFixed(1)} km`}
              min={500}
              max={25000}
              step={250}
              value={distanceMeters}
              onChange={setDistanceMeters}
            />

            {service === "RIDE" && (
              <Slider
                label="duration"
                display={`${Math.round(durationSeconds / 60)} min`}
                min={60}
                max={3600}
                step={30}
                value={durationSeconds}
                onChange={setDurationSeconds}
              />
            )}

            <Slider
              label="tip — 100% to the earner"
              display={money(tip)}
              min={0}
              max={50000}
              step={5000}
              value={tip}
              onChange={setTip}
            />
          </div>

          <div className="flex flex-col gap-3">
            {service === "RIDE" ? (
              <>
                <div>
                  <p className="font-mono text-xs text-faint">surge — supply vs demand</p>
                  <div className="mt-1.5 flex flex-wrap gap-1" role="group" aria-label="Surge">
                    {SURGE_TIERS.map((t) => (
                      <button
                        key={t.value}
                        type="button"
                        onClick={() => setSurge(t.value)}
                        aria-pressed={surge === t.value}
                        className={`rounded-sm border px-2 py-1 font-mono text-xs transition-colors ${
                          surge === t.value
                            ? "border-accent text-accent"
                            : "border-hair text-dim hover:border-muted hover:text-body"
                        }`}
                      >
                        {t.value.toFixed(2)}×
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 font-mono text-xs text-faint">
                    {SURGE_TIERS.find((t) => t.value === surge)?.when}
                  </p>
                </div>

                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={pro}
                    onChange={(e) => setPro(e.target.checked)}
                    className="mt-0.5 accent-[#5fc98d]"
                  />
                  <span className="font-mono text-xs text-dim">
                    driver on the Pro plan
                    <span className="mt-0.5 block text-faint">
                      {money(PRO_MONTHLY_FEE)}/month flat, commission re-split to 0% on
                      accept. The rider&rsquo;s total never changes.
                    </span>
                  </span>
                </label>
              </>
            ) : (
              <div>
                <p className="font-mono text-xs text-faint">basket — Quán Ngon Sài Gòn</p>
                <div className="mt-1.5 flex flex-col gap-1">
                  {MENU.map((item, i) => (
                    <div key={item.name} className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setQty(i, cart[i] - 1)}
                        aria-label={`One fewer ${item.name}`}
                        className="rounded-sm border border-hair px-1.5 font-mono text-xs text-dim transition-colors hover:border-muted hover:text-body"
                      >
                        −
                      </button>
                      <span className="w-4 text-center font-mono text-xs tabular-nums text-body">
                        {cart[i]}
                      </span>
                      <button
                        type="button"
                        onClick={() => setQty(i, cart[i] + 1)}
                        aria-label={`One more ${item.name}`}
                        className="rounded-sm border border-hair px-1.5 font-mono text-xs text-dim transition-colors hover:border-muted hover:text-body"
                      >
                        +
                      </button>
                      <span className="truncate text-xs text-dim">{item.name}</span>
                      <span className="ml-auto font-mono text-xs tabular-nums text-faint">
                        {money(item.priceMinor)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ---- breakdown ---- */}
        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <div className="overflow-x-auto">
            <p className="font-mono text-xs text-faint">what the customer is charged</p>
            <dl className="mt-2 flex min-w-[17rem] flex-col gap-1.5">
              {view.lines.map((l) => (
                <div key={l.label} className="flex items-baseline justify-between gap-4">
                  <dt className="text-xs text-dim">
                    {l.label}
                    {l.note && <span className="block font-mono text-xs text-faint">{l.note}</span>}
                  </dt>
                  <dd className="shrink-0 font-mono text-xs tabular-nums text-body">
                    {money(l.value)}
                  </dd>
                </div>
              ))}
              <div className="mt-1 border-t border-hair pt-1.5" />
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-xs text-muted">{view.grossLabel}</dt>
                <dd className="shrink-0 font-mono text-xs tabular-nums text-bright">
                  {money(fare.gross)}
                </dd>
              </div>
              {fare.tip > 0 && (
                <>
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-xs text-dim">Tip</dt>
                    <dd className="shrink-0 font-mono text-xs tabular-nums text-body">
                      {money(fare.tip)}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-xs text-muted">Total charged</dt>
                    <dd className="shrink-0 font-mono text-xs tabular-nums text-bright">
                      {money(total)}
                    </dd>
                  </div>
                </>
              )}
            </dl>
          </div>

          <div className="overflow-x-auto">
            <p className="font-mono text-xs text-faint">how it splits</p>
            <dl className="mt-2 flex min-w-[17rem] flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-xs text-dim">
                  Platform fee
                  <span className="block font-mono text-xs text-faint">
                    {fare.commissionPct}% {view.feeBaseLabel} ({money(view.feeBase)})
                  </span>
                </dt>
                <dd className="shrink-0 font-mono text-xs tabular-nums text-body">
                  {money(fare.platformFee)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-xs text-dim">
                  Card processing
                  <span className="block font-mono text-xs text-faint">
                    2.9% + ₫2,000 · absorbed by the platform
                  </span>
                </dt>
                <dd className="shrink-0 font-mono text-xs tabular-nums text-faint">
                  {money(fare.processingFee)}
                </dd>
              </div>
              {view.merchantPayout !== null && (
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-xs text-dim">Merchant keeps</dt>
                  <dd className="shrink-0 font-mono text-xs tabular-nums text-body">
                    {money(view.merchantPayout)}
                  </dd>
                </div>
              )}
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-xs text-dim">
                  {view.merchantPayout !== null ? "Courier keeps" : "Driver payout"}
                  {fare.tip > 0 && (
                    <span className="block font-mono text-xs text-faint">tip included in full</span>
                  )}
                </dt>
                <dd className="shrink-0 font-mono text-xs tabular-nums text-body">
                  {money(fare.driverPayout)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-xs text-dim">Platform nets</dt>
                <dd
                  className={`shrink-0 font-mono text-xs tabular-nums ${
                    platformNet < 0 ? "text-error" : "text-body"
                  }`}
                >
                  {money(platformNet)}
                </dd>
              </div>
              {platformNet < 0 && (
                <p className="font-mono text-xs text-warning">
                  The fixed ₫2,000 processing fee outruns the commission — the platform
                  loses money on this trip and the earner is untouched.
                </p>
              )}
            </dl>
          </div>
        </div>

        {/* ---- the argument ---- */}
        <div className="mt-6 rounded-sm border border-hair-soft bg-sunken p-4">
          <p className="font-mono text-xs text-faint">{view.earnerLabel}</p>
          <p className="mt-1 font-mono text-3xl tabular-nums text-accent">
            {money(view.earnerTotal)}
          </p>
          <p className="mt-1 font-mono text-xs text-dim">
            {effectivePct.toFixed(1)}% effective take on {money(total)} charged
            {pro && service === "RIDE" ? " · Pro plan, 0% commission" : ""}
          </p>

          <div className="mt-4 flex flex-col gap-3">
            <SplitBar
              label={`Alter Grab · ${fare.commissionPct}%`}
              earner={view.earnerTotal}
              fee={fare.platformFee}
              total={Math.max(total, 1)}
              tone="accent"
            />
            <SplitBar
              label={`Incumbent · ${INCUMBENT_PCT}%`}
              earner={incumbentEarnerTotal}
              fee={incumbentFee}
              total={Math.max(total, 1)}
              tone="muted"
            />
          </div>

          {saved > 0 && (
            <p className="mt-3 max-w-[62ch] text-sm text-muted">
              Same trip on a 25%-commission app pays the earner{" "}
              <span className="font-mono text-xs tabular-nums text-body">
                {money(incumbentEarnerTotal)}
              </span>
              . The difference,{" "}
              <span className="font-mono text-xs tabular-nums text-accent">{money(saved)}</span>, is
              the product — and it is the line the rider sees too, not a figure buried in a
              partner dashboard.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function Slider({
  label,
  display,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  display: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-3 font-mono text-xs">
        <span className="text-dim">{label}</span>
        <span className="tabular-nums text-body">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-sm bg-sunken accent-[#5fc98d]"
      />
    </label>
  );
}

/** Gross split into what the earner keeps and what the platform takes. */
function SplitBar({
  label,
  earner,
  fee,
  total,
  tone,
}: {
  label: string;
  earner: Minor;
  fee: Minor;
  total: Minor;
  tone: "accent" | "muted";
}) {
  const pct = (v: Minor) => Math.max(0, Math.min(100, (v / total) * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 font-mono text-xs">
        <span className="text-dim">{label}</span>
        <span className="tabular-nums text-faint">
          {money(earner)} earner · {money(fee)} platform
        </span>
      </div>
      <div className="mt-1 flex h-2 w-full overflow-hidden rounded-sm bg-sunken">
        <div
          className={`h-full transition-[width] duration-200 motion-reduce:transition-none ${
            tone === "accent" ? "bg-accent" : "bg-muted"
          }`}
          style={{ width: `${pct(earner)}%` }}
        />
        <div
          className="h-full bg-faint transition-[width] duration-200 motion-reduce:transition-none"
          style={{ width: `${pct(fee)}%` }}
        />
      </div>
    </div>
  );
}
