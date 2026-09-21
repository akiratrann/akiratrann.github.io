"use client";

import { useMemo, useState } from "react";

/*
  A browser port of the rhbot backtester, running the strategy the live bot
  actually runs.

  Three files supply the logic, unchanged in substance:
    rhbot/strategy/slope_reversal.py — the entry/exit rule and its warmup
    rhbot/indicators.py              — sma(), including the None-aligned head
    rhbot/backtest.py                — run_backtest(): slippage, bar cooldown,
                                       mark-to-market equity, drawdown, win
                                       counting, PDT day-trade counting
  Two risk gates live in the engine rather than the backtester, and are layered
  on here in the same order the engine applies them:
    rhbot/engine.py  — max_hold_days forces an exit; never_sell_at_loss then
                       refuses any exit below cost * (1 + min_profit_pct/100),
                       which overrides the hold cap.
  Defaults come from config.live.yaml and rhbot/config.py.

  The PRICES ARE SYNTHETIC — a seeded random walk whose shape is ported from
  SyntheticFeed in rhbot/data/feed.py. Nothing here is market data and nothing
  here is a result. It shows how the rule behaves, not how it performed.
*/

/* ---- constants lifted from the source ---------------------------------- */

/** run_backtest(starting_cash=10_000.0) — rhbot/backtest.py. */
const STARTING_CASH = 10_000;
/** 2 bps per side, "measured from live fills" (research_holdlimit.py COST). */
const DEFAULT_SLIPPAGE_BPS = 2;
/** RiskConfig.min_profit_pct — 0.05% clears the ~2bps-per-side round trip. */
const MIN_PROFIT_PCT = 0.05;
/** sweep.py trims the daily series to the last ~3 years before scoring. */
const BAR_COUNT = 750;
/** sweep.py synth_bars(): SyntheticFeed(seed=7, base_prices={"TEST": 150.0}). */
const BASE_PRICE = 150;
const DEFAULT_SEED = 7;

/** min_slope_pct values that appear in the sweep grid and in config.live.yaml. */
const DEADBANDS = [0, 0.001, 0.002, 0.005, 0.01];
/** research_holdlimit.py LIMITS = [1, 2, 3, 5, 10, None]. */
const HOLD_LIMITS: (number | null)[] = [1, 2, 3, 5, 10, null];

/**
 * Per-symbol parameter sets from config.live.yaml. Each pair was tuned on that
 * symbol's real daily bars in a walk-forward split; here they only serve as
 * realistic starting points on a series they were never fitted to.
 */
const PRESETS: { symbol: string; smooth: number; deadband: number }[] = [
  { symbol: "SMCI", smooth: 2, deadband: 0.01 },
  { symbol: "SHOP", smooth: 8, deadband: 0.002 },
  { symbol: "META", smooth: 3, deadband: 0.002 },
  { symbol: "MSFT", smooth: 3, deadband: 0.005 },
  { symbol: "UNH", smooth: 8, deadband: 0.002 },
  { symbol: "LMT", smooth: 1, deadband: 0.01 },
  { symbol: "SNOW", smooth: 2, deadband: 0.01 },
  { symbol: "VZ", smooth: 2, deadband: 0.005 },
];

/* ---- indicators (rhbot/indicators.py) ---------------------------------- */

/** sma() — running sum, null for the leading positions where it is undefined. */
function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let running = 0;
  for (let i = 0; i < values.length; i++) {
    running += values[i];
    if (i >= period) running -= values[i - period];
    if (i >= period - 1) out[i] = running / period;
  }
  return out;
}

/* ---- the strategy (rhbot/strategy/slope_reversal.py) ------------------- */

type SignalType = "enter" | "exit" | "hold";

