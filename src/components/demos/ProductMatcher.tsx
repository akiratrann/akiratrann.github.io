"use client";

import { useMemo, useState, type ReactNode } from "react";

/*
  A faithful browser port of the BetterBasket store-A → store-B product matcher.

  Everything that decides a score here is lifted from the Python:
    match_products.py  — normalize_name / parse_size / extract_brand,
                         the TF-IDF blocking stage, decisive_reject
    features.py        — pair_features, model_proba, composite_score
    heuristic_model.json — the 14 standardized logistic coefficients, verbatim

  What is NOT here: the two 233k/55k-row store catalogues (company data, and
  gitignored in the original repo) and the GPT-5 nano adjudication stage, which
  needs the network. The catalogue below is 12 Walmart items and 24 Wegmans
  items taken from the repo's committed 360-pair gold set, with their real
  brand_raw and sizing_comp.size_user_friendly values, so every normalisation
  and every feature runs on genuine inputs.

  State is immutable; scoring is pure functions over the query string, so React
  recomputes a ranking only when the query changes.
*/

// ---------------------------------------------------------------------------
// Stage 1 — normalisation (match_products.py)
// ---------------------------------------------------------------------------

/*
  Applied token-by-token after punctuation has already been stripped, exactly as
  in the source — which is why the "&" and " orgnc " entries can never fire.
  Kept verbatim rather than tidied, so this map is the map the pipeline runs.
*/
const SYNONYMS: Record<string, string> = {
  oz: "ounce", ozs: "ounce", ounces: "ounce",
  fl: "fluid", lb: "pound", lbs: "pound", pounds: "pound",
  ct: "count", cnt: "count", pk: "pack", pkg: "pack",
  gal: "gallon", qt: "quart", pt: "pint",
  g: "gram", gr: "gram", grams: "gram", kg: "kilogram",
  ml: "milliliter", l: "liter", ltr: "liter",
  "&": "and", w: "with", " orgnc ": " organic ",
};

/** Weight → grams, volume → millilitres, count → count. Exact constants. */
const UNIT_TO_BASE: Record<string, [string, number]> = {
  oz: ["g", 28.3495], ounce: ["g", 28.3495], ounces: ["g", 28.3495],
  lb: ["g", 453.592], lbs: ["g", 453.592], pound: ["g", 453.592], pounds: ["g", 453.592],
  g: ["g", 1.0], gram: ["g", 1.0], grams: ["g", 1.0], gr: ["g", 1.0],
  kg: ["g", 1000.0], kilogram: ["g", 1000.0],
  floz: ["ml", 29.5735], fluidounce: ["ml", 29.5735],
  ml: ["ml", 1.0], milliliter: ["ml", 1.0],
  l: ["ml", 1000.0], liter: ["ml", 1000.0], ltr: ["ml", 1000.0],
  gal: ["ml", 3785.41], gallon: ["ml", 3785.41],
  qt: ["ml", 946.353], quart: ["ml", 946.353],
  pt: ["ml", 473.176], pint: ["ml", 473.176],
  ct: ["ct", 1.0], count: ["ct", 1.0], pk: ["ct", 1.0], pack: ["ct", 1.0],
  ea: ["ct", 1.0], each: ["ct", 1.0],
};

const SIZE_RE =
  /(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|fluid\s*ounce|oz|ounces?|lbs?|pounds?|kg|kilograms?|grams?|gr|g|milliliters?|ml|liters?|ltr|l|gallons?|gal|quarts?|qt|pints?|pt|counts?|ct|packs?|pk|ea|each)\b/gi;

type Size = { unit: string; value: number };

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[®™©]/g, " ")
    .replace(/-/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => SYNONYMS[t] ?? t)
    .join(" ")
    .trim();
}

/** First size token in the text, converted to its canonical base unit. */
function parseSize(text: string): Size | null {
  SIZE_RE.lastIndex = 0;
  let m = SIZE_RE.exec(text);
  while (m) {
    const val = parseFloat(m[1]);
    const unit = m[2].toLowerCase().replace(/\./g, "").replace(/ /g, "");
    const base = unit === "floz" || unit === "fluidounce" ? UNIT_TO_BASE.floz : UNIT_TO_BASE[unit];
    if (base) return { unit: base[0], value: Math.round(val * base[1] * 100) / 100 };
    m = SIZE_RE.exec(text);
  }
  return null;
}

/** brand_raw when present; otherwise the first two tokens (46% of store A). */
function extractBrand(brandRaw: string | null, norm: string): string {
  if (brandRaw && brandRaw.trim()) return normalizeName(brandRaw);
  return norm.split(" ").filter(Boolean).slice(0, 2).join(" ");
}

// ---------------------------------------------------------------------------
// RapidFuzz string ratios, re-implemented from their definitions
//
// rapidfuzz's `ratio` is normalized Indel (insert/delete-only Levenshtein)
// similarity, which reduces to 2·LCS / (len₁ + len₂) — not difflib's matching
// blocks. Everything else is built on top of that one primitive.
// ---------------------------------------------------------------------------

function lcsLength(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  const m = b.length;
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let i = 0; i < a.length; i++) {
    const ca = a.charCodeAt(i);
    for (let j = 0; j < m; j++) {
      cur[j + 1] = ca === b.charCodeAt(j) ? prev[j] + 1 : Math.max(cur[j], prev[j + 1]);
    }
    const swap = prev;
    prev = cur;
    cur = swap; // cur[0] stays 0; every other cell is written before it is read
  }
  return prev[m];
}

