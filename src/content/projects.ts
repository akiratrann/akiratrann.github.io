/*
  Every project is presented as a compiler diagnostic. `level` picks the
  severity word, `span` is the highlighted source line, and `help` is the
  trailing note — the same shape rustc uses.
*/
export type Level = "note" | "warning" | "error";

export type Project = {
  slug: string;
  name: string;
  /** Fake-but-plausible source location the diagnostic points at. */
  loc: string;
  level: Level;
  /** The diagnostic message itself — the one-line pitch. */
  headline: string;
  span?: { line: number; code: string; underline: string; label: string };
  help: string;
  year: string;
  stack: string[];
  context: string;
  repo?: string;
  demo?: string;
  /** Longer prose for the detail page. */
  body: string[];
  featured?: boolean;
};

export const projects: Project[] = [
  {
    slug: "morphic-ffi",
    name: "Morphic FFI",
    loc: "morphic/src/ffi.rs:112:9",
    level: "note",
    headline: "a foreign-function protocol that bridges any imperative or functional language",
    span: {
      line: 112,
      code: `pub extern "C" fn morphic_call(ctx: *mut Ctx) -> Abi`,
      underline: "                  ^^^^^^^^^^^^",
      label: "derived from the C ABI and Rust-C FFI",
    },
    help: "also fixed targeting, entry-point naming, runtime linking and symbol tables for the WebAssembly backend",
    year: "2025 - present",
    stack: ["Rust", "WebAssembly", "LLVM"],
    context: "Alex Aiken's Programming Languages Group, Stanford",
    featured: true,
    body: [
      "Morphic is a pure functional language developed in Alex Aiken's research group at Stanford. I work on the parts of it that decide whether anyone else can actually use it: the debugging output, the WebAssembly backend, and a foreign-function interface.",
      "The FFI is the current work. The goal is a protocol that can bridge between any imperative or functional language, rather than one pairing at a time. It takes its shape from the C ABI and from the Rust-C FFI, both of which solved a narrower version of the same problem.",
      "Before that I modified all twenty-five of the compiler's abstract syntax tree structures to emit debugging output. A pure functional compiler that cannot show you its own intermediate state is very hard to develop against, and that was the blocker for day-to-day use.",
      "On the WebAssembly side I fixed targeting, entry-point naming, runtime linking, and a symbol table issue that prevented compilation from completing.",
    ],
  },
  {
    slug: "skill-scanner",
    name: "Skill Scanner Adversary",
    loc: "socket/skills/scan.py:48:11",
    level: "warning",
    headline: "scanner reports this dependency clean; the dependency is not clean",
    span: {
      line: 48,
      code: "verdict = classify(skill.deps, binaries=True)",
      underline: "          ^^^^^^^^",
      label: "false negative surfaced here",
    },
    help: "accuracy now exceeds Snyk and GenTrustHub; scope extended to URL and cross-skill dependencies",
    year: "2026",
    stack: ["Python", "Binary analysis", "Supply-chain security"],
    context: "Socket.dev, security research internship",
    featured: true,
    body: [
      "Socket scans AI skills for malicious behaviour. My work is the adversarial half: finding the cases where the scanner says clean and is wrong, and the cases where it cries wolf.",
      "The most productive seam has been dependencies that arrive as binaries rather than source. A scanner that only reads scripts will approve a package whose actual payload is compiled. Improving detection there moved the scanner's accuracy past both Snyk's and GenTrustHub's on the same corpus.",
      "The scope is now widening past direct dependencies, into URLs a skill reaches for at runtime and into other skills it pulls in — the places where a supply chain stops being a tree and starts being a graph.",
    ],
  },
  {
    slug: "aetherion",
    name: "Aetherion",
    loc: "aetherion/Runtime/Bootstrap.cs:1:1",
    level: "note",
    headline: "the entire world, party and HUD are constructed at runtime",
    span: {
      line: 1,
      code: "void Build()  // no prefabs, no scene wiring",
      underline: "     ^^^^^",
      label: "one entry point builds everything",
    },
    help: "elemental reactions, a four-character party swappable mid-combo, stamina-gated climb/glide/swim traversal, artifact and gacha progression, cel-shaded",
    year: "2025",
    stack: ["Unity 6", "C#", "HLSL"],
    context: "Personal work",
    featured: true,
    body: [
      "An open-world action-RPG vertical slice, built around the systems that make the genre work rather than around its art: elemental reactions, a four-character party you swap between mid-combo, climb/glide/swim traversal gated by stamina, artifact and gacha progression, and a cel-shaded look.",
      "The constraint that shaped it: no art assets and no scene wiring. The whole world, the party, and the HUD are constructed at runtime from code. Nothing is authored in the Unity editor, which means the entire game is reviewable as a diff.",
      "That choice costs you the editor's conveniences and buys you a game whose behaviour is fully determined by source. It also made the systems work — damage formulas, reaction tables, gacha rates — testable without launching anything.",
    ],
  },
  {
    slug: "manhwa-studio",
    name: "Manhwa Studio",
    loc: "manhwa-studio/pipeline.py:1:1",
    level: "note",
    headline: "storyline to lettered vertical-scroll chapter, without leaving the machine",
    span: {
      line: 1,
      code: "storyline -> scenes -> panels -> blockout -> art -> lettering",
      underline: "^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^",
      label: "every stage runs locally",
    },
    help: "Blender for 3D blockout, ComfyUI for panel art, a model for scene and panel breakdown",
    year: "2025",
    stack: ["Python", "Blender", "ComfyUI"],
    context: "Personal work",
    repo: "https://github.com/akiratrann/manhwa-studio",
    featured: true,
    body: [
      "An end-to-end manhwa production tool. Characters and art styles go in; storyboarded and lettered vertical-scroll chapters come out.",
      "The pipeline runs storyline into scenes, scenes into panels, panels into a 3D blockout in Blender, the blockout into panel art through a local ComfyUI graph, then lettering and export to a webtoon strip.",
      "Everything runs on your own machine. That is the point rather than a limitation: nothing about an unfinished comic is sent anywhere, and the whole pipeline works without a network.",
    ],
  },
  {
    slug: "lingobridge",
    name: "LingoBridge",
    loc: "lingobridge/src/handoff.ts:24:3",
    level: "note",
    headline: "a translator you can hand to a stranger",
    span: {
      line: 24,
      code: "await speak(phrase, theirLanguage);  // then pass the phone over",
      underline: "                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^",
      label: "the interaction the app is designed around",
    },
    help: "their reply comes back translated, split word by word, with the grammar explained",
    year: "2025",
    stack: ["TypeScript", "Speech", "Translation"],
    context: "Personal work",
    repo: "https://github.com/akiratrann/lingobridge",
    body: [
      "You pick what you need to say. The phone says it in their language. You hand the phone over, they answer out loud, and you get their reply back translated.",
      "The part that makes it more than a translation box: the reply is split word by word with the grammar explained, so you leave the conversation knowing something you did not know before.",
      "Most translation apps optimise for getting through the exchange. This one optimises for the exchange teaching you something.",
    ],
  },
  {
    slug: "pocket-planet",
    name: "Pocket Planet",
    loc: "pocket-planet/rank.ts:76:15",
    level: "note",
    headline: "recommendations ranked by how strongly real sources back them, not invented",
    span: {
      line: 76,
      code: "score = agreement(wikivoyage, osm, lonelyPlanet, reddit, youtube)",
      underline: "        ^^^^^^^^^",
      label: "sources are mined and cited, never generated",
    },
    help: "grouped by category, in the traveller's own language",
    year: "2025",
    stack: ["TypeScript", "OpenStreetMap", "Data mining"],
    context: "Personal work",
    repo: "https://github.com/akiratrann/pocket-planet",
    body: [
      "A travel guide and map for anywhere in the world. Search a place and get the best things to do there, ranked by how strongly real travel sources recommend them.",
      "Sources are mined and cited rather than invented: Wikivoyage, OpenStreetMap, Lonely Planet editorial, YouTube, Travel Stack Exchange and Reddit. A recommendation's rank comes from agreement across those sources, and every entry can be traced back.",
      "Results are grouped by category and served in the traveller's language.",
    ],
  },
  {
    slug: "payback",
    name: "Payback",
    loc: "payback/src/split.ts:31:7",
    level: "note",
    headline: "photograph a receipt, tap who had what, send everyone a prefilled request",
    span: {
      line: 31,
      code: "localStorage.setItem(billId, bill);  // no accounts, no backend",
      underline: "^^^^^^^^^^^^",
      label: "every bill lives in the browser",
    },
    help: "a Next.js PWA: runs as a website, installs to the home screen on iOS",
    year: "2025",
    stack: ["Next.js", "TypeScript", "PWA"],
    context: "Personal work",
    repo: "https://github.com/akiratrann/payback",
    body: [
      "Split bills, get paid. Photograph a receipt, tap who had what, and send everyone a prefilled payment request.",
      "No accounts, no fees, no backend — every bill lives in your browser's local storage. There is nothing to sign up for and nothing to leak.",
      "It is a Next.js progressive web app, so it runs as an ordinary website and installs to the home screen on iOS.",
    ],
  },
  {
    slug: "twoshot",
    name: "twoshot",
    loc: "twoshot/api/jobs.py:19:5",
    level: "note",
    headline: "flat JSON in, diffusion node graphs out, on Apple Silicon",
    span: {
      line: 19,
      code: "graph = compile_request(payload)  # FastAPI in front, ComfyUI behind",
      underline: "        ^^^^^^^^^^^^^^^",
      label: "the split is the point",
    },
    help: "the API is the part you would deploy; ComfyUI is a worker you can move to a cloud GPU without touching the app",
    year: "2025",
    stack: ["Python", "FastAPI", "ComfyUI"],
    context: "Personal work",
    repo: "https://github.com/akiratrann/twoshot",
    body: [
      "A local anime image generator running entirely on Apple Silicon. ComfyUI does the diffusion; a small FastAPI service in front turns flat JSON requests into node graphs and exposes them as async jobs.",
      "That split is deliberate. The API is the piece worth keeping and deploying; ComfyUI is a worker that can later move to a cloud GPU without a line of the application changing.",
      "Also drives a Blender-composited illustration pipeline for BL and manhwa panels.",
    ],
  },
  {
    slug: "cloudflare-code-assistant",
    name: "Cloudflare Code Assistant",
    loc: "worker/src/index.ts:12:1",
    level: "note",
    headline: "an AI coding assistant running entirely on Cloudflare's edge",
    span: {
      line: 12,
      code: "export default { fetch };  // Workers, Durable Objects, Workers AI",
      underline: "                 ^^^^^",
      label: "one entry point, no origin server",
    },
    help: "state in Durable Objects, inference through Workers AI, deployed with wrangler",
    year: "2025",
    stack: ["TypeScript", "Cloudflare Workers", "Durable Objects"],
    context: "Personal work",
    repo: "https://github.com/akiratrann/cloudflare-code-assistant",
    body: [
      "A coding assistant built on Cloudflare's platform: Workers for the request path, Durable Objects for per-conversation state, and Workers AI for inference.",
      "There is no origin server. The whole application is the edge deployment, which keeps latency low and the moving parts few.",
    ],
  },
  {
    slug: "betterbasket-product-matching",
    name: "Product Matching",
    loc: "betterbasket/match.py:64:9",
    level: "note",
    headline: "link 233k Walmart products to their closest Wegmans equivalent",
    span: {
      line: 64,
      code: "pair = nearest(walmart_item, wegmans_index)",
      underline: "       ^^^^^^^",
      label: "exact matches and reasonable substitutes both count",
    },
    help: "once linked, prices compare like-for-like across stores",
    year: "2025",
    stack: ["Python", "Embeddings", "Record linkage"],
    context: "BetterBasket take-home",
    repo: "https://github.com/akiratrann/betterbasket-product-matching",
    body: [
      "Take each product in one grocery store's catalogue (Walmart, roughly 233,000 items) and find the single closest product in another's (Wegmans, roughly 55,000).",
      "Closest covers two different problems. Exact matches are the same national-brand product under two SKUs. Non-exact matches are private-label or fresh items a shopper would happily swap for one another — a much softer target.",
      "Once the two catalogues are linked, prices can be compared like-for-like rather than by category average.",
    ],
  },
  {
    slug: "stylized-shading",
    name: "Stylized Shading",
    loc: "cs248a/asst4/shade.cu:88:3",
    level: "note",
    headline: "non-photorealistic shading, written for the GPU",
    span: {
      line: 88,
      code: "float band = quantize(dot(n, l), steps);",
      underline: "             ^^^^^^^^",
      label: "the cel-shading step",
    },
    help: "CS248A, Stanford — real-time computer graphics",
    year: "2025",
    stack: ["CUDA", "Graphics", "Jupyter"],
    context: "CS248A, Stanford",
    repo: "https://github.com/akiratrann/cs248a_asst4_Stylized_Shading",
    body: [
      "A stylized, non-photorealistic shading assignment from Stanford's real-time graphics course: quantised diffuse banding, edge detection for outlines, and the tuning that separates cel-shading that reads well from cel-shading that reads as a bug.",
      "The same techniques underpin Aetherion's look.",
    ],
  },
];

export const featured = projects.filter((p) => p.featured);

export function projectBySlug(slug: string) {
  return projects.find((p) => p.slug === slug);
}