/**
 * SlopeReversal.evaluate, one bar at a time.
 *
 * The engine calls it with a growing window and the strategy re-smooths that
 * window each time; because the SMA is causal, smoothing the whole series once
 * and indexing into it gives bit-identical values at every bar, so this takes
 * the precomputed `line` instead of re-running it 750 times.
 *
 *   slope[t] = line[t] - line[t-1]
 *   slope +→− (a local top)    => EXIT_LONG  if holding
 *   slope −→+ (a local bottom) => ENTER_LONG if flat
 * with a deadband of min_slope_pct * last close, so a flip has to be a real
 * move rather than a rounding error.
 */
function slopeReversalSignal(
  line: (number | null)[],
  closes: number[],
  i: number,
  minSlopePct: number,
  holding: boolean,
): SignalType {
  const a = line[i - 2];
  const b = line[i - 1];
  const c = line[i];
  if (a === null || b === null || c === null) return "hold";
  const slopeNow = c - b;
  const slopePrev = b - a;
  const deadband = minSlopePct * (closes[i] || 1);

  if (slopePrev > 0 && slopeNow < -deadband) return holding ? "exit" : "hold";
  if (slopePrev < 0 && slopeNow > deadband) return holding ? "hold" : "enter";
  return "hold";
}

/* ---- synthetic prices (rhbot/data/feed.py SyntheticFeed) --------------- */

type Bar = { day: string; open: number; high: number; low: number; close: number };

/** Small deterministic PRNG. Python's Mersenne Twister is not reproducible here. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller, standing in for random.gauss(0, sigma). */
function gaussFrom(rnd: () => number): (sigma: number) => number {
  return (sigma: number) => {
    const u = Math.max(rnd(), 1e-12);
    const v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigma;
  };
}

/**
 * SyntheticFeed._ensure, term for term:
 *   drift = sin(i / 8) * 0.002     a slow wobble so the walk is not pure noise
 *   shock = gauss(0, 0.01)         1% per-bar volatility
 *   price = max(0.01, price * (1 + drift + shock))
 *   open  = price * (1 + uniform(-0.002, 0.002))
 * Timestamps are spaced one trading day apart, which is what `bar_interval: 1d`
 * means for every equity in the live config.
 */
function syntheticBars(count: number, seed: number): Bar[] {
  const rnd = mulberry32(seed);
  const gauss = gaussFrom(rnd);
  const bars: Bar[] = [];
  let price = BASE_PRICE;
  const cursor = new Date(Date.UTC(2022, 0, 3)); // a Monday
  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 8) * 0.002;
    const shock = gauss(0.01);
    price = Math.max(0.01, price * (1 + drift + shock));
    const open = price * (1 + (rnd() * 0.004 - 0.002));
    bars.push({
      day: cursor.toISOString().slice(0, 10),
      open,
      high: Math.max(open, price),
      low: Math.min(open, price),
      close: price,
    });
    cursor.setUTCDate(cursor.getUTCDate() + (cursor.getUTCDay() === 5 ? 3 : 1));
  }
  return bars;
}

/* ---- the backtest (rhbot/backtest.py + the engine's two gates) --------- */

type ExitReason = "signal" | "max hold" | "open";

type Trade = {
  id: number;
  entryIndex: number;
  exitIndex: number | null;
  entryFill: number;
  exitFill: number | null;
  barsHeld: number;
  reason: ExitReason;
  returnPct: number;
  win: boolean;
};

type Marker = { i: number; price: number; kind: "entry" | "exit" | "forced" | "refused" };

type Params = {
  smooth: number;
  deadband: number;
  maxHoldDays: number | null;
  neverSellAtLoss: boolean;
  cooldownBars: number;
  slippageBps: number;
  orderNotional: number;
};

type Result = {
  warmup: number;
  equity: number[];
  hold: number[];
  markers: Marker[];
  trades: Trade[];
  returnPct: number;
  holdPct: number;
  maxDrawdownPct: number;
  roundTrips: number;
  wins: number;
  dayTrades: number;
  refusedExits: number;
  forcedExits: number;
  openUnrealizedPct: number | null;
  endEquity: number;
};

