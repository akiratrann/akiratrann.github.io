/*
  One index, one type, no second half.

  Entries are grouped by the FORM the artifact takes, never by discipline —
  which is what lets a museum object study and a compiler FFI sit in the same
  list without either being a guest. `also` lists the substrate a piece is
  built on; techniques recur across forms (cel-shading turns up in a game, a
  comic pipeline and a graphics assignment), so the coherence is something a
  reader notices rather than something the bio claims.
*/

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
    body: [
      "Morphic is a pure functional language developed in Alex Aiken's research group at Stanford. I work on the parts of it that decide whether anyone else can actually use it: the debugging output, the WebAssembly backend, and a foreign-function interface.",
      "The FFI is the current work. The goal is a protocol that can bridge between any imperative or functional language, rather than one pairing at a time. It takes its shape from the C ABI and from the Rust–C FFI, both of which solved a narrower version of the same problem.",
      "Before that I modified all twenty-five of the compiler's abstract syntax tree structures to emit debugging output. A pure functional compiler that cannot show you its own intermediate state is very hard to develop against, and that was the blocker for day-to-day use.",
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
    depth: "entry",
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
    depth: "entry",
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
      "An action-RPG vertical slice whose entire world, party and HUD are constructed at runtime from code — no prefabs, no scene wiring.",
    also: ["cel-shading / NPR", "runtime construction", "systems maths"],
    stack: ["Unity 6", "C#", "HLSL"],
    depth: "case-study",
    body: [
      "An open-world action-RPG vertical slice, built around the systems that make the genre work rather than around its art: elemental reactions, a four-character party you swap between mid-combo, climb/glide/swim traversal gated by stamina, artifact and gacha progression, and a cel-shaded look.",
      "The constraint that shaped it: no art assets and no scene wiring. The whole world, the party, and the HUD are constructed at runtime from code. Nothing is authored in the Unity editor, which means the entire game is reviewable as a diff.",
      "That choice costs you the editor's conveniences and buys you a game whose behaviour is fully determined by source. It also made the systems work — damage formulas, reaction tables, gacha rates — testable without launching anything.",
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
    depth: "entry",
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
    depth: "entry",
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
      "10% on rides and 12% on food against an industry 20–30%, with an itemised fare breakdown shown to both riders and drivers.",
    also: ["marketplace pricing", "fare transparency"],
    stack: ["TypeScript", "React Native"],
    repo: "https://github.com/akiratrann/alter_grab",
    depth: "entry",
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
    depth: "entry",
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