function ratio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 100;
  return (200 * lcsLength(a, b)) / total;
}

/** Best alignment of `needle` anywhere in `hay`, including off either end. */
function partialRatioImpl(needle: string, hay: string): number {
  const n = needle.length;
  let best = 0;
  for (let start = 0; start + n <= hay.length; start++) {
    best = Math.max(best, ratio(needle, hay.slice(start, start + n)));
  }
  for (let k = 1; k < n; k++) {
    best = Math.max(best, ratio(needle, hay.slice(0, k)));
    best = Math.max(best, ratio(needle, hay.slice(hay.length - k)));
  }
  return best;
}

function partialRatio(a: string, b: string): number {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!short.length || !long.length) return short.length === long.length ? 100 : 0;
  const best = partialRatioImpl(short, long);
  /*
    Equal-length inputs leave "which one is the needle" ambiguous and the two
    directions disagree on the truncated end alignments, so rapidfuzz retries
    the other way round. Exactly one of the 288 sample pairs needs this.
  */
  if (best < 100 && a.length === b.length) {
    return Math.max(best, partialRatioImpl(long, short));
  }
  return best;
}

const tokens = (s: string): string[] => s.split(/\s+/).filter(Boolean);

function tokenSortRatio(a: string, b: string): number {
  return ratio(tokens(a).sort().join(" "), tokens(b).sort().join(" "));
}

/*
  token_set_ratio: split both names into token sets, then compare the shared
  part against each side's leftovers. Its value here is that a Walmart name is
  usually the Wegmans name plus marketing ("Plastic Jar 40 oz (2 Pack)"), and a
  strict subset scores 100.
*/
function tokenSetRatio(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  const shared = [...ta].filter((t) => tb.has(t));
  const onlyA = [...ta].filter((t) => !tb.has(t));
  const onlyB = [...tb].filter((t) => !ta.has(t));
  if (shared.length && (!onlyA.length || !onlyB.length)) return 100;

  const sect = shared.sort().join(" ");
  const ab = sect ? `${sect} ${onlyA.sort().join(" ")}` : onlyA.sort().join(" ");
  const ba = sect ? `${sect} ${onlyB.sort().join(" ")}` : onlyB.sort().join(" ");
  let best = ratio(ab, ba);
  if (sect) best = Math.max(best, ratio(sect, ab), ratio(sect, ba));
  return best;
}

// ---------------------------------------------------------------------------
// Stage 2 — TF-IDF char n-gram blocking (build_candidates)
//
// The production fit is TfidfVectorizer(analyzer="char_wb", ngram_range=(3,5),
// min_df=2, sublinear_tf=True) over all 288k names, then a sparse top-5 per A
// item. The analyzer, the weighting and the L2-normalised cosine below are the
// same; the corpus is the 36 names in this file, so the IDF is much coarser.
// ---------------------------------------------------------------------------

/** sklearn's _char_wb_ngrams: pad each word with spaces, slide n over it. */
function charWbNgrams(doc: string): string[] {
  const out: string[] = [];
  for (const word of tokens(doc)) {
    const w = ` ${word} `;
    for (let n = 3; n <= 5; n++) {
      let offset = 0;
      out.push(w.slice(offset, offset + n));
      while (offset + n < w.length) {
        offset += 1;
        out.push(w.slice(offset, offset + n));
      }
      if (offset === 0) break; // a word shorter than n is counted once
    }
  }
  return out;
}

type Vectorizer = { idf: Map<string, number> };