function runBacktest(bars: Bar[], p: Params): Result {
  const closes = bars.map((b) => b.close);
  const line = p.smooth > 1 ? sma(closes, p.smooth) : closes.map((c) => c as number | null);
  const slip = p.slippageBps / 10_000;

  // SlopeReversal.warmup_bars = smooth + 3; run_backtest starts at max(warmup, 2).
  const warmup = Math.max(p.smooth + 3, 2);

  let cash = STARTING_CASH;
  let qty = 0;
  let entryFill = 0;
  let entryIndex = -1;
  let entryDay: string | null = null;
  let barsHeld = 0;
  let lastTradeIndex: number | null = null;

  let peakEquity = STARTING_CASH;
  let maxDd = 0;
  let roundTrips = 0;
  let wins = 0;
  let dayTrades = 0;
  let refusedExits = 0;
  let forcedExits = 0;
  let refusedLastBar = false;

  const equity: number[] = [];
  const hold: number[] = [];
  const markers: Marker[] = [];
  const trades: Trade[] = [];
  const holdBase = closes[warmup];

  for (let i = warmup; i < bars.length; i++) {
    const price = closes[i];
    const holding = qty > 0;
    let signal = slopeReversalSignal(line, closes, i, p.deadband, holding);
    let forcedThisBar = false;

    if (holding) barsHeld += 1;

    // engine.py: a time-based exit that overrides the strategy. An overnight
    // hold is not a day trade, so capping the hold stays PDT-safe.
    if (p.maxHoldDays !== null && holding && signal !== "exit" && barsHeld >= p.maxHoldDays) {
      signal = "exit";
      forcedThisBar = true;
    }

    // engine.py: "every sell must make money". This runs AFTER the hold cap and
    // silently beats it — an underwater position is held past its limit.
    if (p.neverSellAtLoss && signal === "exit" && holding) {
      const floor = entryFill * (1 + MIN_PROFIT_PCT / 100);
      if (price < floor) {
        refusedExits += 1;
        // Once a held position is underwater past its hold cap it refuses an
        // exit on every single bar, so only the first bar of each refused
        // stretch is marked. The engine throttles its own log line the same
        // way — the counter below is the honest total.
        if (!refusedLastBar) markers.push({ i, price, kind: "refused" });
        refusedLastBar = true;
        signal = "hold";
        forcedThisBar = false;
      } else {
        refusedLastBar = false;
      }
    } else {
      refusedLastBar = false;
    }

    // Mark-to-market equity, recorded on every evaluated bar (run_backtest).
    const mark = cash + qty * price;
    equity.push(mark);
    hold.push((STARTING_CASH * price) / holdBase);
    peakEquity = Math.max(peakEquity, mark);
    if (peakEquity > 0) maxDd = Math.max(maxDd, ((peakEquity - mark) / peakEquity) * 100);

    if (signal === "hold") continue;

    // Frequency governor, in bars. Live this is min_seconds_between_trades;
    // on daily bars 900s rounds to zero bars, so 0 is the faithful default.
    if (
      p.cooldownBars > 0 &&
      lastTradeIndex !== null &&
      i - lastTradeIndex < p.cooldownBars
    ) {
      continue;
    }

    if (signal === "enter" && !holding) {
      const fill = price * (1 + slip);
      const notional = Math.min(p.orderNotional, cash);
      if (notional <= 0) continue;
      qty = notional / fill;
      cash -= notional;
      entryFill = fill;
      entryIndex = i;
      entryDay = bars[i].day;
      barsHeld = 0;
      lastTradeIndex = i;
      markers.push({ i, price, kind: "entry" });
    } else if (signal === "exit" && holding) {
      const fill = price * (1 - slip);
      cash += qty * fill;
      roundTrips += 1;
      const win = fill > entryFill;
      if (win) wins += 1;
      // Same calendar day in, same day out = a PDT-countable day trade.
      if (entryDay === bars[i].day) dayTrades += 1;
      if (forcedThisBar) forcedExits += 1;
      trades.push({
        id: trades.length + 1,
        entryIndex,
        exitIndex: i,
        entryFill,
        exitFill: fill,
        barsHeld,
        reason: forcedThisBar ? "max hold" : "signal",
        returnPct: (fill / entryFill - 1) * 100,
        win,
      });
      markers.push({ i, price, kind: forcedThisBar ? "forced" : "exit" });
      qty = 0;
      barsHeld = 0;
      lastTradeIndex = i;
    }
  }

  const finalPrice = closes[closes.length - 1];
  const endEquity = cash + qty * finalPrice;
  let openUnrealizedPct: number | null = null;
  if (qty > 0) {
    openUnrealizedPct = (finalPrice / entryFill - 1) * 100;
    trades.push({
      id: trades.length + 1,
      entryIndex,
      exitIndex: null,
      entryFill,
      exitFill: null,
      barsHeld,
      reason: "open",
      returnPct: openUnrealizedPct,
      win: false,
    });
  }

  return {
    warmup,
    equity,
    hold,
    markers,
    trades,
    returnPct: (endEquity / STARTING_CASH - 1) * 100,
    // sweep.py measures buy & hold across the whole series; this starts it at
    // the first evaluated bar so the two curves share an origin.
    holdPct: (finalPrice / holdBase - 1) * 100,
    maxDrawdownPct: maxDd,
    roundTrips,
    wins,
    dayTrades,
    refusedExits,
    forcedExits,
    openUnrealizedPct,
    endEquity,
  };
}

