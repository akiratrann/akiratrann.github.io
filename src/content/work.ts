/*
  One index, one type, no second half.

  Entries are grouped by the FORM the artifact takes, never by discipline —
  which is what lets a museum object study and a compiler FFI sit in the same
  list without either being a guest. `also` lists the substrate a piece is
  built on; techniques recur across forms (cel-shading turns up in a game, a
  comic pipeline and a graphics assignment), so the coherence is something a
  reader notices rather than something the bio claims.
*/

import type { DemoKey } from "@/components/demos/registry";

export type Form = "language" | "adversarial" | "world" | "study" | "app";
export type Status = "active" | "shipped" | "archived";

export type Entry = {
  slug: string;
  name: string;
  form: Form;
  /** What he actually did — the verb, not the job title. */
  role: string;
  /** Who it was made with or for. "Solo" is a real answer. */
  with: string;
  status: Status;
  year: string;
  /** One line. This is what most entries get. */
  summary: string;
  /** Underlying techniques. Recurrence across forms is the point. */
  also: string[];
  stack?: string[];
  repo?: string;
  demo?: string;
  /** Case studies get a detail page; entries are one-liners. */
  depth: "case-study" | "entry";
  body?: string[];
  /** Interactive demos rendered on the detail page, keyed into the registry. */
  interactive?: DemoKey[];
  /**
   * Screen captures. Nothing is listed until a real capture exists — the
   * visual work should be shown, not described, but not with a placeholder.
   */
  media?: { src: string; alt: string; width: number; height: number }[];
};

export const forms: { key: Form; title: string; note: string }[] = [
  {
    key: "language",
    title: "Languages & runtimes",
    note: "Compilers, agents, and things that execute other things.",
  },
  {
    key: "adversarial",
    title: "Adversarial work",
    note: "Finding what a system misses when it says everything is fine.",
  },
  {
    key: "world",
    title: "Worlds & pictures",
    note: "Games, renderers, and pipelines that produce images.",
  },
  {
    key: "study",
    title: "Studies & scripts",
    note: "Research and writing about objects, conversations, and stories.",
  },
  {
    key: "app",
    title: "Apps",
    note: "Software built to be handed to someone.",
  },
];