function fitVectorizer(corpus: string[]): Vectorizer {
  const df = new Map<string, number>();
  for (const doc of corpus) {
    for (const g of new Set(charWbNgrams(doc))) df.set(g, (df.get(g) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [g, n] of df) {
    if (n >= 2) idf.set(g, Math.log((1 + corpus.length) / (1 + n)) + 1); // min_df=2, smooth_idf
  }
  return { idf };
}

/** sublinear tf · idf, L2-normalised, restricted to the fitted vocabulary. */
function transform(vec: Vectorizer, doc: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const g of charWbNgrams(doc)) {
    if (vec.idf.has(g)) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  let norm = 0;
  for (const [g, c] of counts) {
    const v = (1 + Math.log(c)) * (vec.idf.get(g) as number);
    out.set(g, v);
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (const [g, v] of out) out.set(g, v / norm);
  return out;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [g, v] of small) {
    const w = big.get(g);
    if (w !== undefined) dot += v * w;
  }
  return dot;
}

// ---------------------------------------------------------------------------
// Stage 3 — the 14 features and the trained logistic scorer (features.py)
// ---------------------------------------------------------------------------

/*
  Tokens that flip a product's identity. The feature counts how many of them sit
  in the symmetric difference of the two token sets — it is what stopped the old
  hand-tuned composite from matching a flavour variant to its sibling.
*/
const MODIFIERS = new Set([
  "zero", "sugar", "sugarfree", "free", "unsweetened", "sweetened", "diet",
  "decaf", "caffeine", "light", "lite", "sensitive", "normal", "unscented",
  "scented", "fragrance", "mini", "large", "small", "family", "kids", "kid",
  "men", "women", "mens", "womens", "plus", "max", "maximum", "extra", "ultra",
  "whitening", "spray", "gel", "foam", "lotion", "wash", "bar", "liquid",
  "powder", "wipes", "refill", "concentrate", "conditioner", "shampoo", "hot",
  "spicy", "mild", "roasted", "grilled", "whole", "skim", "nonfat", "lowfat",
  "fat", "organic", "natural", "original", "creamy", "crunchy", "smooth",
  "fluoride", "antibacterial", "moisturizing", "hydrating",
]);

const FEATURES = [
  "tfidf", "tset", "tsort", "partial", "ratio", "brand", "brand_known",
  "size", "size_known", "jaccard", "n_sym", "mod_mismatch", "len_ratio",
  "num_mismatch",
] as const;

type FeatureName = (typeof FEATURES)[number];
type FeatureVec = Record<FeatureName, number>;

/** heuristic_model.json — StandardScaler moments + LogisticRegression weights. */
const MODEL: { mean: number[]; scale: number[]; coef: number[]; intercept: number } = {
  mean: [
    0.7212946233711637, 0.9131977124006069, 0.6478759257446344, 0.7721660253878246,
    0.5962896717910727, 0.9553090556712313, 1.0, 0.7930674605771972,
    0.8365504154943402, 0.4269957371169106, 7.9495845056598835, 0.45112216187921217,
    0.5885128647602644, 0.9245894130733495,
  ],
  scale: [
    0.15049549458695533, 0.09932429746322012, 0.14696822032739126, 0.12055541356861664,
    0.13965447084543423, 0.15881289240486218, 1.0, 0.2934964876751717,
    0.3697753613080945, 0.16770634223474312, 3.925595829269178, 0.7368218124018537,
    0.20135852810779756, 0.26405270365222316,
  ],
  coef: [
    0.8235606600255451, 0.26328442276203917, 0.24749676322003417, 0.19355834353732032,
    -0.46420745806102004, 0.04374265373748448, 0.0, 1.540286878230263,
    -0.13755658122107728, 0.4576870055206076, 0.048986391716746486,
    -0.0662128799768758, -0.2718190412919419, -0.09767779357532642,
  ],
  intercept: -1.0729962145619172,
};

/** 1.0 same size, 0.7 within 10%, 0.2 different unit family, 0.5 unknown. */
function sizeScore(sa: Size | null, sb: Size | null): number {
  if (!sa || !sb) return 0.5;
  if (sa.unit !== sb.unit) return 0.2;
  if (sa.value === 0 || sb.value === 0) return 0.5;
  const r = Math.min(sa.value, sb.value) / Math.max(sa.value, sb.value);
  if (r >= 0.97) return 1.0;
  if (r >= 0.9) return 0.7;
  return 0.0;
}

/** 0.5 — neutral, not zero — whenever either brand is missing. */
function brandScore(ba: string, bb: string): number {
  if (!ba || !bb) return 0.5;
  return tokenSetRatio(ba, bb) / 100.0;
}

const NUM_RE = /\d+(?:\.\d+)?/g;
const numbersIn = (s: string) => new Set(s.match(NUM_RE) ?? []);
const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

function pairFeatures(
  an: string, bn: string, ab: string, bb: string,
  asz: Size | null, bsz: Size | null, tfidf: number,
): FeatureVec {
  const at = new Set(tokens(an));
  const bt = new Set(tokens(bn));
  const sym = [...at].filter((t) => !bt.has(t)).concat([...bt].filter((t) => !at.has(t)));
  const inter = [...at].filter((t) => bt.has(t)).length;
  const union = new Set([...at, ...bt]).size;
  const maxLen = Math.max(an.length, bn.length);
  return {
    tfidf,
    tset: tokenSetRatio(an, bn) / 100.0,
    tsort: tokenSortRatio(an, bn) / 100.0,
    partial: partialRatio(an, bn) / 100.0,
    ratio: ratio(an, bn) / 100.0,
    brand: brandScore(ab, bb),
    brand_known: ab && bb ? 1.0 : 0.0,
    size: sizeScore(asz, bsz),
    size_known: asz && bsz ? 1.0 : 0.0,
    jaccard: union ? inter / union : 0.0,
    n_sym: sym.length,
    mod_mismatch: sym.filter((t) => MODIFIERS.has(t)).length,
    len_ratio: maxLen ? Math.min(an.length, bn.length) / maxLen : 0.0,
    num_mismatch: sameSet(numbersIn(an), numbersIn(bn)) ? 0.0 : 1.0,
  };
}

type Term = { name: FeatureName; value: number; z: number; coef: number; contribution: number };

/** model_proba, kept open so the UI can show every term of the sum. */
function decompose(f: FeatureVec): { terms: Term[]; z: number; proba: number } {
  let z = MODEL.intercept;
  const terms: Term[] = FEATURES.map((name, i) => {
    const scale = MODEL.scale[i] || 1.0;
    const zi = (f[name] - MODEL.mean[i]) / scale;
    const contribution = MODEL.coef[i] * zi;
    z += contribution;
    return { name, value: f[name], z: zi, coef: MODEL.coef[i], contribution };
  });
  const clamped = Math.max(-60, Math.min(60, z));
  return { terms, z, proba: 1 / (1 + Math.exp(-clamped)) };
}

/** The pre-model hand-tuned composite, still reachable in the CLI via --no-model. */
const compositeScore = (f: FeatureVec) =>
  0.55 * Math.max(f.tfidf, f.tset) + 0.2 * f.brand + 0.25 * f.size;

// ---------------------------------------------------------------------------
// Stage 5 — deterministic guards (decisive_reject)
//
// Run after the LLM has said yes. Only differences crisp enough to check with a
// rule: a variant marker on exactly one side, disagreeing mg/SPF numbers, or
// two clearly different national brands.
// ---------------------------------------------------------------------------

const PRIVATE_LABELS = [
  "great value", "wegmans", "equate", "mainstays", "members mark",
  "member s mark", "kirkland", "sams choice", "sam s choice", "market pantry",
  "good gather", "parents choice", "parent s choice", "up up", "365",
  "simple truth", "kroger", "signature select", "first street",
];

/*
  "sugar free", "zero sugar" and bare "zero" are deliberately absent: the
  held-out gold set showed they split inherently sugar-free drinks from their
  own catalogue entries, costing real matches for no precision gain.
*/
const POLARITY_TOKENS = [
  "diet", "light", "lite", "unsweetened", "decaf", "decaffeinated",
  "nonfat", "lowfat",
];
const POLARITY_PHRASES = ["fat free", "reduced fat", "less fat", "low fat"];

function polarityFlags(norm: string): string[] {
  const set = new Set(tokens(norm));
  return POLARITY_TOKENS.filter((t) => set.has(t)).concat(
    POLARITY_PHRASES.filter((p) => norm.includes(p)),
  );
}

const MG_RE = /(\d+(?:\.\d+)?)\s*mg\b/g;
const SPF_RE = /\bspf\s*(\d+)/g;

const findAll = (re: RegExp, s: string): Set<string> => {
  const out = new Set<string>();
  for (const m of s.matchAll(re)) out.add(m[1]);
  return out;
};

const isPrivate = (brand: string) => PRIVATE_LABELS.some((p) => brand.includes(p));

/** The raw brand_raw cell, lower-cased — not the normalised brand. */
const rawBrand = (b: string | null) => {
  const v = (b ?? "").trim().toLowerCase();
  return v === "nan" || v === "none" ? "" : v;
};

function decisiveReject(a: Product, b: Product, an: string, bn: string): string[] {
  const reasons: string[] = [];
  const fa = polarityFlags(an);
  const fb = polarityFlags(bn);
  const oneSided = fa.filter((x) => !fb.includes(x)).concat(fb.filter((x) => !fa.includes(x)));
  if (oneSided.length) reasons.push(`variant marker on one side only: ${oneSided.join(", ")}`);
  for (const [label, re] of [["mg", MG_RE], ["SPF", SPF_RE]] as const) {
    const x = findAll(re, an);
    const y = findAll(re, bn);
    if (x.size && y.size && !sameSet(x, y)) {
      reasons.push(`${label} disagrees: ${[...x].join("/")} vs ${[...y].join("/")}`);
    }
  }
  const ba = rawBrand(a.brandRaw);
  const bb = rawBrand(b.brandRaw);
  if (ba && bb) {
    const sim = tokenSetRatio(ba, bb);
    if (sim < 55 && !isPrivate(ba) && !isPrivate(bb)) {
      reasons.push(`different national brands (${ba} vs ${bb}, ${sim.toFixed(1)} < 55)`);
    }
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// The sample catalogue — real rows from the repo's committed gold set
// ---------------------------------------------------------------------------

type Product = {
  id: string;
  name: string;
  brandRaw: string | null;
  /** sizing_comp.size_user_friendly, the size the pipeline prefers. */
  sizeUF: string | null;
};

type Query = Product & {
  label: string;
  gold: { b: string; shopperMatch: boolean; prodScore: number; outcome: Outcome };
};

type Outcome = "shipped" | "llm-rejected" | "guard-vetoed";

/* Store A — Walmart. brand_raw is null on 46% of this store, so most of these
   fall back to the first two normalised tokens ("diet dr", "skippy creamy"). */
const STORE_A: Query[] = [
  {
    id: "1915657", label: "Tim Hortons dark roast",
    name: "Tim Hortons Dark Roast Ground Coffee, 100% Arabica, 12 oz Bag",
    brandRaw: null, sizeUF: null,
    gold: { b: "99303", shopperMatch: true, prodScore: 0.8908, outcome: "shipped" },
  },
  {
    id: "2103234", label: "Herr's honey BBQ chips",
    name: "Herr's Honey Barbecue Potato Chips 7.75 oz",
    brandRaw: "Herr's", sizeUF: "7.75 oz",
    gold: { b: "102937", shopperMatch: false, prodScore: 0.5694, outcome: "guard-vetoed" },
  },
  {
    id: "1929742", label: "Great Value mushroom sauce",
    name: "Great Value Mushroom Pasta Sauce, 24 oz",
    brandRaw: null, sizeUF: null,
    gold: { b: "98737", shopperMatch: true, prodScore: 0.3178, outcome: "shipped" },
  },
  {
    id: "1939601", label: "Diet Dr Pepper 12-pack",
    name: "Diet Dr Pepper Soda Pop, 12 fl oz, 12 Pack Cans",
    brandRaw: null, sizeUF: null,
    gold: { b: "96567", shopperMatch: true, prodScore: 0.792, outcome: "shipped" },
  },
  {
    id: "1925928", label: "Intl Delight zero sugar",
    name: "International Delight Zero Sugar Caramel Macchiato Coffee Creamer, 32 fl oz Bottle",
    brandRaw: null, sizeUF: null,
    gold: { b: "91876", shopperMatch: false, prodScore: 0.568, outcome: "llm-rejected" },
  },
  {
    id: "1943471", label: "Cabot sharp cheddar",
    name: "Cabot Creamery Sharp Cheddar Cheese Block 8oz (Refrigerated)",
    brandRaw: null, sizeUF: null,
    gold: { b: "92001", shopperMatch: false, prodScore: 0.5245, outcome: "llm-rejected" },
  },
  {
    id: "2260453", label: "Yoplait lemon burst",
    name: "Yoplait Original Low Fat Lemon Burst Yogurt Cup, Made with Real Fruit, 6 oz",
    brandRaw: "Yoplait", sizeUF: null,
    gold: { b: "91897", shopperMatch: false, prodScore: 0.3409, outcome: "llm-rejected" },
  },
  {
    id: "1919266", label: "Skippy creamy 2-pack",
    name: "SKIPPY Creamy Peanut Butter Spread, Plastic Jar 40 oz (2 Pack)",
    brandRaw: null, sizeUF: null,
    gold: { b: "101643", shopperMatch: true, prodScore: 0.631, outcome: "shipped" },
  },
  {
    id: "1930643", label: "Great Value bread flour",
    name: "Great Value Enriched and Unbleached Bread Flour, 5 lb Bag",
    brandRaw: null, sizeUF: null,
    gold: { b: "99458", shopperMatch: true, prodScore: 0.4852, outcome: "shipped" },
  },
  {
    id: "1943401", label: "Califia unsweetened vanilla",
    name: "Califia Farms, Unsweetened Vanilla Almond Milk, Refrigerated 48 fl oz Plastic Bottle",
    brandRaw: null, sizeUF: null,
    gold: { b: "92992", shopperMatch: true, prodScore: 0.4883, outcome: "shipped" },
  },
  {
    id: "600417", label: "Bertolli marinara",
    name: "2X-Bertolli Traditional Marinara Sauce - 24 oz",
    brandRaw: "Bertolli", sizeUF: null,
    gold: { b: "97577", shopperMatch: true, prodScore: 0.8498, outcome: "shipped" },
  },
  {
    id: "1941179", label: "Coca-Cola Cherry 20oz",
    name: "Coca-Cola Cherry Soda Pop Bottle, 20 fl oz",
    brandRaw: null, sizeUF: null,
    gold: { b: "102708", shopperMatch: true, prodScore: 0.4273, outcome: "shipped" },
  },
];

/* Store B — Wegmans. Every one of these carries a size_user_friendly string. */
const STORE_B: Product[] = [
  { id: "99303", name: "Tim Hortons Coffee, 100% Arabica, Ground, Dark Roast", brandRaw: "Tim Hortons", sizeUF: "12 ounce" },
  { id: "1953959", name: "Cafe Bustelo Coffee, Ground, Espresso, Party Size!", brandRaw: "Cafe Bustelo", sizeUF: "36 ounce" },
  { id: "102937", name: "Lay's Potato Chips Honey Barbecue Flavored 7 3/4 Oz", brandRaw: "Lay's", sizeUF: "7.75 ounce" },
  { id: "1089583", name: "Lay's Potato Chips, Barbecue Flavored", brandRaw: "Lay's", sizeUF: "1 ounce" },
  { id: "95854", name: "Cape Cod Original Kettle Cooked Potato Chips", brandRaw: "Cape Cod", sizeUF: "14 ounce" },
  { id: "98488", name: "Ruffles Original Potato Chips, Party Size", brandRaw: "Ruffles", sizeUF: "13 ounce" },
  { id: "98737", name: "Wegmans Mushroom Pasta Sauce", brandRaw: "Wegmans", sizeUF: "24 ounce" },
  { id: "97577", name: "Bertolli Sauce, Traditional Marinara", brandRaw: "Bertolli", sizeUF: "24 ounce" },
  { id: "104219", name: "Bertolli Sauce, Alfredo", brandRaw: "Bertolli", sizeUF: "15 ounce" },
  { id: "103180", name: "Dr Pepper Soda", brandRaw: "Dr Pepper", sizeUF: "2 liter" },
  { id: "96567", name: "Dr Pepper Soda, Diet, 12 Pack", brandRaw: "Dr Pepper", sizeUF: "12 x 12 fl. oz." },
  { id: "102708", name: "Coca-Cola Cherry Soda Soft Drink Bottle", brandRaw: "Coca-Cola", sizeUF: "20 fl. oz." },
  { id: "91876", name: "International Delight Caramel Macchiato Liquid Coffee Creamer", brandRaw: "International Delight", sizeUF: "32 fl. oz." },
  { id: "92759", name: "Coffee-Mate The Original Non-Dairy Creamer", brandRaw: "Coffee-Mate", sizeUF: "64 fl. oz." },
  { id: "92001", name: "Cabot Creamery Lite 50 Sharp Cheddar Cheese", brandRaw: "Cabot Creamery", sizeUF: "8 ounce" },
  { id: "954880", name: "Galbani Cheese, Mozzarella, Italian Style, Part-Skim", brandRaw: "Galbani", sizeUF: "16 ounce" },
  { id: "101643", name: "Skippy Peanut Butter, Creamy", brandRaw: "Skippy", sizeUF: "40 ounce" },
  { id: "2136578", name: "Jif Natural Peanut Butter", brandRaw: "Jif", sizeUF: "16 ounce" },
  { id: "92992", name: "Califia Farms Almondmilk, Unsweetened Vanilla", brandRaw: "Califia Farms", sizeUF: "48 fl. oz." },
  { id: "97734", name: "Elmhurst Milked Walnuts, Unsweetened", brandRaw: "Elmhurst", sizeUF: "32 fl. oz." },
  { id: "93103", name: "Silk Dark Chocolate Dairy Free Vegan Almond Milk", brandRaw: "Silk", sizeUF: "64 fl. oz." },
  { id: "91897", name: "Yoplait Original Low Fat Strawberry Yogurt", brandRaw: "Yoplait", sizeUF: "6 ounce" },
  { id: "92218", name: "Oui Yogurt, Whole Milk, Vanilla, French Style, Blended", brandRaw: "Oui", sizeUF: "5 ounce" },
  { id: "99458", name: "Wegmans Enriched Unbleached Bread Flour", brandRaw: "Wegmans", sizeUF: "5 lb." },
];

/** The pipeline's derived view of a row: normalised name, brand, canonical size. */
type Prepared = {
  item: Product;
  norm: string;
  brand: string;
  size: Size | null;
  sizeFromUF: boolean;
  vector: Map<string, number>;
};

const TOP_K = 5; // --top-k
const BAND_FLOOR = 0.3; // --low 0.30 in the shipped run
const TFIDF_FLOOR = 0.02; // candidates at or below this are skipped outright

function prepare(item: Product, vec: Vectorizer): Prepared {
  const norm = normalizeName(item.name);
  const fromUF = item.sizeUF ? parseSize(item.sizeUF) : null;
  return {
    item,
    norm,
    brand: extractBrand(item.brandRaw, norm),
    size: fromUF ?? parseSize(norm),
    sizeFromUF: fromUF !== null,
    vector: transform(vec, norm),
  };
}

/* The vectorizer is fitted once, over both stores' names, exactly as the
   pipeline does with vec.fit(fb.norm + fa.norm). A name typed into the box is
   transformed against this fixed vocabulary — unseen n-grams drop out, which is
   what happens to any row the production fit never saw. */
const VECTORIZER = fitVectorizer(
  [...STORE_B, ...STORE_A].map((p) => normalizeName(p.name)),
);
const PREPARED_B = STORE_B.map((p) => prepare(p, VECTORIZER));

type Candidate = {
  b: Prepared;
  tfidf: number;
  features: FeatureVec;
  terms: Term[];
  z: number;
  proba: number;
  composite: number;
  guards: string[];
};

/** Blocking then scoring, in the pipeline's order: top-K by cosine, then model. */
function rank(a: Prepared): Candidate[] {
  const blocked = PREPARED_B.map((b) => ({ b, tfidf: cosine(a.vector, b.vector) }))
    .sort((x, y) => y.tfidf - x.tfidf)
    .slice(0, TOP_K)
    .filter((c) => c.tfidf > TFIDF_FLOOR);

  return blocked
    .map(({ b, tfidf }) => {
      const features = pairFeatures(a.norm, b.norm, a.brand, b.brand, a.size, b.size, tfidf);
      const { terms, z, proba } = decompose(features);
      return {
        b, tfidf, features, terms, z, proba,
        composite: compositeScore(features),
        guards: decisiveReject(a.item, b.item, a.norm, b.norm),
      };
    })
    .sort((x, y) => y.proba - x.proba);
}

const fmtSize = (s: Size | null) => (s ? `${s.value}${s.unit}` : "—");

// ---------------------------------------------------------------------------

export function ProductMatcher() {
  const [queryId, setQueryId] = useState(STORE_A[1].id);
  const [text, setText] = useState(STORE_A[1].name);
  const [pickedId, setPickedId] = useState<string | null>(null);

  const preset = STORE_A.find((p) => p.id === queryId && p.name === text) ?? null;

  const { a, candidates } = useMemo(() => {
    const item: Product = preset ?? { id: "typed", name: text, brandRaw: null, sizeUF: null };
    const prepared = prepare(item, VECTORIZER);
    return { a: prepared, candidates: text.trim() ? rank(prepared) : [] };
  }, [text, preset]);

  const picked = candidates.find((c) => c.b.item.id === pickedId) ?? candidates[0] ?? null;
  const maxTerm = picked
    ? Math.max(...picked.terms.map((t) => Math.abs(t.contribution)), 0.001)
    : 1;

  return (
    <section className="mt-10 rounded border border-hair bg-raised">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hair px-4 py-3">
        <h2 className="font-prose text-base font-semibold text-bright">
          Walmart → Wegmans matcher — scored live
        </h2>
        <p className="font-mono text-xs text-dim">ported from match_products.py</p>
      </header>

      <div className="px-4 py-4">
        <p className="max-w-[68ch] text-sm text-muted">
          Every candidate below is scored by the shipped function: TF-IDF char n-gram
          blocking, then a 14-feature logistic model whose coefficients are read
          verbatim out of{" "}
          <span className="font-mono text-xs text-body">heuristic_model.json</span>.
          The catalogue is 24 Wegmans and 12 Walmart rows lifted from the repo&rsquo;s
          360-pair gold set — real names, real{" "}
          <span className="font-mono text-xs text-body">brand_raw</span>, real{" "}
          <span className="font-mono text-xs text-body">size_user_friendly</span> — not
          the 288k-row catalogues, which are company data.
        </p>

        {/* ---- query ---- */}
        <div className="mt-4">
          <label
            htmlFor="pm-query"
            className="font-mono text-xs text-faint"
          >
            store A item name
          </label>
          <input
            id="pm-query"
            type="text"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPickedId(null);
            }}
            spellCheck={false}
            className="mt-1 w-full rounded-sm border border-hair bg-sunken px-3 py-2 font-mono text-xs text-body outline-none focus:border-accent"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {STORE_A.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setQueryId(p.id);
                  setText(p.name);
                  setPickedId(null);
                }}
                aria-pressed={preset?.id === p.id}
                className={`rounded-sm border px-2 py-1 font-mono text-xs transition-colors ${
                  preset?.id === p.id
                    ? "border-accent text-accent"
                    : "border-hair text-dim hover:border-muted hover:text-body"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* ---- stage 1 ---- */}
        <Stage n={1} title="normalise" fn="normalize_name · parse_size · extract_brand">
          <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1 font-mono text-xs">
            <dt className="text-faint">name</dt>
            <dd className="break-words text-body">{a.norm || "—"}</dd>
            <dt className="text-faint">brand</dt>
            <dd className="text-body">
              {a.brand || "—"}{" "}
              <span className="text-faint">
                {a.item.brandRaw ? "(brand_raw)" : "(brand_raw empty → first two tokens)"}
              </span>
            </dd>
            <dt className="text-faint">size</dt>
            <dd className="text-body">
              {fmtSize(a.size)}{" "}
              <span className="text-faint">
                {a.size === null
                  ? "(no size token found)"
                  : a.sizeFromUF
                    ? "(from sizing_comp)"
                    : "(parsed out of the name)"}
              </span>
            </dd>
          </dl>
        </Stage>

        {/* ---- stage 2 + 3 ---- */}
        <Stage
          n={2}
          title="block, then score"
          fn={`TfidfVectorizer(char_wb, 3–5) → top ${TOP_K} of ${STORE_B.length} → model_proba`}
        >
          {candidates.length === 0 ? (
            <p className="font-mono text-xs text-faint">
              no candidate clears the {TFIDF_FLOOR} cosine floor.
            </p>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {candidates.map((c, i) => {
                const isPicked = picked?.b.item.id === c.b.item.id;
                return (
                  <li key={c.b.item.id}>
                    <button
                      type="button"
                      onClick={() => setPickedId(c.b.item.id)}
                      aria-pressed={isPicked}
                      className={`w-full rounded-sm border px-2.5 py-2 text-left transition-colors ${
                        isPicked
                          ? "border-accent bg-sunken"
                          : "border-hair-soft hover:border-muted"
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-3 font-mono text-xs">
                        <span className={isPicked ? "text-bright" : "text-body"}>
                          <span className="text-faint">{i + 1}. </span>
                          {c.b.item.name}
                        </span>
                        <span className="shrink-0 tabular-nums text-bright">
                          {c.proba.toFixed(3)}
                        </span>
                      </div>
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-sm bg-sunken">
                        <div
                          className="h-full bg-accent"
                          style={{ width: `${Math.max(1, c.proba * 100)}%` }}
                        />
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-xs tabular-nums text-faint">
                        <span>tfidf {c.tfidf.toFixed(3)}</span>
                        <span>size {fmtSize(c.b.size)}</span>
                        <span>brand {c.b.brand}</span>
                        <span>composite {c.composite.toFixed(3)}</span>
                        <span className={c.proba >= BAND_FLOOR ? "text-note" : "text-dim"}>
                          {c.proba >= BAND_FLOOR ? "→ adjudication band" : "dropped (< 0.30)"}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </Stage>

        {/* ---- decomposition ---- */}
        {picked && (
          <Stage
            n={3}
            title="why that score"
            fn="pair_features → StandardScaler → LogisticRegression"
          >
            <p className="mb-2 max-w-[68ch] text-sm text-muted">
              Each feature is standardised against the training mean and scale, then
              multiplied by its fitted weight. Sorted by how much the term moved the
              log-odds — the sum plus the intercept is what the sigmoid sees.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] font-mono text-xs">
                <thead>
                  <tr className="border-b border-hair-soft text-left text-faint">
                    <th className="py-1 pr-3 font-normal">feature</th>
                    <th className="py-1 pr-3 text-right font-normal">value</th>
                    <th className="py-1 pr-3 text-right font-normal">z</th>
                    <th className="py-1 pr-3 text-right font-normal">weight</th>
                    <th className="py-1 pr-3 text-right font-normal">w·z</th>
                    <th className="w-24 py-1 font-normal" />
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {[...picked.terms]
                    .sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution))
                    .map((t) => (
                      <tr key={t.name} className="border-b border-hair-soft">
                        <td className="py-1 pr-3 text-body">{t.name}</td>
                        <td className="py-1 pr-3 text-right text-muted">
                          {t.value.toFixed(3)}
                        </td>
                        <td className="py-1 pr-3 text-right text-dim">{t.z.toFixed(2)}</td>
                        <td className="py-1 pr-3 text-right text-dim">
                          {t.coef >= 0 ? "+" : ""}
                          {t.coef.toFixed(3)}
                        </td>
                        <td
                          className={`py-1 pr-3 text-right ${
                            t.contribution >= 0 ? "text-accent" : "text-warning"
                          }`}
                        >
                          {t.contribution >= 0 ? "+" : ""}
                          {t.contribution.toFixed(3)}
                        </td>
                        <td className="py-1">
                          <TermBar value={t.contribution} max={maxTerm} />
                        </td>
                      </tr>
                    ))}
                  <tr>
                    <td className="py-1.5 pr-3 text-faint">intercept</td>
                    <td colSpan={3} />
                    <td className="py-1.5 pr-3 text-right text-warning tabular-nums">
                      {MODEL.intercept.toFixed(3)}
                    </td>
                    <td />
                  </tr>
                  <tr>
                    <td className="pr-3 text-faint">σ(z), z = {picked.z.toFixed(3)}</td>
                    <td colSpan={3} />
                    <td className="pr-3 text-right text-bright tabular-nums">
                      {picked.proba.toFixed(3)}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </Stage>
        )}

        {/* ---- stages 4 + 5 ---- */}
        {picked && (
          <Stage n={4} title="adjudicate, then veto" fn="llm_adjudicate · decisive_reject">
            <ul className="flex flex-col gap-2 font-mono text-xs">
              <li className="text-dim">
                <span className="text-faint">gpt-5 nano · </span>
                {picked.proba >= BAND_FLOOR
                  ? "in band — strict prompt, 3 independent votes, kept on a majority. Not runnable here: no network."
                  : "never asked — below the 0.30 band floor the pair is dropped outright."}
              </li>
              <li className={picked.guards.length ? "text-error" : "text-dim"}>
                <span className="text-faint">guards · </span>
                {picked.guards.length
                  ? `vetoed — ${picked.guards.join("; ")}`
                  : "no decisive difference; nothing to veto."}
              </li>
            </ul>

            {preset && preset.gold.b === picked.b.item.id && (
              <div className="mt-3 rounded-sm border border-hair-soft bg-sunken px-2.5 py-2">
                <p className="font-mono text-xs text-faint">
                  this exact pair, in the shipped run
                </p>
                <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs text-dim">
                  <li>
                    hand label (blind gold set):{" "}
                    <span className={preset.gold.shopperMatch ? "text-accent" : "text-error"}>
                      {preset.gold.shopperMatch ? "a shopper would swap these" : "not the same product"}
                    </span>
                  </li>
                  <li>
                    production score:{" "}
                    <span className="tabular-nums text-body">
                      {preset.gold.prodScore.toFixed(4)}
                    </span>{" "}
                    <span className="text-faint">
                      (same function, IDF fitted over all 288k names — this page reads{" "}
                      {picked.proba.toFixed(4)} off a 36-name corpus)
                    </span>
                  </li>
                  <li>
                    outcome:{" "}
                    <span className="text-body">
                      {preset.gold.outcome === "shipped"
                        ? "confirmed by the judge, survived the guards, shipped in matches.csv"
                        : preset.gold.outcome === "llm-rejected"
                          ? "rejected by the judge — never reached the guards"
                          : "confirmed by the judge, then vetoed by a guard — one of the 150 dropped"}
                    </span>
                  </li>
                </ul>
              </div>
            )}
          </Stage>
        )}

        <p className="mt-6 max-w-[68ch] border-t border-hair-soft pt-3 text-sm text-muted">
          Two honest gaps. The TF-IDF feature is refitted over the 36 names on this
          page, so it runs hotter than production and the final probability drifts
          from the shipped one — the gold pairs above show both numbers side by side.
          And there is no category or price feature to show you: the scorer has
          neither. Category blocking falls out of the char n-grams for free, since a
          yogurt&rsquo;s name only really resembles other yogurt names.
        </p>
      </div>
    </section>
  );
}

function Stage({
  n,
  title,
  fn,
  children,
}: {
  n: number;
  title: string;
  fn: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-5 border-t border-hair-soft pt-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="font-mono text-xs text-muted">
          <span className="text-faint">{n} · </span>
          {title}
        </h3>
        <p className="font-mono text-xs text-faint">{fn}</p>
      </div>
      {children}
    </div>
  );
}

/** Diverging bar around a centre line: jade adds log-odds, orange removes them. */
function TermBar({ value, max }: { value: number; max: number }) {
  const pct = Math.min(50, (Math.abs(value) / max) * 50);
  return (
    <div className="relative h-1.5 w-full bg-sunken" aria-hidden="true">
      <div className="absolute inset-y-0 left-1/2 w-px bg-hair" />
      <div
        className={`absolute inset-y-0 ${value >= 0 ? "bg-accent" : "bg-warning"}`}
        style={
          value >= 0
            ? { left: "50%", width: `${pct}%` }
            : { right: "50%", width: `${pct}%` }
        }
      />
    </div>
  );
}