/* ---- rendering ---------------------------------------------------------- */

const W = 720;
const PRICE_H = 190;
const EQ_H = 120;

const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;

export function StrategyBacktest() {
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [smooth, setSmooth] = useState(3);
  const [deadband, setDeadband] = useState(0.002);
  const [maxHoldDays, setMaxHoldDays] = useState<number | null>(2);
  const [neverSellAtLoss, setNeverSellAtLoss] = useState(true);
  const [cooldownBars, setCooldownBars] = useState(0);
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [orderNotional, setOrderNotional] = useState(STARTING_CASH);

  const bars = useMemo(() => syntheticBars(BAR_COUNT, seed), [seed]);

  const result = useMemo(
    () =>
      runBacktest(bars, {
        smooth,
        deadband,
        maxHoldDays,
        neverSellAtLoss,
        cooldownBars,
        slippageBps,
        orderNotional,
      }),
    [bars, smooth, deadband, maxHoldDays, neverSellAtLoss, cooldownBars, slippageBps, orderNotional],
  );

  const chart = useMemo(() => {
    const closes = bars.map((b) => b.close);
    const line = smooth > 1 ? sma(closes, smooth) : closes.map((c) => c as number | null);
    const lo = Math.min(...closes);
    const hi = Math.max(...closes);
    const x = (i: number) => (i / (closes.length - 1)) * W;
    const yP = (p: number) => PRICE_H - 6 - ((p - lo) / (hi - lo || 1)) * (PRICE_H - 16);

    const pricePath = closes.map((c, i) => `${x(i)},${yP(c)}`).join(" ");
    const smoothPath = line
      .map((v, i) => (v === null ? null : `${x(i)},${yP(v)}`))
      .filter((s): s is string => s !== null)
      .join(" ");

    const eqAll = [...result.equity, ...result.hold];
    const eLo = Math.min(...eqAll, STARTING_CASH);
    const eHi = Math.max(...eqAll, STARTING_CASH);
    const yE = (v: number) => EQ_H - 6 - ((v - eLo) / (eHi - eLo || 1)) * (EQ_H - 16);
    const eqPath = result.equity.map((v, k) => `${x(k + result.warmup)},${yE(v)}`).join(" ");
    const holdPath = result.hold.map((v, k) => `${x(k + result.warmup)},${yE(v)}`).join(" ");

    return { x, yP, pricePath, smoothPath, eqPath, holdPath, yStart: yE(STARTING_CASH), lo, hi };
  }, [bars, smooth, result]);

  const winRate = result.roundTrips ? (result.wins / result.roundTrips) * 100 : null;
  const edge = result.returnPct - result.holdPct;
  const recent = result.trades.slice(-9).reverse();

  return (
    <section className="mt-10 rounded border border-hair bg-raised">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hair px-4 py-3">
        <h2 className="font-prose text-base font-semibold text-bright">
          Slope-reversal backtest — playable
        </h2>
        <p className="font-mono text-xs text-dim">ported from rhbot/strategy/slope_reversal.py</p>
      </header>

      <div className="border-b border-hair-soft bg-sunken px-4 py-2.5">
        <p className="max-w-[72ch] font-mono text-xs leading-relaxed text-warning">
          Synthetic prices. The series is a seeded random walk generated in this file, ported from
          SyntheticFeed in rhbot/data/feed.py — not market data, not a track record. The rule, the
          risk gates and the cost model are the live ones; the returns below mean nothing about
          anything traded.
        </p>
      </div>

      <div className="px-4 py-4">
        <p className="max-w-[68ch] text-sm text-muted">
          The rule smooths the close over <span className="font-mono text-xs text-body">smooth</span>{" "}
          bars, differences it, and trades the sign flip: <span className="text-accent">−→+</span> is
          a local bottom and buys, <span className="text-warning">+→−</span> is a local top and
          sells. The deadband makes a flip count only when it exceeds{" "}
          <span className="font-mono text-xs text-body">min_slope_pct × close</span>. Long only —
          there is no short side, so a top while flat does nothing. Everything runs on daily bars,
          which is what keeps round trips overnight and out of the day-trade counter.
        </p>

        {/* ---- parameter sets from the live config ---- */}
        <div className="mt-4">
          <p className="font-mono text-xs text-faint">
            parameter sets — config.live.yaml (tuned per symbol on real bars, applied here to a
            series they never saw)
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {PRESETS.map((p) => {
              const active = p.smooth === smooth && p.deadband === deadband;
              return (
                <button
                  key={p.symbol}
                  type="button"
                  onClick={() => {
                    setSmooth(p.smooth);
                    setDeadband(p.deadband);
                  }}
                  aria-pressed={active}
                  className={`rounded-sm border px-2 py-1 font-mono text-xs transition-colors ${
                    active
                      ? "border-accent text-accent"
                      : "border-hair text-dim hover:border-muted hover:text-body"
                  }`}
                >
                  {p.symbol}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setSeed((s) => (s % 97) + 1)}
              className="ml-auto rounded-sm border border-hair px-2 py-1 font-mono text-xs text-dim transition-colors hover:border-muted hover:text-body"
            >
              new series (seed {seed})
            </button>
          </div>
        </div>

        {/* ---- controls ---- */}
        <div className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Slider
            label="smooth"
            hint="bars in the SMA the slope is taken from"
            value={smooth}
            min={1}
            max={12}
            onChange={setSmooth}
            display={smooth === 1 ? "1 (raw close)" : `${smooth} bars`}
          />
          <Choice
            label="min_slope_pct"
            hint="deadband — flip must exceed this × close"
            options={DEADBANDS.map((d) => ({ key: String(d), label: d === 0 ? "0" : d.toFixed(3) }))}
            active={String(deadband)}
            onSelect={(k) => setDeadband(Number(k))}
          />
          <Choice
            label="max_hold_days"
            hint="engine.py — forced exit, overrides the strategy"
            options={HOLD_LIMITS.map((l) => ({
              key: String(l),
              label: l === null ? "off" : `${l}d`,
            }))}
            active={String(maxHoldDays)}
            onSelect={(k) => setMaxHoldDays(k === "null" ? null : Number(k))}
          />
          <Choice
            label="never_sell_at_loss"
            hint={`refuses exits under cost × (1 + ${MIN_PROFIT_PCT}%)`}
            options={[
              { key: "on", label: "on" },
              { key: "off", label: "off" },
            ]}
            active={neverSellAtLoss ? "on" : "off"}
            onSelect={(k) => setNeverSellAtLoss(k === "on")}
          />
          <Slider
            label="cooldown_bars"
            hint="frequency governor, in bars"
            value={cooldownBars}
            min={0}
            max={10}
            onChange={setCooldownBars}
            display={cooldownBars === 0 ? "0 (live equivalent)" : `${cooldownBars} bars`}
          />
          <Choice
            label="slippage_bps"
            hint="per side — 2 measured on real fills, 25 used for crypto"
            options={[
              { key: "0", label: "0" },
              { key: "2", label: "2" },
              { key: "10", label: "10" },
              { key: "25", label: "25" },
            ]}
            active={String(slippageBps)}
            onSelect={(k) => setSlippageBps(Number(k))}
          />
          <Choice
            label="order_notional"
            hint="dollars per entry against $10,000 of cash"
            options={[
              { key: "1000", label: "$1,000 (sweep.py)" },
              { key: "10000", label: "$10,000 (all in)" },
            ]}
            active={String(orderNotional)}
            onSelect={(k) => setOrderNotional(Number(k))}
          />
        </div>

        {/* ---- price chart ---- */}
        <div className="mt-6 overflow-x-auto">
          <div className="min-w-[36rem]">
            <div className="flex items-baseline justify-between font-mono text-xs text-faint">
              <span>close + SMA{smooth} · {BAR_COUNT} daily bars</span>
              <span className="tabular-nums">
                {chart.lo.toFixed(2)} – {chart.hi.toFixed(2)}
              </span>
            </div>
            <svg
              viewBox={`0 0 ${W} ${PRICE_H}`}
              className="mt-1 h-auto w-full"
              role="img"
              aria-label="Synthetic close price with the smoothed line and trade markers"
            >
              <polyline
                points={chart.pricePath}
                fill="none"
                strokeWidth={1}
                className="text-dim"
                stroke="currentColor"
              />
              <polyline
                points={chart.smoothPath}
                fill="none"
                strokeWidth={1.4}
                className="text-note"
                stroke="currentColor"
              />
              {result.markers.map((m, k) => {
                const cx = chart.x(m.i);
                const cy = chart.yP(m.price);
                if (m.kind === "refused") {
                  return (
                    <circle
                      key={k}
                      cx={cx}
                      cy={cy}
                      r={2.6}
                      fill="none"
                      strokeWidth={1}
                      className="text-error"
                      stroke="currentColor"
                    />
                  );
                }
                if (m.kind === "entry") {
                  return (
                    <path
                      key={k}
                      d={`M ${cx} ${cy + 3} l 3.4 5.5 l -6.8 0 Z`}
                      className="text-accent"
                      fill="currentColor"
                    />
                  );
                }
                return (
                  <path
                    key={k}
                    d={`M ${cx} ${cy - 3} l 3.4 -5.5 l -6.8 0 Z`}
                    className={m.kind === "forced" ? "text-note" : "text-warning"}
                    fill="currentColor"
                  />
                );
              })}
            </svg>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-faint">
              <span className="text-accent">▲ entry</span>
              <span className="text-warning">▼ exit (signal)</span>
              <span className="text-note">▼ exit (max hold)</span>
              <span className="text-error">○ exit refused — below the profit floor (one per stretch)</span>
            </div>

            <div className="mt-4 flex items-baseline justify-between font-mono text-xs text-faint">
              <span>equity vs buy &amp; hold</span>
              <span className="tabular-nums">
                ${result.endEquity.toFixed(0)} from ${STARTING_CASH.toLocaleString()}
              </span>
            </div>
            <svg
              viewBox={`0 0 ${W} ${EQ_H}`}
              className="mt-1 h-auto w-full"
              role="img"
              aria-label="Strategy equity curve against buy and hold"
            >
              <line
                x1={0}
                x2={W}
                y1={chart.yStart}
                y2={chart.yStart}
                strokeWidth={1}
                strokeDasharray="2 4"
                className="text-faint"
                stroke="currentColor"
              />
              <polyline
                points={chart.holdPath}
                fill="none"
                strokeWidth={1}
                className="text-dim"
                stroke="currentColor"
              />
              <polyline
                points={chart.eqPath}
                fill="none"
                strokeWidth={1.6}
                className="text-accent"
                stroke="currentColor"
              />
            </svg>
            <div className="mt-1 flex flex-wrap gap-x-4 font-mono text-xs text-faint">
              <span className="text-accent">— strategy</span>
              <span className="text-dim">— buy &amp; hold</span>
              <span>··· starting cash</span>
            </div>
          </div>
        </div>

        {/* ---- stats ---- */}
        <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Stat label="return" value={signed(result.returnPct)} tone={result.returnPct >= 0 ? "good" : "bad"} />
          <Stat label="buy & hold" value={signed(result.holdPct)} />
          <Stat label="edge vs hold" value={signed(edge)} tone={edge >= 0 ? "good" : "bad"} />
          <Stat label="max drawdown" value={`${result.maxDrawdownPct.toFixed(2)}%`} tone="bad" />
          <Stat label="round trips" value={String(result.roundTrips)} />
          <Stat label="win rate" value={winRate === null ? "—" : `${winRate.toFixed(1)}%`} />
          <Stat label="day trades" value={String(result.dayTrades)} />
          <Stat
            label="open at end"
            value={
              result.openUnrealizedPct === null ? "flat" : signed(result.openUnrealizedPct)
            }
            tone={
              result.openUnrealizedPct !== null && result.openUnrealizedPct < 0 ? "bad" : undefined
            }
          />
        </div>

        {/* ---- what the gates did ---- */}
        <dl className="mt-5 flex flex-col gap-2 border-t border-hair-soft pt-4 font-mono text-xs">
          <Gate
            source="engine.py"
            name="never_sell_at_loss"
            state={neverSellAtLoss ? "on" : "off"}
            detail={
              neverSellAtLoss
                ? `${result.refusedExits} exit signals refused below cost × (1 + ${MIN_PROFIT_PCT}%). Every completed sale is a win; the losses are still there, unrealised.`
                : "off — exits clear at whatever the mark is, losses included."
            }
          />
          <Gate
            source="engine.py"
            name="max_hold_days"
            state={maxHoldDays === null ? "off" : `${maxHoldDays}d`}
            detail={
              maxHoldDays === null
                ? "off — the strategy alone decides when to leave."
                : `${result.forcedExits} exits forced by the clock. With never_sell_at_loss on, an underwater position is held past this limit rather than closed at a loss — that is the documented interaction, not a conflict.`
            }
          />
          <Gate
            source="backtest.py"
            name="slippage + cooldown"
            state={`${slippageBps}bps · ${cooldownBars} bars`}
            detail={`Entries fill at close × (1 + ${slippageBps}bps), exits at close × (1 − ${slippageBps}bps). A win is counted on the slipped prices, so the ${MIN_PROFIT_PCT}% floor has to clear the round trip or a "winning" sale still nets negative.`}
          />
          <Gate
            source="risk.py"
            name="PDT guard"
            state="daily bars"
            detail="Every round trip here crosses a night, so none of them counts as a day trade — which is the reason the equities run on 1d bars at all. The live guard blocks new stock entries once 3 day trades are used in 5 business days; exits are never blocked."
          />
        </dl>

        {/* ---- trade log ---- */}
        <div className="mt-5 border-t border-hair-soft pt-4">
          <p className="font-mono text-xs text-faint">
            last {recent.length} of {result.trades.length} positions
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[30rem] font-mono text-xs tabular-nums">
              <thead>
                <tr className="text-faint">
                  <th className="py-1 text-left font-normal">#</th>
                  <th className="py-1 text-right font-normal">in</th>
                  <th className="py-1 text-right font-normal">out</th>
                  <th className="py-1 text-right font-normal">held</th>
                  <th className="py-1 text-right font-normal">net</th>
                  <th className="py-1 text-left font-normal">&nbsp;&nbsp;exit</th>
                </tr>
              </thead>
              <tbody>
                {recent.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-1 text-faint">
                      no positions — no slope flip cleared a deadband of{" "}
                      {(deadband * 100).toFixed(1)}% on a series that moves ~1% a day. The symbols
                      these numbers were tuned on move several percent a day.
                    </td>
                  </tr>
                )}
                {recent.map((t) => (
                  <tr key={t.id} className="text-dim">
                    <td className="py-0.5">{t.id}</td>
                    <td className="py-0.5 text-right">{t.entryFill.toFixed(2)}</td>
                    <td className="py-0.5 text-right">
                      {t.exitFill === null ? "—" : t.exitFill.toFixed(2)}
                    </td>
                    <td className="py-0.5 text-right">{t.barsHeld}d</td>
                    <td
                      className={`py-0.5 text-right ${
                        t.reason === "open"
                          ? "text-note"
                          : t.win
                            ? "text-accent"
                            : "text-error"
                      }`}
                    >
                      {signed(t.returnPct)}
                    </td>
                    <td className="py-0.5 pl-3 text-left text-faint">
                      {t.reason === "open" ? "still held" : t.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="mt-5 max-w-[68ch] text-sm text-muted">
          The thing worth watching: turn{" "}
          <span className="font-mono text-xs text-body">never_sell_at_loss</span> on and the win rate
          climbs toward 100% while the money usually gets worse — the refused exits do not remove the
          losses, they park them in an open position that the hold cap can no longer close. That
          trade was measured across 12 symbols over 5 years before it was switched on: mean +270.6%
          at a 39% win rate without it, +112.9% at 91% with it, and 11 of 12 runs ended holding a
          loser.
        </p>
      </div>
    </section>
  );
}

/* ---- small presentational pieces --------------------------------------- */

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad";
}) {
  const color = tone === "good" ? "text-accent" : tone === "bad" ? "text-warning" : "text-bright";
  return (
    <div>
      <p className="font-mono text-xs text-faint">{label}</p>
      <p className={`font-mono text-sm tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

function Slider({
  label,
  hint,
  value,
  min,
  max,
  onChange,
  display,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  display: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 font-mono text-xs">
        <span className="text-body">{label}</span>
        <span className="tabular-nums text-dim">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5 h-1 w-full cursor-pointer appearance-none rounded-sm bg-sunken accent-[#5fc98d]"
      />
      <p className="mt-1 font-mono text-xs text-faint">{hint}</p>
    </div>
  );
}

function Choice({
  label,
  hint,
  options,
  active,
  onSelect,
}: {
  label: string;
  hint: string;
  options: { key: string; label: string }[];
  active: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div>
      <p className="font-mono text-xs text-body">{label}</p>
      <div className="mt-1.5 flex flex-wrap gap-1" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => onSelect(o.key)}
            aria-pressed={active === o.key}
            className={`rounded-sm border px-2 py-0.5 font-mono text-xs tabular-nums transition-colors ${
              active === o.key
                ? "border-accent text-accent"
                : "border-hair text-dim hover:border-muted hover:text-body"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="mt-1 font-mono text-xs text-faint">{hint}</p>
    </div>
  );
}

function Gate({
  source,
  name,
  state,
  detail,
}: {
  source: string;
  name: string;
  state: string;
  detail: string;
}) {
  return (
    <div className="grid gap-x-3 gap-y-0.5 sm:grid-cols-[13rem_1fr]">
      <dt className="flex items-baseline gap-2">
        <span className="text-body">{name}</span>
        <span className="text-accent">{state}</span>
      </dt>
      <dd className="max-w-[62ch] text-dim">
        {detail} <span className="text-faint">— {source}</span>
      </dd>
    </div>
  );
}