export const work: Entry[] = [
  // ---- Languages & runtimes -------------------------------------------
  {
    slug: "morphic-ffi",
    name: "Morphic FFI",
    form: "language",
    role: "Compiler internals and foreign-function interface",
    with: "Alex Aiken's Programming Languages Group, Stanford",
    status: "active",
    year: "2025 —",
    summary:
      "A foreign-function protocol for a pure functional language, drawn from the C ABI and the Rust–C FFI.",
    also: ["static analysis", "AST transformation", "ABI design"],
    stack: ["Rust", "WebAssembly", "LLVM"],
    depth: "case-study",
    interactive: ["compiler-pipeline"],
    body: [
      "Morphic is a pure functional language developed in Alex Aiken's research group at Stanford. I work on the parts of it that decide whether anyone else can actually use it: the debugging output, the WebAssembly backend, and a foreign-function interface.",
      "The FFI is the current work. The goal is a protocol that can bridge between any imperative or functional language, rather than one pairing at a time. It takes its shape from the C ABI and from the Rust–C FFI, both of which solved a narrower version of the same problem.",
      "Before that I worked across all twenty-five data modules in the compiler's common crate so the intermediate representations could emit debugging output, and eleven pretty-printers now cover thirteen of the pipeline's stages, eight of which dump an artifact you can diff between runs. A pure functional compiler that cannot show you its own intermediate state is very hard to develop against, and that was the blocker for day-to-day use.",
      "On the WebAssembly side I fixed targeting, entry-point naming, runtime linking, and a symbol table issue that prevented compilation from completing.",
    ],
  },
  {
    slug: "cloudflare-code-assistant",
    name: "Cloudflare Code Assistant",
    form: "language",
    role: "Built an AI coding agent that runs at the edge",
    with: "Solo",
    status: "shipped",
    year: "2025",
    summary:
      "A coding assistant running on Workers, with the agent loop and its tools living next to the runtime that executes them.",
    also: ["agent orchestration", "edge runtime"],
    stack: ["TypeScript", "Cloudflare Workers", "Durable Objects"],
    repo: "https://github.com/akiratrann/cloudflare-code-assistant",
    depth: "case-study",
    interactive: ["prompt-assembly"],
    body: [
      "An agentic coding assistant that runs on Cloudflare's edge. The Worker is the orchestration layer: it holds the prompts, calls Workers AI, reads and writes KV for memory and collaboration, and serves the editor. Prompts and secrets never reach the browser.",
      "The part worth showing is project handoff. When you open a project someone shared with you, your chat panel is empty — but the Worker injects the original owner's conversation into the system prompt as read-only context. You can ask why a function is written the way it is and get an answer grounded in a discussion you were never part of.",
      "Most assistants treat chat as disposable and per-user. Here the reasoning behind a codebase travels with the code. Sharing is addressed to a username with separate incoming and outgoing indexes, so there is no public link to guess.",
    ],
  },
  {
    slug: "robinhoodbot",
    name: "robinhoodbot",
    form: "language",
    role: "Built a rules-based trading service",
    with: "Solo",
    status: "active",
    year: "2025 —",
    summary:
      "A rules engine for equities and crypto across three brokerages, with backtesting, walk-forward validation and hard risk halts.",
    also: ["backtesting", "risk control", "time-series"],
    stack: ["Python", "Alpaca", "Schwab"],
    depth: "case-study",
    interactive: ["strategy-backtest"],
    body: [
      "A rules engine that trades equities and crypto across three brokerages. The interesting half is not the trading, it is the machinery that stops a strategy fooling you: a backtest harness, walk-forward validation, and risk gates that halt the engine rather than trusting a rule to behave.",
      "The strategy in the demo is the real one — slope reversal, with the engine's own exit gates layered on: a maximum holding period that forces an exit after N days, a cooldown that blocks immediate re-entry into a symbol just sold, and a never-sell-at-loss rule that refuses to realise a losing position.",
      "That last gate is the one worth arguing about. It guarantees every completed sale is a win, which flatters the win rate and quietly converts losses into positions held indefinitely. The backtest shows both numbers so the tradeoff is visible rather than hidden.",
    ],
  },

  // ---- Adversarial work -----------------------------------------------
  {
    slug: "skill-scanner",
    name: "Skill Scanner Adversary",
    form: "adversarial",
    role: "Security research on malicious-package detection",
    with: "Socket.dev",
    status: "active",
    year: "2026",
    summary:
      "Finding the cases where a malware scanner says clean and is wrong — particularly dependencies that arrive as binaries rather than source.",
    also: ["static analysis", "binary inspection", "adversarial testing"],
    stack: ["Python", "Binary analysis", "Supply-chain security"],
    depth: "case-study",
    interactive: ["scanner-evasion"],
    body: [
      "Socket scans AI skills for malicious behaviour. My work is the adversarial half: finding the cases where the scanner says clean and is wrong, and the cases where it cries wolf.",
      "The most productive seam has been dependencies that arrive as binaries rather than source. A scanner that only reads scripts will approve a package whose actual payload is compiled. Improving detection there moved the scanner's accuracy past both Snyk's and GenTrustHub's on the same corpus.",
      "The scope is now widening past direct dependencies, into URLs a skill reaches for at runtime and into other skills it pulls in — the places where a supply chain stops being a tree and starts being a graph.",
    ],
  },

  // ---- Worlds & pictures ----------------------------------------------
  {
    slug: "aetherion",
    name: "Aetherion",
    form: "world",
    role: "Built an open-world action RPG with no authored scenes",
    with: "Solo",
    status: "active",
    year: "2025 —",
    summary:
      "Elemental auras tracked as decaying gauges rather than flags, in a game whose committed scene is 181 lines of YAML holding a single GameObject.",
    also: ["cel-shading / NPR", "runtime construction", "systems maths"],
    stack: ["Unity 6", "C#", "HLSL"],
    depth: "case-study",
    interactive: ["elemental-sandbox", "cel-shading"],
    body: [
      "An action-RPG vertical slice. The elemental maths you can transcribe from a wiki; what taught me something was ownership of mutable state across character swaps, cancels and pause menus.",
      "Auras are gauges rather than flags. A hit banks 80% of its declared units but derives decay from the declared value — U / (2.5U + 7) per second — so 1U, 2U and 4U applications live 7.6s, 9.6s and 13.6s. Freeze sits above that stack as its own shell, with its thaw rate latched at the moment of freezing; recomputing it per frame as the gauge shrank made freeze decelerate and stretched a 2U/2U pairing to roughly 23 seconds.",
      "Most of the hard bugs were ownership bugs, and the comments in the source are post-mortems. Hit-stop owns a single global flag rather than capturing Time.timeScale, because a swap inside the 45ms window left the game stuck at 5% speed with no way back. Cooldowns charge before the cast wait, because committing them after let a swap-cancel refund the whole ability and keep the i-frames. Two components each assigning maxHP — one pre-resonance, one post — silently drained about 9% of HP on every swap.",
      "Off-field abilities snapshot the caster's resolved stats when they spawn but still forward damage feedback to the live actor. Before that, an Electro turret ticking after you swapped away scaled off whichever character was now on field, which made off-field characters impossible to build.",
      "The whole world, party and HUD are constructed at runtime: the committed scene is 181 lines of YAML holding one GameObject. There are no prefabs, no meshes and no texture assets — every visible object is a Unity primitive under two hand-written URP cel shaders. Adding URP/Lit to Always Included Shaders took the build from 295 shader variants to 294,912, which is why only my own two are registered.",
      "It is a systems demo in programmer geometry: no art, no audio, no save file.",
    ],
  },
  {
    slug: "manhwa-studio",
    name: "Manhwa Studio",
    form: "world",
    role: "Built an end-to-end comic production pipeline",
    with: "Solo",
    status: "active",
    year: "2025 —",
    summary:
      "Storyline in, lettered vertical-scroll chapter out, with every stage running on your own machine.",
    also: ["cel-shading / NPR", "3D blockout", "pipeline orchestration"],
    stack: ["Python", "Blender", "ComfyUI"],
    repo: "https://github.com/akiratrann/manhwa-studio",
    depth: "case-study",
    interactive: ["pipeline-stepper"],
    body: [
      "An end-to-end manhwa production tool. Characters and art styles go in; storyboarded and lettered vertical-scroll chapters come out.",
      "The pipeline runs storyline into scenes, scenes into panels, panels into a 3D blockout in Blender, the blockout into panel art through a local ComfyUI graph, then lettering and export to a webtoon strip.",
      "Everything runs on your own machine. That is the point rather than a limitation: nothing about an unfinished comic is sent anywhere, and the whole pipeline works without a network.",
    ],
  },
  {
    slug: "twoshot",
    name: "animagen",
    form: "world",
    role: "Built a local image generator with a deployable API in front",
    with: "Solo",
    status: "shipped",
    year: "2025",
    summary:
      "A FastAPI service that turns flat JSON into ComfyUI node graphs, so the API is the part you keep and the GPU worker is swappable.",
    also: ["diffusion pipelines", "async job APIs", "pipeline orchestration"],
    stack: ["Python", "FastAPI", "ComfyUI"],
    repo: "https://github.com/akiratrann/twoshot",
    depth: "case-study",
    interactive: ["node-graph"],
    body: [
      "A local anime image generator. ComfyUI does the diffusion; a small FastAPI service in front of it turns flat JSON requests into ComfyUI node graphs and exposes them as async jobs.",
      "That split is the whole bet. The API is the part you would keep and deploy; ComfyUI is a worker you can later move to a cloud GPU without changing a line of the app. The translation from a flat request to a wired graph is where the work actually lives, so that is what the demo shows.",
    ],
  },
  {
    slug: "stylized-shading",
    name: "Stylized Shading",
    form: "world",
    role: "Non-photorealistic renderer",
    with: "CS248A, Stanford",
    status: "archived",
    year: "2025",
    summary:
      "Cel-shading and colour quantization in a real-time renderer, written for Stanford's interactive computer graphics course.",
    also: ["cel-shading / NPR", "colour quantization"],
    stack: ["C++", "OpenGL", "GLSL"],
    repo: "https://github.com/akiratrann/cs248a_asst4_Stylized_Shading",
    depth: "entry",
  },

  // ---- Studies & scripts ----------------------------------------------
  {
    slug: "cantor-objects",
    name: "Three Objects from the Cantor",
    form: "study",
    role: "Year-long object research, then guiding tours on it",
    with: "Cantor Arts Center, Stanford",
    status: "active",
    year: "2024 —",
    summary:
      "A year researching three works from the permanent collection, trained in the theory and practice of guiding, now leading tours on them.",
    also: ["object research", "close looking", "public speaking"],
    depth: "entry",
  },
  {
    slug: "haiku-project",
    name: "The Haiku Project",
    form: "study",
    role: "Human-subjects research: transcription and behavioural coding",
    with: "Sharing Conversation: A Core Human Experience Across Life, Stanford",
    status: "shipped",
    year: "2024",
    summary:
      "Transcribed and coded four of twenty studies pairing older adults with dementia and younger participants, analysing conversational coherence and dissonance.",
    also: ["human-subjects research", "behavioural coding", "transcription"],
    depth: "entry",
  },
  {
    slug: "baboon-animation",
    name: "Bellyfoo & Reggie Rex",
    form: "study",
    role: "Television script editing and story structure",
    with: "Baboon Animation, Brooklyn",
    status: "shipped",
    year: "2024",
    summary:
      "Five script explodes for two lead writers, client notes into four scripts, two episodes edited, and cue-counting led across fifty more.",
    also: ["script editing", "story structure", "production coordination"],
    depth: "entry",
  },

  // ---- Apps ------------------------------------------------------------
  {
    slug: "payback",
    name: "Payback",
    form: "app",
    role: "Built a receipt-splitting PWA with no backend",
    with: "Solo",
    status: "shipped",
    year: "2025",
    summary:
      "Photograph a receipt, tap who had what, send everyone a prefilled payment request. Every bill lives in your own browser.",
    also: ["offline-first", "local storage", "PWA"],
    stack: ["Next.js", "TypeScript"],
    repo: "https://github.com/akiratrann/payback",
    depth: "case-study",
    interactive: ["receipt-splitter"],
    body: [
      "Photograph a receipt, tap who had what, and send everyone a prefilled payment request. No accounts, no fees, no backend — every bill lives in your browser's local storage, and it installs to the home screen on iOS.",
      "The arithmetic is fussier than it looks. Shared items divide proportionally, tax and tip are apportioned by each person's share of the subtotal, and the rounding has to sum back to the bill exactly — so the remainder cent has to land somewhere deliberate rather than being dropped.",
    ],
  },
  {
    slug: "lingobridge",
    name: "LingoBridge",
    form: "app",
    role: "Built a translator designed to be handed over",
    with: "Solo",
    status: "shipped",
    year: "2025",
    summary:
      "You say it, they answer out loud, and their reply comes back split word by word with the grammar explained.",
    also: ["speech interfaces", "translation", "grammar analysis"],
    stack: ["TypeScript", "Speech", "Translation"],
    repo: "https://github.com/akiratrann/lingobridge",
    depth: "entry",
  },
  {
    slug: "pocket-planet",
    name: "Pocket Planet",
    form: "app",
    role: "Built a travel guide that cites its sources",
    with: "Solo",
    status: "shipped",
    year: "2025",
    summary:
      "Recommendations mined and cited from Wikivoyage, OpenStreetMap, Lonely Planet and Reddit rather than invented, ranked by how strongly real sources agree.",
    also: ["source mining", "ranking", "citation"],
    stack: ["TypeScript", "OpenStreetMap"],
    repo: "https://github.com/akiratrann/pocket-planet",
    depth: "entry",
  },
  {
    slug: "alter-grab",
    name: "Alter Grab",
    form: "app",
    role: "Built a ride-hailing and delivery app around a pricing thesis",
    with: "Solo",
    status: "shipped",
    year: "2025",
    summary:
      "A 15% ride commission against an industry 25%, with the fare itemised for the driver as well as the rider — and the card-processing fee absorbed rather than passed on.",
    also: ["marketplace pricing", "fare transparency"],
    stack: ["TypeScript", "React Native"],
    repo: "https://github.com/akiratrann/alter_grab",
    depth: "case-study",
    interactive: ["fare-breakdown"],
    body: [
      "A ride-hailing and delivery app built around one bet: that transparency is the feature. Effective take rates at the incumbents run 25% and upward, and the fare a driver actually receives is rarely shown to them in parts.",
      "The engine commissions 15% on rides and 18% on a merchant's items total, and the itemised breakdown is rendered for both sides. Surge multiplies the metered portion only — never the booking fee — and the minimum fare is applied afterwards as a floor on the gross. On food, the courier keeps the delivery fee and the whole tip; neither is ever commissioned.",
      "Card processing is absorbed by the platform rather than passed through. That is a real cost, not a rounding detail: on a minimum-fare bike trip the fixed processing fee outruns the commission it comes out of and the platform runs the trip at a loss, while the driver's payout is untouched. The demo surfaces that row, because a pricing thesis you cannot audit is just marketing.",
    ],
  },
  {
    slug: "betterbasket-product-matching",
    name: "BetterBasket Product Matching",
    form: "app",
    role: "Matched 233k grocery products against 55k",
    with: "BetterBasket (take-home)",
    status: "shipped",
    year: "2025",
    summary:
      "Linking every Walmart item to its closest Wegmans counterpart — exact national-brand matches and the private-label swaps a shopper would accept.",
    also: ["nearest-neighbour matching", "embeddings", "record linkage"],
    stack: ["Python", "Embeddings"],
    repo: "https://github.com/akiratrann/betterbasket-product-matching",
    depth: "case-study",
    interactive: ["product-matcher"],
    body: [
      "Take every product in one grocery store — Walmart, around 233,000 items — and find its closest counterpart in another, Wegmans, at about 55,000. Closest covers two different problems: the same national-brand product appearing in both, and the private-label or fresh item a shopper would happily swap for it.",
      "It runs as a funnel rather than one big similarity score. Cheap blocking narrows the candidate set, lexical and TF-IDF features rank what survives, size and unit strings are normalised so a 12 oz bag and a 340 g bag can meet, and only the genuinely ambiguous pairs reach the expensive adjudication stage.",
      "Once the links exist, prices compare like for like — which is the entire point, and the reason a bad match is worse than no match.",
    ],
  },
];

export const caseStudies = work.filter((e) => e.depth === "case-study");

export function byForm(form: Form) {
  return work.filter((e) => e.form === form);
}

export function findEntry(slug: string) {
  return work.find((e) => e.slug === slug);
}

/** Techniques that show up in more than one entry, most-recurrent first. */
export function recurringTechniques() {
  const counts = new Map<string, number>();
  for (const e of work) {
    for (const t of e.also) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1]);
}
