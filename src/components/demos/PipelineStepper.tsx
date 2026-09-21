"use client";

import { useMemo, useState, useSyncExternalStore } from "react";

/*
  Manhwa Studio's chapter pipeline, ported to the browser.

  ~/manhwa-studio turns a storyline into a lettered vertical-scroll chapter on
  one machine. Nothing below calls out: every stage is a transcription of the
  Python that runs locally —

    backend/app/models.py                    the schemas every stage speaks
    backend/app/services/director.py         storyline -> scenes -> panels
    backend/app/services/poses.py            pose inference, panel pose plan
    backend/app/services/prompt_builder.py   panel -> (positive, negative)
    backend/app/services/blender_bridge.py   panel -> 3D blockout + camera
    backend/app/services/render.py           ControlNet weighting by shot
    backend/app/services/comfy.py            the ComfyUI API-format graph
    backend/app/services/lettering.py        balloon sizing, placement, tails
    backend/app/services/export.py           webtoon strip + slicing

  The app asks Claude for the story breakdown when credentials are present and
  falls back to a rule-based pass when they are not. The fallback is what is
  ported here, because it is the half that is deterministic and offline — the
  same path the app itself takes with no key, and the route says so in as many
  words: "Ran the offline breakdown. It splits on paragraphs and sentences and
  infers setting/time/mood from keywords." Everything downstream of the
  breakdown is the only path there is: prompts, staging, the graph and the
  lettering are pure functions of the panel data in every configuration.

  No image is generated. The point is the shape of the data — that a storyline
  becomes structured, machine-checkable panel geometry long before a pixel.
*/

// ==========================================================================
// Project fixtures — real records out of the repo, not invented sample data
// ==========================================================================

type Presentation = "auto" | "male" | "female" | "androgynous";

type Outfit = { id: string; name: string; description: string; tokens: string[] };

type Appearance = {
  hair: string;
  hair_color: string;
  eyes: string;
  eye_color: string;
  face: string;
  build: string;
  height_cm: number | null;
  skin: string;
  distinguishing: string[];
};

type Character = {
  id: string;
  name: string;
  role: string;
  age_look: string;
  pronouns: string;
  presentation: Presentation;
  presentation_bias: number;
  appearance: Appearance;
  outfits: Outfit[];
  default_outfit_id: string | null;
  identity_seed: number;
  extra_tokens: string[];
  negative_tokens: string[];
};

/** projects/prj_fedb603e54/project.json — the cast as it is actually stored. */
const CHARACTERS: Character[] = [
  {
    id: "chr_76bfd9b809",
    name: "Jin",
    role: "lead",
    age_look: "early 20s",
    pronouns: "he/him",
    presentation: "male",
    presentation_bias: 0.0,
    appearance: {
      hair: "overgrown chin-length, parted left",
      hair_color: "ash blond",
      eyes: "sharp, tired",
      eye_color: "grey",
      face: "fine features, sharp jaw",
      build: "lean",
      height_cm: 182,
      skin: "pale",
      distinguishing: [],
    },
    outfits: [
      {
        id: "fit_a",
        name: "knit",
        description: "oversized grey knit sweater, sleeves past the wrists",
        tokens: [],
      },
    ],
    default_outfit_id: "fit_a",
    identity_seed: 1835917463,
    extra_tokens: [],
    negative_tokens: [],
  },
  {
    id: "chr_486a339212",
    name: "Haeun",
    role: "lead",
    age_look: "late twenties",
    pronouns: "they/them",
    presentation: "male",
    presentation_bias: 0.0,
    appearance: {
      hair: "soft layered",
      hair_color: "black",
      eyes: "almond",
      eye_color: "dark brown",
      face: "",
      build: "slim",
      height_cm: 168,
      skin: "",
      distinguishing: [],
    },
    outfits: [],
    default_outfit_id: null,
    identity_seed: 2058836529,
    extra_tokens: [],
    negative_tokens: [],
  },
];

type StyleProfile = {
  name: string;
  positive_tokens: string[];
  negative_tokens: string[];
  palette: string[];
  color_mode: string;
  line: { weight: string; cleanliness: string; hatching: string };
  tone: {
    shading: string;
    screentone: boolean;
    contrast: number;
    rim_light: boolean;
    bloom: number;
  };
  render: {
    sampler: string;
    scheduler: string;
    steps: number;
    cfg: number;
    clip_skip: number;
    checkpoint: string | null;
  };
  control: {
    depth_strength: number;
    depth_end: number;
    lineart_strength: number;
    lineart_end: number;
    pose_strength: number;
    enabled: boolean;
  };
  proportions: string;
  lettering_font: string;
};

/** backend/app/styles.py — builtin_styles()[0], the project default. */
const STYLE: StyleProfile = {
  name: "Studio Default — Modern Korean Webtoon",
  positive_tokens: [
    "korean webtoon art style",
    "manhwa illustration",
    "clean digital lineart",
    "soft cel shading with gradients",
    "beautiful detailed eyes",
    "glossy hair highlights",
    "warm skin tones",
    "cinematic soft lighting",
    "high detail",
    "masterpiece",
  ],
  // BASE_NEGATIVE, appended to every builtin pack by styles._style().
  negative_tokens: [
    "lowres", "bad anatomy", "bad hands", "extra fingers", "fused fingers",
    "missing fingers", "extra limbs", "deformed", "mutated", "watermark",
    "signature", "text artifacts", "jpeg artifacts", "blurry", "worst quality",
    "low quality", "amateur", "out of frame", "cropped head", "disfigured face",
    "asymmetrical eyes",
  ],
  palette: ["#f4d9cc", "#e8a08c", "#9c6f8f", "#4a4666", "#2b2740", "#f7f3ee"],
  color_mode: "full_color",
  line: { weight: "variable", cleanliness: "clean", hatching: "none" },
  tone: { shading: "soft", screentone: false, contrast: 0.45, rim_light: true, bloom: 0.2 },
  render: {
    sampler: "dpmpp_2m_sde",
    scheduler: "karras",
    steps: 28,
    cfg: 5.5,
    clip_skip: -2,
    checkpoint: null,
  },
  control: {
    depth_strength: 0.55,
    depth_end: 0.75,
    lineart_strength: 0.45,
    lineart_end: 0.6,
    pose_strength: 0.7,
    enabled: true,
  },
  proportions: "8 to 8.5-head, long legs, lean shoulders on men, delicate jawlines",
  lettering_font: "CCWildWords",
};

/** models.CanvasSpec defaults. 1280 matches the generation width; 800 downsampled. */
const CANVAS = { width: 1280, gutter: 28, background: "#ffffff" };

/** ~/manhwa-studio/settings.json, verbatim. All three ControlNets are null here. */
const SETTINGS = {
  checkpoint: "animagine-xl-4.0.safetensors",
  background_checkpoint: "mam-max-manhwa-v1-sdxl.safetensors",
  control_size: 1024,
  depth_controlnet: null as string | null,
  lineart_controlnet: null as string | null,
  openpose_controlnet: null as string | null,
  openpose_strength: 0.6,
  openpose_end: 0.8,
};

/*
  The storyline is the one thing here I wrote: the projects on disk have empty
  `storyline` fields, so there was no authored sample to lift. It is input, not
  logic — edit it and every downstream number moves.
*/
const DEFAULT_STORYLINE = `Jin has not replied to a message in eleven days. Haeun finds him on the rooftop of the old studio building, sitting on the ledge with his back to the door. "You're early," Jin says, without turning round.

Haeun sits down beside Jin, close enough that their shoulders touch. Neither of them says anything until the dusk has gone violet over the river. "I kept the key," Haeun says. "I wasn't sure that was allowed."

Jin finally looks at him. "Eleven days," he says. "I counted." Haeun takes the cigarette out of Jin's hand and leans in until their foreheads touch.`;

// ==========================================================================
// models.py — the schemas. Coordinates on a panel are normalised 0..1 to the
// panel box, so a panel can be resized without breaking its lettering.
// ==========================================================================

type ShotType =
  | "establishing" | "wide" | "full" | "medium" | "medium_close" | "closeup"
  | "extreme_closeup" | "over_shoulder" | "pov" | "two_shot" | "insert" | "reaction";

type CameraAngle = "eye" | "low" | "high" | "birds_eye" | "worms_eye" | "dutch";

type BubbleKind =
  | "speech" | "thought" | "shout" | "whisper" | "narration"
  | "caption" | "offscreen" | "telepathy" | "aside" | "borderless";

type BubbleStyle = {
  fill: string;
  stroke: string;
  stroke_width: number;
  text_color: string;
  font: string;
  font_size: number;
  font_size_min: number;
  font_size_max: number;
  line_height: number;
  tracking: number;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
  align: "left" | "center" | "right";
  padding: number;
  opacity: number;
  dash: number[];
  halo: number;
};

const baseBubbleStyle = (): BubbleStyle => ({
  fill: "#ffffff",
  stroke: "#111111",
  stroke_width: 2.5,
  text_color: "#111111",
  font: "CCWildWords",
  font_size: 15.0,
  font_size_min: 9.0,
  font_size_max: 34.0,
  line_height: 1.24,
  tracking: 0.0,
  bold: false,
  italic: false,
  uppercase: true,
  align: "center",
  padding: 10.0,
  opacity: 1.0,
  dash: [],
  halo: 0.0,
});

/*
  Bubble.default_style_for_kind(). A balloon's colours, opacity, tracking and
  line height are the letterer's choices and survive a kind change; its
  outline, casing and type size are consequences of what kind of balloon it is.
  The kind-owned fields are reset to the class defaults first, so
  speech -> whisper -> speech lands back on a plain balloon instead of keeping
  the dashes.
*/
function defaultStyleForKind(kind: BubbleKind, prev: BubbleStyle): BubbleStyle {
  const base = baseBubbleStyle();
  const s: BubbleStyle = {
    ...prev,
    stroke_width: base.stroke_width,
    font_size: base.font_size,
    font_size_min: base.font_size_min,
    bold: base.bold,
    italic: base.italic,
    uppercase: base.uppercase,
    align: base.align,
    padding: base.padding,
    dash: base.dash,
    halo: base.halo,
  };
  if (kind === "thought") {
    s.stroke_width = 2.0;
    s.italic = true;
  } else if (kind === "shout") {
    s.bold = true;
    s.font_size = Math.max(s.font_size, 19.0);
    s.font_size_min = 12.0;
  } else if (kind === "whisper") {
    s.font_size = Math.min(s.font_size, 12.0);
    s.font_size_min = 8.0;
    s.italic = true;
    s.stroke_width = 1.2;
    s.dash = [7.0, 5.0];
  } else if (kind === "telepathy") {
    s.italic = true;
    s.stroke_width = 1.8;
    s.dash = [2.0, 6.0];
  } else if (kind === "aside") {
    s.font_size = Math.min(s.font_size, 11.0);
    s.font_size_min = 7.0;
    s.stroke_width = 1.4;
    s.padding = 7.0;
    s.uppercase = false;
    s.italic = true;
  } else if (kind === "borderless") {
    s.stroke_width = 0.0;
    s.uppercase = false;
    s.italic = true;
    s.halo = 3.0;
    s.padding = 2.0;
  } else if (kind === "offscreen") {
    s.stroke_width = 2.2;
  } else if (kind === "narration" || kind === "caption") {
    s.align = "left";
    s.uppercase = false;
  }
  return s;
}

type Bubble = {
  id: string;
  kind: BubbleKind;
  text: string;
  speaker_id: string | null;
  x: number; y: number; w: number; h: number;
  tail_x: number | null;
  tail_y: number | null;
  tail_width: number;
  tail_curve: number;
  link_to: string | null;
  order: number;
  style: BubbleStyle;
  locked: boolean;
};

type CharacterInPanel = {
  character_id: string;
  expression: string;
  pose: string;
  pose_preset: string;
  outfit_id: string | null;
  screen_x: number;
  screen_y: number;
  depth: "foreground" | "midground" | "background";
  facing: "left" | "right" | "toward" | "away" | "three_quarter";
  visible: boolean;
};

type PanelFX = {
  speed_lines: number;
  focus_lines: number;
  flash: number;
  blur_background: number;
};

type Panel = {
  id: string;
  index: number;
  beat: string;
  description: string;
  shot: {
    type: ShotType;
    angle: CameraAngle;
    focal_length: number;
    dutch_degrees: number;
    depth_of_field: number;
  };
  characters: CharacterInPanel[];
  setting_override: string;
  time_of_day: string;
  width: number;
  height: number;
  style_id: string | null;
  bubbles: Bubble[];
  fx: PanelFX;
  prompt: { override: string; negative_override: string; extra: string; negative_extra: string };
};

type Scene = {
  id: string;
  index: number;
  title: string;
  summary: string;
  setting: string;
  time_of_day: string;
  mood: string;
  character_ids: string[];
  beats: string[];
  panels: Panel[];
};

const characterById = (cid: string): Character | null =>
  CHARACTERS.find((c) => c.id === cid) ?? null;

// ==========================================================================
// director.py — storyline -> scenes -> panels (the offline breakdown)
// ==========================================================================

/*
  Cues the offline breakdown looks for. Crude next to a real director pass, but
  it beats leaving every scene's setting blank for you to fill in by hand.
  First match wins, so the table order is load-bearing.
*/
const SETTING_CUES: [string, string[]][] = [
  ["rooftop", ["roof", "rooftop"]],
  ["bedroom", ["bedroom", "his bed", "her bed", "under the covers"]],
  ["cafe", ["cafe", "café", "coffee shop", "diner", "restaurant", "bar counter"]],
  ["classroom", ["classroom", "lecture hall", "seminar", "campus", "university", "school"]],
  ["street at night", ["street", "alley", "sidewalk", "crosswalk", "intersection"]],
  ["apartment", ["apartment", "living room", "kitchen", "hallway", "doorway"]],
  ["office", ["office", "desk", "cubicle", "meeting room"]],
  ["hospital", ["hospital", "clinic", "ward", "waiting room"]],
  ["train", ["train", "subway", "platform", "station"]],
  ["park", ["park", "riverbank", "bench", "playground"]],
];

const TIME_CUES: [string, string[]][] = [
  ["night", ["night", "midnight", "dark out", "streetlight", "3am", "2am"]],
  ["dusk", ["dusk", "sunset", "evening", "golden", "sundown"]],
  ["dawn", ["dawn", "sunrise", "first light", "early morning"]],
  ["morning", ["morning", "breakfast"]],
  ["afternoon", ["afternoon", "lunch"]],
];

const MOOD_CUES: [string, string[]][] = [
  ["tense", ["silence", "doesn't answer", "does not answer", "avoiding", "flinch", "tight"]],
  ["tender", ["close", "closer", "shoulder", "quiet", "gentle", "soft", "waits"]],
  ["charged", ["stare", "breath", "almost", "leans", "inches", "touch"]],
  ["bittersweet", ["eleven days", "used to", "remember", "before", "again"]],
  ["comedic", ["groans", "yells", "trips", "snorts", "laughs"]],
];

function matchCue(text: string, cues: [string, string[]][]): string {
  const low = text.toLowerCase();
  for (const [label, keys] of cues) if (keys.some((k) => low.includes(k))) return label;
  return "";
}

/** Python's `re.split(r"(?<=[.!?])\s+", s)` without needing lookbehind. */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[.!?]\s+/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(text.slice(start, m.index + 1));
    start = m.index + m[0].length;
    re.lastIndex = start;
  }
  out.push(text.slice(start));
  return out;
}

/** _title_from: first meaningful clause, trimmed to a scene-card-sized label. */
function titleFrom(text: string): string {
  let first = splitSentences(text.trim())[0] ?? "";
  first = first.replace(/\s+/g, " ").replace(/^[\s.,]+|[\s.,]+$/g, "");
  if (first.length > 54) {
    const cut = first.slice(0, 51);
    const sp = cut.lastIndexOf(" ");
    first = (sp === -1 ? cut : cut.slice(0, sp)) + "…";
  }
  return first || "Untitled scene";
}

type RawScene = {
  title: string;
  summary: string;
  setting: string;
  time_of_day: string;
  mood: string;
  beats: string[];
};

/*
  _fallback_scenes. Paragraphs are distributed as evenly as possible across
  `target` scenes rather than chunked by floor division, which strands a tiny
  last group.
*/
function fallbackScenes(storyline: string, target: number): RawScene[] {
  const paras = storyline.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!paras.length) return [];
  const n = Math.max(1, Math.min(target, paras.length));
  const groups: string[][] = Array.from({ length: n }, () => []);
  paras.forEach((p, i) => groups[Math.floor((i * n) / paras.length)].push(p));

  return groups
    .filter((g) => g.length)
    .map((g) => {
      const body = g.join(" ");
      const beats = splitSentences(body)
        .map((s) => s.trim())
        .filter((s) => s.length > 3);
      return {
        title: titleFrom(body),
        summary: body.slice(0, 600),
        setting: matchCue(body, SETTING_CUES),
        time_of_day: matchCue(body, TIME_CUES) || "day",
        mood: matchCue(body, MOOD_CUES),
        beats: beats.slice(0, 10),
      };
    });
}

/*
  build_scenes. A continuous sequence usually stays in one place, so the last
  known setting and time carry forward rather than leaving downstream scenes
  location-less — which is why scene 2 and 3 below inherit the rooftop.
*/
function buildScenes(storyline: string, targetScenes: number): Scene[] {
  const raw = fallbackScenes(storyline, targetScenes);
  let lastSetting = "";
  let lastTime = "day";
  return raw.map((s, i) => {
    const setting = s.setting || lastSetting;
    const tod = s.time_of_day || lastTime;
    lastSetting = setting;
    lastTime = tod;
    return {
      id: `scn_${i}`,
      index: i,
      title: s.title || `Scene ${i + 1}`,
      summary: s.summary,
      setting,
      time_of_day: tod,
      mood: s.mood,
      character_ids: [],
      beats: s.beats,
      panels: [],
    };
  });
}

/*
  A repeating shot rhythm that reads well in vertical scroll: orient, play,
  land. The float is `height_ratio` — a webtoon panel's width is fixed by the
  canvas and only its height varies, so this is the panel's share of the scroll.
*/
const SHOT_RHYTHM: [ShotType, number][] = [
  ["establishing", 1.35],
  ["medium", 1.0],
  ["closeup", 0.75],
  ["two_shot", 1.0],
  ["reaction", 0.6],
  ["medium_close", 0.9],
  ["wide", 1.2],
  ["extreme_closeup", 0.55],
];

const DIALOGUE_RE = /[“"]([^”"]{2,200})[”"]/g;

function focalFor(shot: ShotType): number {
  const table: Record<string, number> = {
    establishing: 24, wide: 28, full: 35, two_shot: 40, medium: 50,
    medium_close: 65, over_shoulder: 65, pov: 35, reaction: 85, closeup: 85,
    insert: 100, extreme_closeup: 105,
  };
  return table[shot] ?? 50;
}

type RawPanel = {
  beat: string;
  description: string;
  shot_type: ShotType;
  height_ratio: number;
  characters: { name: string; screen_x: number; screen_y: number }[];
  bubbles: { kind: BubbleKind; speaker: string; text: string }[];
};

/*
  _fallback_panels — one panel per beat, on the standard shot rhythm. Quoted
  text becomes speech bubbles and is attributed to whichever character is named
  in the beat; everything else becomes the panel description.
*/
function fallbackPanels(scene: Scene, target: number): RawPanel[] {
  let beats = scene.beats.length
    ? scene.beats
    : splitSentences(scene.summary).filter((s) => s.trim());
  if (!beats.length) beats = [scene.summary || scene.title];

  if (beats.length > target) {
    const step = beats.length / target;
    beats = Array.from({ length: target }, (_, i) => beats[Math.floor(i * step)]);
  }

  const names = CHARACTERS.map((c) => c.name);
  return beats.map((beat, i) => {
    let [shot, ratio] = SHOT_RHYTHM[i % SHOT_RHYTHM.length];
    const quotes = [...beat.matchAll(DIALOGUE_RE)].map((m) => m[1]);
    const prose = beat.replace(DIALOGUE_RE, "").replace(/^[\s,.]+|[\s,.]+$/g, "");
    const mentioned = names.filter((n) => beat.toLowerCase().includes(n.toLowerCase()));

    // A line of dialogue implies a face; bias toward a closer shot.
    if (quotes.length && (shot === "establishing" || shot === "wide")) {
      shot = "medium";
      ratio = 1.0;
    }

    return {
      beat,
      description: prose || beat,
      shot_type: shot,
      height_ratio: ratio,
      characters: mentioned.slice(0, 3).map((n, j) => ({
        name: n,
        screen_x: mentioned.length === 1 ? 0.5 : 0.32 + j * 0.34,
        screen_y: 0.55,
      })),
      bubbles: quotes.map((q, k) => ({
        kind: "speech" as BubbleKind,
        speaker: mentioned.length ? mentioned[k % mentioned.length] : "",
        text: q,
      })),
    };
  });
}

/*
  _bubble_from. A rough auto-layout: stack bubbles down the upper-left of the
  panel, alternating sides so two speakers don't collide. lettering.auto_layout
  replaces these coordinates immediately — they are the seed, not the answer.
*/
function bubbleFrom(
  spec: { kind: BubbleKind; speaker: string; text: string },
  order: number,
  panelId: string,
): Bubble {
  const kind = spec.kind;
  const speaker = CHARACTERS.find(
    (c) => c.name.toLowerCase() === spec.speaker.trim().toLowerCase(),
  );
  const text = spec.text.trim();

  const left = order % 2 === 0;
  const w = text.length > 40 ? 0.4 : 0.3;
  const h = 0.09 + Math.min(0.16, text.length / 320);
  const x = left ? 0.06 : Math.max(0.06, 0.94 - w);
  let y = 0.05 + order * (h + 0.035);
  if (y + h > 0.95) y = 0.35 + (order % 3) * 0.14; // ran out of room

  const b: Bubble = {
    id: `bub_${panelId}_${order}`,
    kind,
    text,
    speaker_id: speaker ? speaker.id : null,
    x: round(x, 4),
    y: round(Math.min(y, 0.9), 4),
    w: round(w, 4),
    h: round(h, 4),
    tail_x: null,
    tail_y: null,
    tail_width: 0.06,
    tail_curve: 0.25,
    link_to: null,
    order,
    style: baseBubbleStyle(),
    locked: false,
  };
  if (kind !== "narration" && kind !== "caption") {
    b.tail_x = round(x + w / 2 + (left ? 0.12 : -0.12), 4);
    b.tail_y = round(Math.min(0.92, b.y + h + 0.16), 4);
  }
  b.style = defaultStyleForKind(kind, b.style);
  return b;
}

const round = (v: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/** build_panels — raw panel dicts into the real Panel schema. */
function buildPanels(scene: Scene, targetPanels: number): Panel[] {
  const raw = fallbackPanels(scene, targetPanels);
  const width = CANVAS.width;
  return raw.map((p, i) => {
    const ratio = Math.max(0.4, Math.min(2.2, p.height_ratio));
    const id = `${scene.id}_pnl_${i}`;
    const chars: CharacterInPanel[] = [];
    for (const cs of p.characters) {
      const c = CHARACTERS.find((x) => x.name.toLowerCase() === cs.name.toLowerCase());
      if (!c) continue;
      chars.push({
        character_id: c.id,
        expression: "neutral",
        pose: "",
        pose_preset: "auto",
        outfit_id: c.default_outfit_id,
        screen_x: cs.screen_x,
        screen_y: cs.screen_y,
        depth: "midground",
        facing: "three_quarter",
        visible: true,
      });
    }
    return {
      id,
      index: i,
      beat: p.beat,
      description: p.description,
      shot: {
        type: p.shot_type,
        angle: "eye",
        focal_length: focalFor(p.shot_type),
        dutch_degrees: 0,
        depth_of_field: 0,
      },
      characters: chars,
      setting_override: "",
      time_of_day: scene.time_of_day,
      width,
      height: Math.trunc(width * ratio),
      style_id: null,
      bubbles: p.bubbles.map((b, j) => bubbleFrom(b, j, id)),
      fx: { speed_lines: 0, focus_lines: 0, flash: 0, blur_background: 0 },
      prompt: { override: "", negative_override: "", extra: "", negative_extra: "" },
    };
  });
}

// ==========================================================================
// poses.py — pose vocabulary and the panel pose plan
//
// Left to itself a danbooru-captioned checkpoint draws the same three panels
// forever: a figure dead-centre, arms down or crossed, hands in pockets. That
// is the model routing around the two things it finds hardest — hands, and two
// bodies in the same space without merging. So poses are data here, not prose.
// ==========================================================================

/** Hands are the most reliable machine-made tell, so ask for them by weight. */
const HAND_POSITIVE = [
  "(hands visible in frame:1.25)",
  "(detailed hands:1.2)",
  "five fingers per hand, fingers clearly separated",
  "expressive hand gesture",
  "hands unobstructed, fully inside the frame",
];

/** The escape hatches the model reaches for, named so they can be closed. */
const HAND_HIDING_NEGATIVE = [
  "hands in pockets", "hands behind back", "arms behind back", "hands hidden",
  "hidden hands", "obscured hands", "cropped hands", "hands out of frame",
  "hands cut off at the wrist", "hands behind object", "mitten hands",
  "fused fingers", "blurred hands",
];

/** Contrapposto is the cheapest fix for the default mannequin stance. */
const NATURAL_POSITIVE = [
  "contrapposto",
  "weight shifted onto one leg",
  "asymmetric limbs, arms at different heights",
  "relaxed shoulders, loose posture",
  "natural body language, off-centre balance",
];

const STIFF_NEGATIVE = [
  "t-pose", "a-pose", "stiff pose", "rigid posture", "standing at attention",
  "symmetrical pose", "both arms straight down", "mannequin", "doll-like pose",
  "flat frontal stance",
];

const NON_MIRROR_POSITIVE = [
  "each figure posed differently",
  "asymmetric staging, contrasting silhouettes",
  "different head heights",
];

const NON_MIRROR_NEGATIVE = [
  "mirrored poses", "identical poses", "symmetrical composition", "clone",
  "same pose twice",
];

/** Cycled per figure so figure #0 and #1 are never handed the same instruction. */
const VARIATION_CYCLE: string[][] = [
  ["weight on the left leg", "right shoulder dropped", "head tilted slightly"],
  ["weight on the right leg", "torso turned three quarters", "chin lowered"],
  ["hip cocked, one knee soft", "one arm raised higher than the other", "head turned"],
  ["leaning off his centre of gravity", "shoulders squared away from camera", "chin raised"],
];

type Pose = {
  id: string;
  tags: string[];
  min: number;
  max: number;
  hands_visible: boolean;
  contact: boolean;
  roles: string[];
};

/*
  The inference-reachable slice of the pose library: every id _COMBOS and
  _INFERENCE can return, with the fields the planner reads. The full table in
  poses.py carries ~200 entries plus rig-pose and 3D-contact metadata, none of
  which the prompt path touches — `infer_preset` checks only `fits(count)`.
*/
const POSES: Record<string, Pose> = Object.fromEntries(
  (
    [
      ["forehead_kiss", ["2boys", "forehead kiss", "kissing his forehead", "eyes closed", "height difference", "hand cradling the back of his head"], 2, 2, true, true, ["head bowed, eyes closed, hands loose at his partner's waist", "taller, lips against his hairline, one hand cradling the back of his head"]],
      ["wall_pin", ["2boys", "against wall", "pinned to the wall", "arm braced on the wall", "kabedon", "eye contact"], 2, 2, true, true, ["back flat against the wall, shoulders raised, chin tilted up, hands at the wall", "leaning in, one palm braced on the wall above his head, other hand at his side"]],
      ["hand_on_cheek", ["2boys", "hand on another's face", "cupping his cheek", "thumb on his cheekbone", "eye contact", "fingers along the jaw"], 2, 2, true, true, ["face turned into the palm, eyes lowered", "one hand cupping his partner's cheek, thumb extended, other arm relaxed"]],
      ["hands_on_his_face", ["hands on another's face", "cupping his face with both hands", "thumbs on his cheekbones", "fingers along his jaw"], 2, 2, true, true, []],
      ["lap_sit", ["2boys", "sitting on another's lap", "straddling his lap", "face to face", "hands on his shoulders", "hands on his waist"], 2, 2, true, true, ["seated underneath, hands on his partner's waist, looking up", "sitting on his lap, knees either side, hands on his shoulders, leaning down"]],
      ["shoulder_lean", ["2boys", "head on another's shoulder", "leaning on him", "eyes closed", "sitting side by side", "hands in his lap"], 2, 2, true, true, ["head resting on his partner's shoulder, eyes closed, hands folded in his lap", "sitting upright, head tilted toward him, one hand on his own knee"]],
      ["hand_on_door_frame", ["hand on a door frame", "gripping the door frame", "arm raised overhead", "fingers curled around the edge", "framed in the doorway"], 1, 6, true, false, []],
      ["forehead_touch", ["2boys", "forehead to forehead", "eyes closed", "noses almost touching", "hands on each other's shoulders"], 2, 2, true, true, ["eyes closed, hand curled at his partner's collar", "eyes half open, hand at the back of his partner's neck"]],
      ["piggyback", ["2boys", "piggyback", "on his back", "arms around his shoulders", "hands under his thighs", "walking"], 2, 2, true, true, ["carried on his partner's back, arms around his shoulders, chin near his ear", "carrying him, leaning forward, hands hooked under his thighs, walking"]],
      ["carrying_bridal", ["2boys", "carrying", "princess carry", "arms under his knees", "arm around his neck", "looking up at him"], 2, 2, true, true, ["being carried, one arm hooked around his partner's neck, knees bent", "carrying him, one arm under his knees, one across his back, braced stance"]],
      ["sleeping_together", ["2boys", "sleeping", "lying on bed", "under the covers", "arm over his chest", "tangled legs", "eyes closed"], 2, 2, true, true, ["on his back, one hand resting on the arm across his chest, head turned", "on his side, arm draped over his partner's chest, face against his shoulder"]],
      ["back_to_back", ["2boys", "back to back", "shoulders touching", "arms crossed", "looking in opposite directions"], 2, 2, true, true, ["arms crossed, chin down, weight on the back foot", "hands loose, head turned to look over his shoulder, weight forward"]],
      ["back_to_chest", ["2boys", "hug from behind", "back to chest", "arms around his waist", "chin on his shoulder", "eyes closed"], 2, 2, true, true, ["standing in front, hands resting over the arms around him, head tipped back", "standing behind, arms crossed over his partner's waist, face against his neck"]],
      ["wrist_grab", ["2boys", "wrist grab", "grabbing another's wrist", "pulling him back", "tense fingers", "arm extended", "looking back"], 2, 2, true, true, ["arm caught and extended behind him, half turned back, off balance", "gripping his partner's wrist, arm straight, leaning after him"]],
      ["lapel_grab", ["2boys", "grabbing another's collar", "fist in his shirt", "pulling him close", "clenched fingers", "eye contact", "angry"], 2, 2, true, true, ["hauled forward off balance, hands coming up to his partner's forearm", "fist knotted in his partner's lapel, arm bent, leaning in"]],
      ["chin_lift", ["2boys", "chin grab", "lifting another's chin", "two fingers under his jaw", "looking down at him"], 2, 2, true, true, ["chin tipped up by the hand, eyes narrowed, jaw tight", "two fingers under his partner's chin, other hand in his pocket, looking down"]],
      ["hair_touch", ["2boys", "hand in another's hair", "brushing his hair aside", "fingers combing through his hair", "eyes lowered"], 2, 2, true, true, ["head tipped toward the hand, eyes half closed", "fingers threaded into his partner's hair, other hand at his own side"]],
      ["hand_on_chest", ["2boys", "hand on another's chest", "palm flat on his sternum", "pushing him back", "eye contact", "fingers splayed"], 2, 2, true, true, ["chest forward, hands at his sides, looking down at the hand", "one palm flat on his partner's chest, fingers splayed, arm straight"]],
      ["whisper", ["2boys", "whispering in his ear", "hand cupped beside his mouth", "leaning close from behind", "eyes flicking sideways"], 2, 2, true, true, ["eyes cut sideways, mouth shut, shoulders stiff", "leaning to his ear, one hand cupped beside his mouth, other on his shoulder"]],
      ["kiss", ["2boys", "yaoi", "kiss", "french kiss", "eyes closed", "hand on another's face", "tilted heads"], 2, 2, true, true, ["head tilted left, eyes closed, fingers curled in his partner's shirt", "head tilted right, one hand along his partner's jaw"]],
      ["hugging", ["2boys", "hug", "embrace", "arms around him", "face against his shoulder", "hands splayed on his back", "eyes closed"], 2, 2, true, true, ["arms around his partner's waist, face turned into his shoulder", "arms over his partner's shoulders, one hand at his nape, chin above his head"]],
      ["hands_interlaced", ["2boys", "holding hands", "interlocked fingers", "fingers laced together", "hands in the foreground", "wrist against wrist"], 2, 2, true, true, ["arm extended, fingers laced with his partner's, looking away", "hand turned palm to palm, thumb over his partner's knuckles, looking at him"]],
      ["couch_side_by_side", ["2boys", "sitting on a couch", "side by side", "shoulders touching", "one arm along the back of the couch", "legs crossed"], 2, 2, true, true, ["slouched low, knees wide, one hand on his own thigh", "sitting upright, legs crossed, arm draped along the couch back"]],
      ["over_shoulder_confrontation", ["2boys", "over the shoulder", "confrontation", "one back to the viewer", "eye contact", "blurred foreground shoulder"], 2, 2, true, false, ["back to the viewer, out of focus, shoulder filling the frame edge", "facing the camera past his shoulder, sharp focus, jaw set"]],
      ["leaning_over", ["2boys", "leaning over another", "hovering above him", "hand beside his head", "lying on his back"], 2, 2, true, true, ["lying back, one arm above his head, looking up, throat exposed", "braced over him on both forearms, hair falling forward, looking down"]],
      ["around_table", ["multiple boys", "sitting around a table", "3boys", "different postures", "elbows on the table", "food on the table", "hands visible on the table"], 3, 6, true, false, ["slouched back in his chair, one arm hooked over the backrest", "leaning in over the table, both forearms flat, holding a glass", "turned side-on, legs crossed, chin propped on his hand"]],
      ["lighting_cigarette", ["smoking", "cigarette", "holding a lighter", "cupped hand shielding the flame", "cigarette between his fingers", "smoke"], 1, 6, true, false, []],
      ["holding_cup", ["holding a cup", "cup", "both hands wrapped around the mug", "steam", "fingers curled around the ceramic"], 1, 6, true, false, []],
      ["checking_phone", ["holding a phone", "looking at his phone", "thumb on the screen", "screen glow on his face", "one hand cradling the phone"], 1, 6, true, false, []],
      ["adjusting_glasses", ["adjusting his glasses", "pushing up his glasses", "two fingers on the bridge", "glasses", "hand near his face"], 1, 6, true, false, []],
      ["holding_chopsticks", ["holding chopsticks", "chopsticks", "food", "bowl in his other hand", "fingers positioned on the chopsticks"], 1, 6, true, false, []],
      ["leaning_doorway", ["leaning on a door frame", "one hand gripping the door frame overhead", "ankles crossed", "framed by the doorway"], 1, 1, true, false, []],
      ["hands_pockets", ["hands in pockets", "standing", "slouched shoulders", "weight on one leg"], 1, 1, false, false, []],
      ["arms_crossed", ["crossed arms", "standing", "weight on one leg", "fingers visible over sleeve"], 1, 1, true, false, []],
      ["stretching", ["stretching", "arms raised overhead", "arched back", "fingers laced above his head", "midriff showing"], 1, 1, true, false, []],
      ["turning_to_look", ["looking back", "turning around", "torso twisted", "over the shoulder glance", "hair in motion"], 1, 1, true, false, []],
      ["running", ["running", "arms pumping", "leaning forward", "motion blur on the trailing leg"], 1, 1, true, false, []],
      ["walking_away", ["walking away from the viewer", "from behind", "mid-stride", "one hand loose at his side", "looking back over his shoulder"], 1, 1, true, false, []],
      ["walking", ["walking", "mid-stride", "one arm swinging forward", "coat in motion", "opposite arm and leg forward"], 1, 1, true, false, []],
      ["lying_bed", ["lying on bed", "on his back", "one arm above his head", "one knee bent"], 1, 1, true, false, []],
      ["sitting_desk", ["sitting at a desk", "one arm on the desk", "pen in hand", "leaning on his elbow"], 1, 1, true, false, []],
      ["sitting_chair", ["sitting", "on a chair", "legs crossed", "elbow on the armrest", "hand resting on his knee"], 1, 1, true, false, []],
      ["leaning_railing", ["leaning forward on a railing", "forearms resting on the rail", "hands clasped over the edge", "looking out"], 1, 1, true, false, []],
      ["leaning_wall", ["leaning against wall", "one leg bent, foot flat on the wall", "arms loose", "shoulder against the wall"], 1, 1, true, false, []],
      ["kneeling", ["kneeling", "one knee up", "hand flat on the floor", "looking up"], 1, 1, true, false, []],
      ["pointing", ["pointing", "index finger extended", "arm across his body", "sharp gesture"], 1, 1, true, false, []],
      ["reaching", ["reaching out", "outstretched arm", "open palm toward the viewer", "fingers spread", "foreshortening"], 1, 1, true, false, []],
      ["slouching", ["slouching", "hunched shoulders", "head down", "hands loose at his sides", "curved spine"], 1, 1, true, false, []],
      ["head_in_hands", ["head in hands", "covering his face with both hands", "elbows on the table", "fingers pressed into his hair"], 1, 1, true, false, []],
    ] as [string, string[], number, number, boolean, boolean, string[]][]
  ).map(([id, tags, min, max, hands, contact, roles]) => [
    id,
    { id, tags, min, max, hands_visible: hands, contact, roles },
  ]),
);

/*
  Checked first, and every term must be present. Single keywords cannot
  separate "a kiss to his forehead" from "foreheads pressed together" — both
  contain "forehead", and whichever is listed higher wins, which is how a
  forehead kiss quietly became a forehead touch.
*/
const POSE_COMBOS: [string[], string][] = [
  [["forehead", "kiss"], "forehead_kiss"],
  [["wall", "kiss"], "wall_pin"],
  [["hand", "cheek"], "hand_on_cheek"],
  [["both hands", "face"], "hands_on_his_face"],
  [["sit", "lap"], "lap_sit"],
  [["head", "shoulder"], "shoulder_lean"],
  [["hand", "door"], "hand_on_door_frame"],
];

const POSE_INFERENCE: [string[], string][] = [
  [["forehead kiss", "kisses his forehead"], "forehead_kiss"],
  [["forehead", "foreheads touch"], "forehead_touch"],
  [["wall", "pinned", "pins him", "kabedon"], "wall_pin"],
  [["lap", "straddl"], "lap_sit"],
  [["piggyback"], "piggyback"],
  [["carries", "carrying", "picks him up", "lifts him"], "carrying_bridal"],
  [["asleep", "sleeping", "sleep together"], "sleeping_together"],
  [["back to back"], "back_to_back"],
  [["from behind", "back to chest", "hugs him from behind"], "back_to_chest"],
  [["wrist"], "wrist_grab"],
  [["collar", "lapel", "grabs his shirt"], "lapel_grab"],
  [["chin"], "chin_lift"],
  [["hair"], "hair_touch"],
  [["cheek", "cups his face", "hand on his face"], "hand_on_cheek"],
  [["chest"], "hand_on_chest"],
  [["whisper"], "whisper"],
  [["kiss", "kissing"], "kiss"],
  [["hug", "embrace", "arms around"], "hugging"],
  [["holding hands", "fingers laced", "interlaced"], "hands_interlaced"],
  [["head on his shoulder", "leans on his shoulder"], "shoulder_lean"],
  [["couch", "sofa"], "couch_side_by_side"],
  [["over the shoulder"], "over_shoulder_confrontation"],
  [["leaning over", "looms over", "above him"], "leaning_over"],
  [["table", "dinner", "eating together"], "around_table"],
  [["cigarette", "smoking", "lights a"], "lighting_cigarette"],
  [["mug", "coffee", "cup", "tea"], "holding_cup"],
  [["phone"], "checking_phone"],
  [["glasses"], "adjusting_glasses"],
  [["chopsticks"], "holding_chopsticks"],
  [["doorway", "door frame", "door"], "leaning_doorway"],
  [["pocket"], "hands_pockets"],
  [["crossed arms", "arms crossed", "folded arms"], "arms_crossed"],
  [["stretch", "yawn"], "stretching"],
  [["looks back", "turns around", "over his shoulder"], "turning_to_look"],
  [["running", "runs", "sprint"], "running"],
  [["walking away"], "walking_away"],
  [["walk", "walking", "steps"], "walking"],
  [["lying", "lies down", "on the bed", "in bed"], "lying_bed"],
  [["desk"], "sitting_desk"],
  [["sits", "sitting", "seated", "chair"], "sitting_chair"],
  [["railing", "balcony", "rooftop edge"], "leaning_railing"],
  [["lean", "leaning", "leans"], "leaning_wall"],
  [["kneel", "crouch"], "kneeling"],
  [["point"], "pointing"],
  [["reach", "reaches out"], "reaching"],
  [["slouch", "slump", "hunch"], "slouching"],
  [["head in his hands", "buries his face"], "head_in_hands"],
];

/*
  infer_preset. A duo pose is only returned when there are actually two bodies
  to stage it with, otherwise the panel asks for a hug with nobody to hug.
*/
function inferPreset(text: string, count: number): Pose | null {
  const low = (text || "").toLowerCase();
  if (!low.trim()) return null;
  for (const [keys, pid] of POSE_COMBOS) {
    if (keys.every((k) => low.includes(k))) {
      const p = POSES[pid];
      if (p && p.min <= count && count <= p.max) return p;
    }
  }
  for (const [keys, pid] of POSE_INFERENCE) {
    if (keys.some((k) => low.includes(k))) {
      const p = POSES[pid];
      if (p && p.min <= count && count <= p.max) return p;
    }
  }
  return null;
}

type PosePlan = {
  per_character: string[][];
  shared: string[];
  negative: string[];
  hands_visible: boolean;
  used: string[];
};

const dedupe = (items: string[]): string[] => [
  ...new Set(items.filter((i) => i && i.trim())),
];

/*
  plan_panel. Multi-character poses are emitted ONCE, at panel level, with
  their per-figure `roles` handed out to the individual bodies. Repeating
  "back to chest" on both characters is how you get four arms.
*/
function planPanel(presets: string[], poseTexts: string[], count: number): PosePlan {
  const plan: PosePlan = {
    per_character: Array.from({ length: count }, () => [] as string[]),
    shared: [],
    negative: [],
    hands_visible: false,
    used: [],
  };
  const shared: string[] = [];
  const multiApplied: Pose[] = [];
  let anyVisibleHandPose = false;
  let anyHiddenHandPose = false;

  for (let idx = 0; idx < count; idx++) {
    const preset = presets[idx] ?? "";
    const text = poseTexts[idx] ?? "";
    let resolved: Pose[] = [];
    if (preset && preset.trim().toLowerCase() !== "auto") {
      for (const chunk of preset.split("+")) {
        const p = POSES[chunk];
        if (p && !resolved.includes(p)) resolved.push(p);
      }
    }
    if (!resolved.length) {
      const inferred = inferPreset(text, count);
      if (inferred) resolved = [inferred];
    }

    for (const pose of resolved) {
      plan.used.push(pose.id);
      if (pose.hands_visible) anyVisibleHandPose = true;
      else anyHiddenHandPose = true;

      if (pose.min > 1) {
        if (!multiApplied.includes(pose)) {
          multiApplied.push(pose);
          shared.push(...pose.tags);
          if (pose.contact) shared.push("bodies in contact, clear separation of limbs");
          for (let i = 0; i < count; i++) {
            if (i < pose.roles.length) plan.per_character[i].push(pose.roles[i]);
          }
        }
      } else {
        plan.per_character[idx].push(...pose.tags);
      }
    }
  }

  // Nothing resolved at all: still refuse the default mannequin stance.
  if (!plan.used.length) shared.push(...NATURAL_POSITIVE.slice(0, 3));

  for (let idx = 0; idx < count; idx++) {
    plan.per_character[idx].push(...VARIATION_CYCLE[idx % VARIATION_CYCLE.length]);
  }

  if (count >= 2) {
    shared.push(...NON_MIRROR_POSITIVE);
    plan.negative.push(...NON_MIRROR_NEGATIVE);
  }

  shared.push("contrapposto", "relaxed shoulders", "natural body language");
  plan.negative.push(...STIFF_NEGATIVE);

  // A pose that hides hands on purpose (pockets) gets neither the weighted
  // push nor the closed escape hatches — negating "hands in pockets" would
  // fight the pose that was asked for.
  if (anyVisibleHandPose || (plan.used.length && !anyHiddenHandPose)) {
    plan.hands_visible = true;
    shared.push(...HAND_POSITIVE);
    plan.negative.push(...HAND_HIDING_NEGATIVE);
  } else if (anyHiddenHandPose) {
    shared.push("well-drawn hands where visible");
  }

  plan.shared = dedupe(shared);
  plan.negative = dedupe(plan.negative);
  for (let idx = 0; idx < count; idx++) {
    plan.per_character[idx] = dedupe(plan.per_character[idx]);
  }
  return plan;
}

// ==========================================================================
// prompt_builder.py — panel + cast + style -> (positive, negative)
//
// Deterministic and inspectable: every panel stores the exact prompt it was
// rendered with, so you can tweak one word and re-roll without guessing what
// the engine did.
// ==========================================================================

const SHOT_PHRASES: Record<ShotType, string> = {
  establishing: "wide establishing shot, full environment visible, small figures",
  wide: "wide shot, full body, environment context",
  full: "full body shot, head to toe in frame",
  medium: "medium shot, waist up",
  medium_close: "medium close-up, chest up",
  closeup: "close-up portrait, head and shoulders",
  extreme_closeup: "extreme close-up, eyes and expression fill the frame",
  over_shoulder: "over-the-shoulder shot, foreground shoulder framing the subject",
  pov: "first person point of view shot",
  two_shot: "two shot, two characters framed together",
  insert: "extreme close-up detail insert of an object, shallow focus",
  reaction: "reaction close-up, expressive face",
};

const ANGLE_PHRASES: Record<CameraAngle, string> = {
  eye: "eye level",
  low: "low angle looking up, subject towers",
  high: "high angle looking down",
  birds_eye: "bird's eye view directly overhead",
  worms_eye: "worm's eye view from ground level",
  dutch: "dutch tilted angle, canted horizon",
};

const TIME_PHRASES: Record<string, string> = {
  dawn: "dawn light, cool blue with a warm horizon",
  morning: "clear morning light",
  day: "daylight",
  noon: "harsh overhead noon light",
  afternoon: "warm low afternoon light, long shadows",
  "golden hour": "golden hour backlight, warm rim on the subject",
  dusk: "dusk, violet and amber sky",
  evening: "evening, warm interior light against a dark window",
  night: "night scene, cool ambient with warm practical lights",
  rain: "rain, wet reflective surfaces",
};

/*
  Time phrases carry colour-temperature language ("violet and amber sky"). On a
  monochrome pack that is a colour leak landing ahead of the style block, so
  achromatic styles get the same phrase with the hue words removed: the light
  behaviour survives, the colour does not.
*/
const ACHROMATIC_TIME: Record<string, string> = {
  dawn: "dawn light, low raking light with a bright horizon",
  "golden hour": "low backlight, bright rim on the subject",
  dusk: "dusk, dim falling light",
  evening: "evening, lit interior against a dark window",
  night: "night scene, dark ambient with bright practical lights",
  rain: "rain, wet reflective surfaces",
};

const ACHROMATIC_MODES = new Set([
  "monochrome", "greyscale", "grayscale", "duotone", "grayscale_screentone", "screentone",
]);

function timePhrase(tod: string, style: StyleProfile): string {
  if (ACHROMATIC_MODES.has(style.color_mode))
    return ACHROMATIC_TIME[tod] ?? TIME_PHRASES[tod] ?? tod;
  return TIME_PHRASES[tod] ?? tod;
}

/*
  The specific ways diffusion output announces itself. Two rules govern what is
  allowed in here, both learned the hard way:

    1. Negatives suppress QUALITIES reliably and OBJECTS unreliably — a render
       came back with MORE floating hands after "disembodied hands" was added.
       So everything here is an adjective, a finish or a medium name.
    2. Nothing here may be a word the style pack asks for in the positive. A
       token on both sides of the sampler is conditioning spent cancelling
       itself.
*/
const MACHINE_TELLS = [
  "airbrushed look", "plastic skin", "waxy skin", "over-rendered",
  "uniform detail everywhere", "glossy 3d render", "cgi", "stock illustration",
  "generic digital art",
];

/** Things that ruin a comic panel specifically, on top of the style's negatives. */
const PANEL_NEGATIVE = [
  "speech bubble", "text", "letters", "words", "caption box", "watermark",
  "logo", "panel border", "gutter", "comic page layout", "multiple panels",
  "frame within frame", "split screen",
];

const ANATOMY_POSITIVE = [
  "correct anatomy",
  "well-drawn hands, five fingers",
  "natural body proportions",
];

const MULTI_FIGURE_POSITIVE = ["clear separation between figures"];

/*
  A panel is one drawn moment, not a page of studies. Asked for "full body,
  head to toe", an SDXL anime checkpoint reaches for the most common thing in
  its training data with that framing: a character reference sheet. Two real
  renders came back as 3x3 grids of the same figure.
*/
const SHEET_NEGATIVE = [
  "character sheet", "reference sheet", "model sheet", "turnaround",
  "multiple views", "multiple views of the same character", "concept art sheet",
  "sketch page", "study sheet", "collage", "grid of figures", "contact sheet",
  "duplicate character", "clone",
];

const ANATOMY_NEGATIVE = [
  "extra arms", "extra hands", "third arm", "fused bodies", "merged limbs",
  "conjoined", "malformed hands", "too many fingers", "missing arm",
  "twisted torso", "broken anatomy", "floating limb", "detached hand",
  "long neck", "boneless", "melted faces",
];

/*
  SDXL's text encoder works in 75-token chunks. A negative that spills past one
  chunk does not suppress more — it dilutes what is already there. The negative
  reached 107 comma-separated entries once every source was concatenated, and
  renders collapsed: a two-character kiss came back as five pictograms. Order
  matters more than count, so defects that ruin a panel outright are kept first.
*/
const NEGATIVE_BUDGET = 64;

/** Flatten prioritised (tokens, per-group cap) pairs, dedupe, cap at budget. */
function trimNegatives(groups: [string[], number][], budget = NEGATIVE_BUDGET): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [group, cap] of groups) {
    let taken = 0;
    for (const tok of group) {
      if (taken >= cap || out.length >= budget) break;
      const key = tok.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(tok.trim());
      taken += 1;
    }
  }
  return out;
}

/*
  Anime checkpoints inherit danbooru's counting tags, where 1boy and 1girl are
  strong and mutually exclusive. A prose hedge like "1girl or 1boy" is worse
  than nothing: the tokenizer sees both and 1girl wins.
*/
const PRESENTATION_TAGS: Record<string, [string, string, string]> = {
  male: ["1boy", "2boys", "multiple boys"],
  female: ["1girl", "2girls", "multiple girls"],
  androgynous: ["1other", "2others", "multiple others"],
};

const BIAS_BANDS: [number, string[]][] = [
  [-0.66, ["soft rounded features", "delicate jaw", "large expressive eyes",
           "slender neck", "narrow shoulders", "long lashes"]],
  [-0.33, ["softer features", "gentle jawline", "slightly larger eyes", "slim build"]],
  [0.33, []], // neutral: say nothing, let the count tag decide
  // The masculine end is BL-coded, not seinen-coded: taller, leaner, flatter,
  // straighter. Nothing here adds mass — the previous bands ("heavy brow",
  // "thick neck") landed ahead of the style pack's own face tokens and dragged
  // every portrait into another genre.
  [0.66, ["taller with a longer neck", "flat chest", "squarer shoulder line",
          "straighter brows"]],
  [1.01, ["tall and lean", "broad flat shoulders", "flat chest",
          "straight low brows", "narrower eyes with a level lash line",
          "defined but soft jaw"]],
];

/** Above this the slider is a strong enough statement to choose the count tag. */
const BIAS_DECIDES_TAG = 0.66;

function biasTags(bias: number): string[] {
  for (const [upper, tags] of BIAS_BANDS) if (bias < upper) return tags;
  return BIAS_BANDS[BIAS_BANDS.length - 1][1];
}

/** An explicit male/female always wins — a slider must not override a switch. */
function presentationFor(presentation: string, bias: number): string {
  if (presentation === "male" || presentation === "female") return presentation;
  if (bias >= BIAS_DECIDES_TAG) return "male";
  if (bias <= -BIAS_DECIDES_TAG) return "female";
  return presentation;
}

function resolvedPresentation(ch: Character): string {
  if (ch.presentation !== "auto") return ch.presentation;
  const p = ch.pronouns.toLowerCase();
  if (p.startsWith("he")) return "male";
  if (p.startsWith("she")) return "female";
  return "androgynous";
}

/*
  Danbooru-style colour tags the checkpoints actually know. Free text like
  "ash-blond" tokenizes into nothing useful; "blonde hair" is a real tag with
  real weight, so emit that AND keep the author's wording.
*/
const HAIR_TAGS: Record<string, string> = {
  blond: "blonde hair", blonde: "blonde hair", ash: "blonde hair",
  platinum: "white hair", silver: "silver hair", white: "white hair",
  black: "black hair", raven: "black hair", dark: "black hair",
  brown: "brown hair", brunette: "brown hair", chestnut: "brown hair",
  auburn: "red hair", ginger: "red hair", red: "red hair",
  pink: "pink hair", blue: "blue hair", green: "green hair",
  purple: "purple hair", lavender: "purple hair", grey: "grey hair",
  gray: "grey hair",
};

const EYE_TAGS: Record<string, string> = {
  grey: "grey eyes", gray: "grey eyes", blue: "blue eyes", green: "green eyes",
  brown: "brown eyes", amber: "yellow eyes", gold: "yellow eyes",
  hazel: "brown eyes", red: "red eyes", violet: "purple eyes",
  purple: "purple eyes", black: "black eyes",
};

/*
  Longest matching key wins. This used to return on the FIRST key found in dict
  order, so "dark brown" hit the modifier "dark" (which maps to black hair)
  before it reached "brown" — two leads described as "black" and "dark brown"
  both came out `black hair`, losing the one cue that told them apart.
*/
function tagFor(text: string, table: Record<string, string>): string | null {
  const low = (text || "").toLowerCase();
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of keys) if (low.includes(key)) return table[key];
  return null;
}

/** Appearance.tokens() */
function appearanceTokens(a: Appearance): string[] {
  const out: string[] = [];
  if (a.hair_color || a.hair) {
    const tag = tagFor(a.hair_color, HAIR_TAGS);
    if (tag) out.push(tag);
    const descriptive = `${a.hair_color} ${a.hair}`.trim();
    if (descriptive) out.push(`${descriptive} hair`);
  }
  if (a.eye_color || a.eyes) {
    const tag = tagFor(a.eye_color, EYE_TAGS);
    if (tag) out.push(tag);
    else out.push(`${a.eye_color} ${a.eyes} eyes`.trim());
  }
  for (const f of [a.face, a.build, a.skin]) if (f) out.push(f);
  if (a.height_cm) out.push(`${a.height_cm}cm tall`);
  out.push(...a.distinguishing);
  return out.filter((t) => t.trim());
}

/** Character.prompt_fragment() */
function characterFragment(ch: Character, outfitId: string | null): string {
  const base: string[] = [];
  if (ch.age_look) base.push(ch.age_look);
  base.push(...appearanceTokens(ch.appearance));
  base.push(...biasTags(ch.presentation_bias));
  base.push(...ch.extra_tokens);
  const target = outfitId ?? ch.default_outfit_id;
  const fit = ch.outfits.find((o) => o.id === target) ?? ch.outfits[0] ?? null;
  if (fit) {
    base.push(fit.description || fit.name);
    base.push(...fit.tokens);
  }
  return dedupe(base).join(", ");
}

/** StyleProfile.prompt_fragment() */
function styleFragment(style: StyleProfile): string {
  const bits = [...style.positive_tokens];
  if (style.color_mode === "monochrome") bits.push("monochrome, black and white manhwa art");
  else if (style.color_mode === "duotone") bits.push("duotone limited palette");
  else if (style.color_mode === "grayscale_screentone")
    bits.push("grayscale with screentone dots");
  if (style.tone.screentone) bits.push("screentone shading");
  return dedupe(bits).join(", ");
}

const FIGURE_WORDS = [
  "1boy", "2boys", "3boys", "1girl", "2girls", "1other", "boy", "boys", "girl",
  "girls", "man", "men", "woman", "women", "male", "female", "person", "people",
  "couple", "yaoi", "someone", "solo", "portrait", "he", "his", "him", "she",
  "her", "they", "figure", "figures",
];

/*
  Matched on word boundaries, not substrings. The naive version matched "he"
  inside "the", so an explicitly empty city skyline read as populated.
*/
const FIGURE_RE = new RegExp(`\\b(?:${FIGURE_WORDS.join("|")})\\b`, "i");
const wantsFigures = (text: string): boolean => FIGURE_RE.test(text || "");

/** _crowd_control — danbooru count tags matching who is actually in frame. */
function crowdControl(chars: CharacterInPanel[], allowEmpty: boolean): string {
  if (!chars.length) {
    // An empty cast is ambiguous. Asserting `no humans` on a panel whose author
    // typed their own `(1boy:1.35)` is actively destructive — a real render came
    // back as a 3x3 sheet of black blobs from exactly this contradiction.
    return allowEmpty ? "no humans, empty scene" : "";
  }

  const buckets: Record<string, number> = {};
  for (const cip of chars) {
    const ch = characterById(cip.character_id);
    let pres = ch ? resolvedPresentation(ch) : "androgynous";
    if (ch) pres = presentationFor(pres, ch.presentation_bias);
    buckets[pres] = (buckets[pres] ?? 0) + 1;
  }

  const parts: string[] = [];
  for (const [pres, count] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
    const [one, two, many] = PRESENTATION_TAGS[pres] ?? PRESENTATION_TAGS.androgynous;
    const tag = count === 1 ? one : count === 2 ? two : many;
    // These checkpoints carry a heavy `1girl` prior — an unweighted `1boy`
    // loses to it even in first position. CLIPTextEncode understands A1111
    // emphasis syntax, so weight the subject tag rather than trusting position.
    parts.push(`(${tag}:1.35)`);
    if (pres === "androgynous") parts.push("androgynous, ambiguous gender");
  }

  if (chars.length === 1) parts.push("solo");
  else parts.push(`${chars.length} people, clear separation between figures`);
  return parts.join(", ");
}

/** Push away the presentation the cast isn't — only when the cast is unanimous. */
function genderNegatives(chars: CharacterInPanel[]): string[] {
  if (!chars.length) return [];
  const present = new Set(
    chars.map((c) => {
      const ch = characterById(c.character_id);
      return ch ? resolvedPresentation(ch) : "androgynous";
    }),
  );
  if (present.size !== 1) return [];
  const only = [...present][0];
  if (only === "male") return ["1girl", "woman", "breasts", "feminine face", "lipstick"];
  if (only === "female") return ["1boy", "man", "masculine face", "beard", "flat chest"];
  return [];
}

/*
  Two figures touching is where anatomy fails hardest: arms merge, a third hand
  appears, torsos fuse. The fix is not a longer negative — it is telling the
  model this is a KNOWN composition it has seen tagged thousands of times.
  Danbooru interaction tags do that; prose like "they hug" does not.
*/
const INTERACTION_CUES: [string[], string][] = [
  [["kiss", "kissing", "lips meet"], "kiss, eye contact, face to face"],
  [["hug", "embrace", "holds him", "arms around"], "hug, embrace, arms around"],
  [["hand on", "cups his", "touches his face", "chin"], "hand on another's face"],
  [["pins", "pinned", "against the wall", "wall slam"], "against wall, dominant pose"],
  [["leans in", "close", "almost", "inches"], "close-up, face to face, eye contact"],
  [["holds hands", "fingers laced", "hand in hand"], "holding hands, interlocked fingers"],
  [["carries", "piggyback", "lifts"], "carrying, lifting"],
  [["head on", "shoulder", "lap"], "head on another's shoulder"],
  [["back to back"], "back to back"],
  [["grabs", "pulls", "collar", "wrist"], "grabbing, pulling"],
];

function interactionTags(panel: Panel): string[] {
  const text = [panel.description, panel.beat]
    .concat(panel.characters.filter((c) => c.visible).map((c) => c.pose))
    .join(" ")
    .toLowerCase();
  const tags: string[] = [];
  for (const [keys, tag] of INTERACTION_CUES) {
    if (keys.some((k) => text.includes(k))) tags.push(tag);
  }
  return dedupe(tags);
}

/*
  Genre framing for a two-hander. Height and build contrast between the leads
  is load-bearing visual language in this genre, so it is stated explicitly
  rather than left for the model to invent.
*/
function relationshipTags(chars: CharacterInPanel[]): string[] {
  const people = chars
    .map((c) => characterById(c.character_id))
    .filter((c): c is Character => c !== null);
  if (people.length !== 2) return [];
  const tags = ["couple"];
  if (people.every((p) => resolvedPresentation(p) === "male")) tags.push("yaoi", "male focus");
  const heights = people
    .map((p) => p.appearance.height_cm)
    .filter((h): h is number => h !== null);
  if (heights.length === 2 && Math.abs(heights[0] - heights[1]) >= 6)
    tags.push("height difference");
  return tags;
}

/** pose_plan — a two-character pose is one composition, not two poses. */
function posePlanFor(panel: Panel): PosePlan {
  const visible = panel.characters.filter((c) => c.visible);
  if (!visible.length) return planPanel([], [], 0);
  // A description like "he pins him against the wall" carries the staging even
  // when nobody filled in a per-character pose field.
  const fallback = `${panel.description} ${panel.beat}`.trim();
  const texts = visible.map((c) => c.pose || fallback);
  const presets = visible.map((c) => c.pose_preset || "auto");
  return planPanel(presets, texts, visible.length);
}

const CRAFT_UNIVERSAL = [
  "confident inked linework",
  "detail concentrated on the face and hands",
];

/*
  CRAFT_TAIL is kept separate and appended last: several tests and the
  documented tag order treat this phrase as the tail marker of the prompt.

  Everything that used to sit between them was WITHDRAWN, with the render that
  convicted it. "committed solid spot blacks", "deliberate flat areas of
  unbroken colour" and "negative space weighted to one side" together mean,
  quite reasonably, "large flat black shapes on an empty field" — and a
  two-character kiss rendered as faceless silhouettes. Same prompt, same seed,
  same checkpoint with the block disabled: a fully drawn couple. The rule, paid
  for twice: a prompt token naming an abstract craft QUALITY gets executed as a
  literal drawing instruction.
*/
const CRAFT_TAIL = "hand-drawn comic illustration";

function craftDirection(): string[] {
  // The gates on line weight, contrast and screentone survive in the Python,
  // but every constant they select is now the empty string, so the emitted
  // block is CRAFT_UNIVERSAL + the tail marker for any style pack.
  return [...CRAFT_UNIVERSAL, CRAFT_TAIL];
}

const BACKGROUND_SHOTS: ShotType[] = ["establishing", "wide"];

/*
  Danbooru vocabulary does the heavy lifting on a figure-free panel: `scenery`
  / `background art` is a learned cluster whose training images are finished
  anime background plates. Swapping the figure prose for these tags moved a
  render from a loose marker sketch to a drawn plate with real perspective —
  measured straight-run ink fraction 0.15 -> 0.38 on the same seed.
*/
const BACKGROUND_TAGS = ["scenery", "background art"];

const BACKGROUND_CRAFT = [
  "ruled straight architectural lines",
  "precise clean linework",
  "consistent line weight",
  "accurate perspective",
  "finished background art",
  "simple uncluttered composition, large readable shapes",
];

const COLOUR_TOKEN_RE =
  /\b(?:palette|colour|color|colours|colors|saturated|desaturated|saturation|muted|monochrome|duotone|greyscale|grayscale)\b/i;

/** The style's own colour direction, lifted forward into the background lead. */
const colourDiscipline = (style: StyleProfile): string[] =>
  style.positive_tokens.filter((t) => COLOUR_TOKEN_RE.test(t));

const FIGURE_STYLE_WORDS = [
  "face", "faces", "facial", "hand", "hands", "figure", "figures", "body",
  "bodies", "anatomy", "man", "men", "male", "woman", "women", "female", "boy",
  "girl", "person", "people", "skin", "hair", "eyes", "jaw", "jawline", "neck",
  "shoulders", "waist", "legs", "limbs", "muscular", "build", "proportions",
  "head", "portrait", "expression", "lips",
];
const FIGURE_STYLE_RE = new RegExp(`\\b(?:${FIGURE_STYLE_WORDS.join("|")})\\b`, "i");

/** Drop the comma-separated entries of a fragment that describe a person. */
const withoutFigureTokens = (fragment: string): string =>
  fragment
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t && !FIGURE_STYLE_RE.test(t))
    .join(", ");

/*
  is_background_panel. Three conditions, all required: the shot is about the
  environment, no cast is attached, and the author's own prompt text does not
  ask for a person either — someone who typed "1boy on the rooftop" and never
  filled in the cast is drawing a figure.
*/
function isBackgroundPanel(panel: Panel): boolean {
  if (!BACKGROUND_SHOTS.includes(panel.shot.type)) return false;
  if (panel.characters.some((c) => c.visible)) return false;
  return !wantsFigures(`${panel.prompt.override} ${panel.prompt.extra}`);
}

/*
  derive_prompt. Ordering matters more than wording on danbooru-captioned
  checkpoints: their training captions run subject -> details -> quality, so

      1boy, solo, <appearance>, <shot>, <action/scene>, <style>, masterpiece

  Leading with the style block instead buries the subject ~40 tokens deep
  behind phrases like "beautiful detailed eyes" and "delicate jawlines", which
  are themselves female-coded in that tag space. The observed result was a male
  lead rendered as a dark-haired woman even with `1boy` present.
*/
function derivePrompt(
  panel: Panel,
  scene: Scene,
  style: StyleProfile,
): { positive: string; negative: string; plan: PosePlan; background: boolean } {
  const parts: string[] = [];
  const visible = panel.characters.filter((c) => c.visible);
  const authorText = `${panel.prompt.override} ${panel.prompt.extra}`;
  const depictsFigures = visible.length > 0 || wantsFigures(authorText);
  const authorStressesHands = authorText.toLowerCase().includes("hand");

  parts.push(crowdControl(visible, !wantsFigures(authorText)));

  const background = isBackgroundPanel(panel);
  if (background) parts.push([...BACKGROUND_TAGS, ...colourDiscipline(style)].join(", "));

  const plan = posePlanFor(panel);

  visible.forEach((cip, idx) => {
    const ch = characterById(cip.character_id);
    if (!ch) return;
    const bits = [characterFragment(ch, cip.outfit_id)];
    if (cip.expression && cip.expression !== "neutral") bits.push(`${cip.expression} expression`);
    if (cip.pose) bits.push(cip.pose);
    const poseBits = plan.per_character[idx] ?? [];
    if (poseBits.length) bits.push(poseBits.join(", "));
    if (cip.facing === "away") bits.push("seen from behind");
    else if (cip.facing === "toward") bits.push("facing the viewer");
    else if (cip.facing === "left" || cip.facing === "right")
      bits.push(`facing ${cip.facing}, profile view`);
    if (cip.depth === "foreground") bits.push("in the foreground, close to camera");
    else if (cip.depth === "background") bits.push("in the background, smaller in frame");
    parts.push(bits.filter(Boolean).join(", "));
  });

  parts.push(...relationshipTags(visible));
  parts.push(...interactionTags(panel));
  // When the author has written their own hand direction, drop the library's
  // weighted push rather than emitting both — the two together made hands the
  // subject of the panel.
  const shared = authorStressesHands
    ? plan.shared.filter((c) => !HAND_POSITIVE.includes(c))
    : plan.shared;
  parts.push(...shared);
  if (visible.length >= 2)
    parts.push("clear separation between figures, correct number of limbs");

  // `establishing` and `wide` both promise figures in the phrase itself, which
  // on a panel that opened with `no humans` is a self-contradiction.
  const shotPhrase = SHOT_PHRASES[panel.shot.type] ?? "medium shot";
  parts.push(background ? withoutFigureTokens(shotPhrase) : shotPhrase);
  parts.push(ANGLE_PHRASES[panel.shot.angle] ?? "eye level");
  if (panel.shot.depth_of_field > 0.4) parts.push("shallow depth of field, background bokeh");

  if (panel.description) parts.push(panel.description);
  const setting = panel.setting_override || sceneSetting(scene);
  if (setting) parts.push(setting);
  const tod = (panel.time_of_day || "").toLowerCase();
  if (tod) parts.push(timePhrase(tod, style));

  if (panel.fx.speed_lines > 0.3) parts.push("radial speed lines, motion streaks");
  if (panel.fx.focus_lines > 0.3) parts.push("dramatic focus lines converging on the subject");
  if (panel.fx.flash > 0.3) parts.push("bright impact flash, blown highlights");
  if (panel.fx.blur_background > 0.3) parts.push("heavily blurred background");

  if (style.tone.rim_light) parts.push("rim lighting on the subject");
  if (style.tone.bloom > 0.25) parts.push("soft bloom on highlights");
  if (style.palette.length) parts.push("color palette: " + style.palette.slice(0, 4).join(", "));
  parts.push(background ? withoutFigureTokens(styleFragment(style)) : styleFragment(style));
  if (style.proportions && !background) parts.push(style.proportions);

  if (!background) parts.push(...ANATOMY_POSITIVE);
  if (visible.length > 1) parts.push(...MULTI_FIGURE_POSITIVE);
  if (background) {
    parts.push(...BACKGROUND_CRAFT);
    parts.push(CRAFT_TAIL);
  } else {
    parts.push(...craftDirection());
  }

  const positive = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(", ");

  const charNegatives: string[] = [];
  for (const cip of visible) {
    const ch = characterById(cip.character_id);
    if (ch) charNegatives.push(...ch.negative_tokens);
  }

  // (tokens, cap). Caps are sized so every concern keeps a voice inside the
  // budget: subject > anatomy > panel furniture > pose > style. Pure priority
  // starved everything below the first two groups.
  const negative = trimNegatives([
    [genderNegatives(visible), 6],
    [depictsFigures ? ANATOMY_NEGATIVE : [], 14],
    [depictsFigures ? SHEET_NEGATIVE : [], 6],
    [PANEL_NEGATIVE, 8],
    [charNegatives, 6],
    // Hand visibility gets its own slot ahead of the rest of the pose plan.
    // Folded in with it, the stiffness tokens sorted first and ate the cap.
    [depictsFigures ? plan.negative.filter((n) => n.toLowerCase().includes("hand")) : [], 8],
    [depictsFigures ? plan.negative : [], 8],
    [style.negative_tokens, 6],
    [MACHINE_TELLS, 10],
  ]).join(", ");

  return { positive, negative, plan, background };
}

function sceneSetting(scene: Scene): string {
  const bits = [scene.setting];
  if (scene.mood) bits.push(`${scene.mood} atmosphere`);
  return bits.filter(Boolean).join(", ");
}

/*
  panel_seed. Reusing a character's identity seed across panels measurably
  helps face consistency on SDXL, so the seed is anchored on whoever is in
  frame and perturbed by the panel index for variety.
*/
function panelSeed(panel: Panel): number {
  let base = 0;
  for (const cip of panel.characters) {
    const ch = characterById(cip.character_id);
    if (ch) base = (base ^ ch.identity_seed) >>> 0;
  }
  if (base === 0) {
    // The Python falls back to `abs(hash(panel.id))`, which is salted per
    // process and cannot be reproduced. This stands in for it.
    for (const c of panel.id) base = (base * 31 + c.charCodeAt(0)) >>> 0;
  }
  return (base + panel.index * 7919) % 2 ** 31;
}

/*
  generation_size. SDXL degrades badly away from ~1MP, so render at the right
  SHAPE near 1MP and let the panel scale it, rather than at panel resolution.
*/
function generationSize(panel: Panel, targetPixels = 1024 * 1024): [number, number] {
  const aspect = panel.width / Math.max(1, panel.height);
  const h = Math.sqrt(targetPixels / aspect);
  const w = h * aspect;
  const snap = (v: number) => Math.max(512, Math.round(v / 64) * 64);
  return [snap(w), snap(h)];
}

// ==========================================================================
// blender_bridge.py — the 3D blockout
//
// THE COORDINATE CONVENTION, ONCE, IN ONE PLACE. Every number below is Blender
// world space: right-handed, Z-up, metres. +X screen right, +Y away from the
// default camera into the set, +Z up. A character's origin is between its
// feet, so z == 0 is standing on the floor.
//
// Getting a sign wrong here does not raise — it silently mirrors the whole
// set, which is why the three.js mapping lives in one tested function.
// ==========================================================================

type Transform3D = {
  x: number; y: number; z: number;
  yaw: number; pitch: number; roll: number;
  scale: number;
};

type CameraSpec = {
  x: number; y: number; z: number;
  target_x: number; target_y: number; target_z: number;
  focal_length: number;
  sensor_width: number;
  sensor_fit: "auto" | "horizontal" | "vertical";
  roll_degrees: number;
};

/** Keyword -> Blender set builder. First match on the scene's setting wins. */
const SET_KEYWORDS: [string[], string][] = [
  [["bedroom", "bed", "dorm"], "bedroom"],
  [["cafe", "café", "coffee", "restaurant", "diner", "bar"], "cafe"],
  [["classroom", "school", "lecture", "class"], "classroom"],
  [["rooftop", "roof"], "rooftop"],
  [["street", "alley", "road", "sidewalk", "city", "downtown", "crosswalk"], "street"],
  [["room", "apartment", "office", "kitchen", "living", "indoor", "inside"], "room"],
];

function chooseSet(setting: string): string {
  const low = (setting || "").toLowerCase();
  for (const [keys, name] of SET_KEYWORDS) if (keys.some((k) => low.includes(k))) return name;
  return low ? "room" : "empty";
}

/*
  Yaw in degrees per `facing`. These are the numbers the 2.5D path has always
  sent, and the 3D derivation reproduces them exactly so migrating a project
  does not move anybody.

  Behaviour preserved deliberately, not endorsed: the mannequin's face marker
  is at -Y at yaw 0 and the default camera sits on the -Y side, so `away`
  (yaw 0) actually turns the figure TOWARD camera and `toward` (yaw 180) turns
  it away. Flipping the table is a one-line fix that would also silently
  re-stage every character in every existing project.
*/
const FACING_DEG: Record<string, number> = {
  toward: 180.0,
  away: 0.0,
  left: 90.0,
  right: -90.0,
  three_quarter: 155.0,
};

/*
  These three tables MUST match blender_addon/manhwa_bridge.py. They are
  duplicated rather than imported because that file is a Blender addon and
  cannot be imported outside Blender. tests/test_staging_3d.py parses the addon
  source and asserts they are identical, so drift fails the suite instead of
  quietly mis-framing panels. The copy is what lets the backend derive a camera
  with Blender closed — which is exactly the situation this page is in.
*/
const SHOT_COVERAGE: Record<string, number> = {
  establishing: 12.0, wide: 6.0, full: 2.3, two_shot: 2.6, medium: 1.25,
  medium_close: 0.85, over_shoulder: 1.0, pov: 2.0, reaction: 0.55,
  closeup: 0.5, insert: 0.3, extreme_closeup: 0.22,
};

const SHOT_AIM_Z: Record<string, number> = {
  establishing: 1.2, wide: 1.1, full: 0.95, two_shot: 1.35, medium: 1.32,
  medium_close: 1.5, over_shoulder: 1.5, pov: 1.6, reaction: 1.58,
  closeup: 1.58, insert: 1.1, extreme_closeup: 1.6,
};

const ANGLE_PITCH: Record<string, number> = {
  eye: 0.0, low: -22.0, high: 20.0, birds_eye: 62.0, worms_eye: -55.0, dutch: 0.0,
};

/** Lateral spread by shot — widens as the shot widens so figures don't overlap. */
const SHOT_SPREAD: Partial<Record<ShotType, number>> = {
  establishing: 7.0, wide: 4.5, full: 3.0, two_shot: 2.0, medium: 1.6,
};
const DEFAULT_SPREAD = 1.2;

const DEPTH_Y: Record<string, number> = {
  foreground: -1.6, midground: 0.0, background: 3.2,
};

const spreadFor = (panel: Panel): number => SHOT_SPREAD[panel.shot.type] ?? DEFAULT_SPREAD;

/** The 3D transform the 2.5D fields have always implied. */
function deriveTransform(panel: Panel, cip: CharacterInPanel): Transform3D {
  return {
    x: round((cip.screen_x - 0.5) * spreadFor(panel), 3),
    y: DEPTH_Y[cip.depth] ?? 0.0,
    z: 0.0,
    yaw: FACING_DEG[cip.facing] ?? 155.0,
    pitch: 0.0,
    roll: 0.0,
    scale: 1.0,
  };
}

/*
  Vertical FOV in degrees. With Blender's AUTO sensor fit the sensor size
  describes the LONGER image dimension, so for a portrait panel it is already
  the vertical extent — the bug that once parked the camera ~1.3x too close and
  cropped every head.
*/
function verticalFovDegrees(
  focalMm: number,
  sensorMm: number,
  aspect: number,
  fit: string,
): number {
  const focal = Math.max(1e-6, focalMm);
  let sensorV: number;
  if (fit === "vertical") sensorV = sensorMm;
  else if (fit === "horizontal") sensorV = sensorMm / Math.max(1e-6, aspect);
  else sensorV = aspect <= 1.0 ? sensorMm : sensorMm / aspect;
  return (Math.atan(sensorV / 2.0 / focal) * 2.0 * 180) / Math.PI;
}

/** Vary the camera side per panel so consecutive shots aren't identical. */
function azimuthFor(panel: Panel): number {
  if (panel.shot.type === "over_shoulder") return 34.0;
  if (panel.shot.type === "pov") return 0.0;
  // Alternate sides but stay on one side of the 180 line within a scene.
  return panel.index % 2 === 0 ? 22.0 : 22.0 * 0.45;
}

/*
  derive_camera. Ports `setup_camera` from the addon exactly, including the
  aim-height override and the 0.6m minimum distance, so a panel nobody has
  touched in the viewport reports the same camera the renderer actually used.

  Position + look-at target, not orbit: it is what three.js already speaks, it
  is what Blender itself computes, and orbit degenerates — a POV or extreme
  close-up drives distance toward zero, where yaw/pitch stop being defined.
*/
function deriveCamera(panel: Panel, aspect: number, transforms: Transform3D[]): CameraSpec {
  const xs = transforms.map((t) => t.x);
  const ys = transforms.map((t) => t.y);
  const tx = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0.0;
  const ty = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0.0;
  let tz = 1.4; // chest height on the shortest figure, so heads stay in frame

  const shot = panel.shot.type;
  const focal = panel.shot.focal_length;
  const sensor = 36.0;
  const coverage = SHOT_COVERAGE[shot] ?? 1.25;
  const vfov = (verticalFovDegrees(focal, sensor, aspect, "auto") * Math.PI) / 180;
  const dist = Math.max(coverage / 2.0 / Math.max(Math.tan(vfov / 2.0), 1e-4), 0.6);

  const angle = panel.shot.angle;
  const pitch = ((ANGLE_PITCH[angle] ?? 0.0) * Math.PI) / 180;
  const az = (azimuthFor(panel) * Math.PI) / 180;
  if (shot in SHOT_AIM_Z && Math.abs(tz - 1.4) < 0.01) tz = SHOT_AIM_Z[shot];

  const horiz = dist * Math.cos(pitch);
  const dutch = panel.shot.dutch_degrees;
  const roll = angle === "dutch" || dutch ? dutch || -9.0 : 0.0;
  return {
    x: tx + horiz * Math.sin(az),
    y: ty - horiz * Math.cos(az),
    z: tz + dist * Math.sin(pitch),
    target_x: tx,
    target_y: ty,
    target_z: tz,
    focal_length: focal,
    sensor_width: sensor,
    sensor_fit: "auto",
    roll_degrees: roll,
  };
}

type Vec3 = [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function norm(a: Vec3): Vec3 {
  const n = Math.hypot(a[0], a[1], a[2]);
  return n < 1e-12 ? [0, 0, 0] : [a[0] / n, a[1] / n, a[2] / n];
}

/*
  camera_basis — reproduces Blender's `direction.to_track_quat('-Z','Y')`: the
  camera looks along `forward` down its local -Z, with `up` kept as close to
  world +Z as possible. Roll is applied afterwards about the view axis.
*/
function cameraBasis(cam: CameraSpec): [Vec3, Vec3, Vec3] {
  let forward = norm(
    sub([cam.target_x, cam.target_y, cam.target_z], [cam.x, cam.y, cam.z]),
  );
  if (!forward.some(Boolean)) forward = [0, 1, 0];
  let right = norm(cross(forward, [0, 0, 1]));
  if (!right.some(Boolean)) right = norm(cross(forward, [0, 1, 0]));
  let up = cross(right, forward);

  const r = (cam.roll_degrees * Math.PI) / 180;
  if (r) {
    const cr = Math.cos(r);
    const sr = Math.sin(r);
    const nr: Vec3 = [
      cr * right[0] + sr * up[0], cr * right[1] + sr * up[1], cr * right[2] + sr * up[2],
    ];
    const nu: Vec3 = [
      -sr * right[0] + cr * up[0], -sr * right[1] + cr * up[1], -sr * right[2] + cr * up[2],
    ];
    right = nr;
    up = nu;
  }
  return [forward, right, up];
}

/*
  project_to_screen — Blender world point to 0..1 from the panel's TOP-LEFT,
  the convention CharacterInPanel.screen_x/screen_y and the letterer both use.
  Returns depth in metres in front of the camera; negative means behind it.
*/
function projectToScreen(
  cam: CameraSpec,
  point: Vec3,
  aspect: number,
): [number, number, number] {
  const [forward, right, up] = cameraBasis(cam);
  const v = sub(point, [cam.x, cam.y, cam.z]);
  const z = dot(v, forward);
  if (Math.abs(z) < 1e-6) return [0.5, 0.5, z];
  const sensorV =
    2.0 *
    Math.max(1e-6, cam.focal_length) *
    Math.tan(
      (verticalFovDegrees(cam.focal_length, cam.sensor_width, aspect, cam.sensor_fit) *
        Math.PI) /
        180 /
        2.0,
    );
  const sensorH = sensorV * aspect;
  const ndcX = ((dot(v, right) / z) * cam.focal_length) / (sensorH / 2.0);
  const ndcY = ((dot(v, up) / z) * cam.focal_length) / (sensorV / 2.0);
  return [(ndcX + 1.0) / 2.0, (1.0 - ndcY) / 2.0, z];
}

/*
  eye_height — world Z of roughly the head, for screen projection. The
  mannequin's head centre sits at ~1.78m on a 1.75m reference figure.
*/
function eyeHeight(cip: CharacterInPanel, t: Transform3D): number {
  const ch = characterById(cip.character_id);
  const h = (ch?.appearance.height_cm ?? 175) / 100.0;
  return t.z + 1.78 * (h / 1.75) * t.scale;
}

/** control_pass_size — control-pass resolution matched to the generation aspect. */
function controlPassSize(panel: Panel): [number, number] {
  const [gw, gh] = generationSize(panel);
  const size = SETTINGS.control_size;
  return [size, Math.max(256, Math.round((size * gh) / gw / 8) * 8)];
}

type Figure = {
  cip: CharacterInPanel;
  name: string;
  transform: Transform3D;
  derived: boolean;
  height_m: number;
  pose: string;
};

type Staging = {
  set: string;
  aspect: number;
  figures: Figure[];
  camera: CameraSpec;
  camera_derived: boolean;
  fov_v: number;
  distance: number;
  moved: number;
};

/*
  resolve_staging + sync_screen_coords, run together the way the app does.

  The second half is the load-bearing part: the letterer places balloons and
  tails off screen_x/screen_y, so a figure moved in the 3D viewport has to move
  those too or the speech balloon stays pointing at where the character used to
  be. That is the edge this stage feeds to the lettering stage below.
*/
function resolveStaging(panel: Panel, scene: Scene): Staging {
  const [cw, chh] = controlPassSize(panel);
  const aspect = cw / Math.max(1, chh);

  const figures: Figure[] = panel.characters.map((cip) => {
    const ch = characterById(cip.character_id);
    const t = deriveTransform(panel, cip);
    return {
      cip,
      name: ch?.name ?? "?",
      transform: t,
      derived: true, // nobody has hand-placed one of these
      height_m: round(((ch?.appearance.height_cm ?? 175) / 100.0) * t.scale, 4),
      // pose_preset is "auto" and the director writes no pose text, so
      // choose_pose("") returns the twelve-preset default.
      pose: "standing",
    };
  });

  const transforms = figures.filter((f) => f.cip.visible).map((f) => f.transform);
  const camera = deriveCamera(panel, aspect, transforms);

  let moved = 0;
  for (const f of figures) {
    if (!f.cip.visible) continue;
    const [sx, sy, depth] = projectToScreen(
      camera,
      [f.transform.x, f.transform.y, eyeHeight(f.cip, f.transform)],
      aspect,
    );
    // A figure behind the camera has no meaningful screen position; leave the
    // last good one rather than writing a mirrored nonsense value.
    if (depth <= 0) continue;
    const nx = round(Math.min(1, Math.max(0, sx)), 4);
    const ny = round(Math.min(1, Math.max(0, sy)), 4);
    if (nx !== f.cip.screen_x || ny !== f.cip.screen_y) {
      f.cip.screen_x = nx;
      f.cip.screen_y = ny;
      moved += 1;
    }
  }

  const vfov = verticalFovDegrees(camera.focal_length, camera.sensor_width, aspect, "auto");
  const distance = Math.hypot(
    camera.x - camera.target_x,
    camera.y - camera.target_y,
    camera.z - camera.target_z,
  );
  return {
    set: chooseSet(panel.setting_override || scene.setting),
    aspect: round(aspect, 6),
    figures,
    camera,
    camera_derived: true,
    fov_v: vfov,
    distance,
    moved,
  };
}

// ==========================================================================
// render.py + comfy.py — conditioning weights and the ComfyUI graph
// ==========================================================================

/*
  The decisive finding was that DEPTH was never the problem — LINEART was.
  Blender's Freestyle pass traces the mannequin's box edges exactly, and a
  lineart ControlNet follows contours far more literally than depth follows
  volume, so it reproduced the proxy: a box-limbed dummy with a face. Depth at
  ~0.27 on a medium shot produced the best render in this project.
*/
const DEPTH_CAP = 0.35;

const CONTROL_SCALE_BY_SHOT: Record<string, number> = {
  establishing: 1.0, wide: 0.9, full: 0.8, pov: 0.8, two_shot: 0.7,
  medium: 0.8, medium_close: 0.6, over_shoulder: 0.6, closeup: 0.3,
  reaction: 0.3, extreme_closeup: 0.0, insert: 0.0,
};

/*
  NOT the inverse of the table above by accident. That one asks "how much of
  this frame is set dressing the blockout gets right?" and falls away as the
  shot tightens. Pose asks the opposite — "how much of this frame is body?" —
  and a skeleton is most useful exactly where the depth pass is least
  trustworthy. Both ends are switched off: on an establishing shot the figures
  are a few dozen pixels tall and the skeleton is thinner than its own stick
  width; on an insert there is no body in frame at all.
*/
const POSE_SCALE_BY_SHOT: Record<string, number> = {
  establishing: 0.35, wide: 0.5, full: 1.0, two_shot: 1.0, medium: 0.95,
  pov: 0.5, medium_close: 0.8, over_shoulder: 0.8, closeup: 0.45,
  reaction: 0.45, extreme_closeup: 0.0, insert: 0.0,
};

const controlScale = (panel: Panel): number => CONTROL_SCALE_BY_SHOT[panel.shot.type] ?? 0.5;
const poseScale = (panel: Panel): number => POSE_SCALE_BY_SHOT[panel.shot.type] ?? 0.7;

type RenderRequest = {
  positive: string;
  negative: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  clip_skip: number;
  checkpoint: string;
  depth_image: string | null;
  depth_model: string | null;
  depth_strength: number;
  depth_end: number;
  lineart_image: string | null;
  lineart_model: string | null;
  lineart_strength: number;
  lineart_end: number;
  pose_image: string | null;
  pose_model: string | null;
  pose_strength: number;
  pose_end: number;
  batch_size: number;
};

/*
  render_panel's request assembly — which conditioning survives, and at what
  weight, for this panel.

  `controlnets` stands in for what ComfyUI reports it has installed. On this
  install settings.json has all three null (`auto_models` found no matching
  ControlNet), so the real graph skips all three stages; the toggle shows the
  other shape.
*/
function buildRequest(
  panel: Panel,
  positive: string,
  negative: string,
  controlnets: boolean,
): RenderRequest {
  const style = STYLE;
  const ctrl = style.control;
  const cscale = controlScale(panel);
  const pscale = poseScale(panel);
  const [width, height] = generationSize(panel);
  const hasFigures = panel.characters.some((c) => c.visible);

  const depthModel = controlnets ? "<depth controlnet>" : SETTINGS.depth_controlnet;
  const lineartModel = controlnets ? "<lineart controlnet>" : SETTINGS.lineart_controlnet;
  const poseModel = controlnets ? "<openpose controlnet>" : SETTINGS.openpose_controlnet;

  const depthImage = depthModel ? `${panel.id}_depth.png` : null;
  // Blender lineart is used only when no character is in the panel — an
  // establishing shot of a room genuinely benefits from ruled perspective
  // lines, and a figure only gets the mannequin's box edges traced.
  const lineartImage = lineartModel && !hasFigures ? `${panel.id}_lineart.png` : null;
  // The pose pass is the only conditioning that describes a body directly. It
  // is gated on there being a figure and on the shot having limbs in frame.
  const poseImage =
    hasFigures && pscale > 0 && poseModel ? `${panel.id}_pose.png` : null;

  return {
    positive,
    negative,
    width,
    height,
    seed: panelSeed(panel),
    steps: style.render.steps,
    cfg: style.render.cfg,
    sampler: style.render.sampler,
    scheduler: style.render.scheduler,
    clip_skip: style.render.clip_skip,
    // A style that names its own checkpoint always wins; otherwise a
    // figure-free panel may route to the background checkpoint.
    checkpoint:
      style.render.checkpoint ??
      (isBackgroundPanel(panel) && SETTINGS.background_checkpoint
        ? SETTINGS.background_checkpoint
        : SETTINGS.checkpoint),
    depth_image: depthImage,
    depth_model: depthModel,
    depth_strength: ctrl.enabled ? Math.min(ctrl.depth_strength, DEPTH_CAP) * cscale : 0.0,
    depth_end: ctrl.depth_end * (0.6 + 0.4 * cscale),
    lineart_image: lineartImage,
    lineart_model: lineartModel,
    lineart_strength: ctrl.enabled ? ctrl.lineart_strength * cscale : 0.0,
    lineart_end: ctrl.lineart_end,
    pose_image: poseImage,
    pose_model: poseModel,
    // Capped by the openpose_strength setting the same way depth is capped by
    // DEPTH_CAP, so a style shipping a high pose_strength cannot quietly push
    // the skeleton into tracing territory.
    pose_strength: ctrl.enabled
      ? Math.min(ctrl.pose_strength, SETTINGS.openpose_strength) * pscale
      : 0.0,
    pose_end: SETTINGS.openpose_end,
    batch_size: 1,
  };
}

type GraphNode = { class_type: string; inputs: Record<string, unknown> };

/** Where the ControlNet stages live in the graph, and how far apart. */
const CN_BASE = 30;
const CN_STRIDE = 3;

/*
  build_workflow. Workflows are built as plain dicts in the ComfyUI API format
  rather than loaded from exported JSON templates — it keeps the graph readable
  and lets ControlNets be toggled per panel without maintaining N templates.

      Checkpoint -> [LoRA...] -> CLIPSetLastLayer -> CLIP encode (pos/neg)
                                                          |
      depth   --\                                         v
      lineart --> ControlNetApplyAdvanced -----------> KSampler -> VAEDecode -> Save
      pose    --/                                        ^
      EmptyLatentImage ----------------------------------/

  The stride used to be 10, which was fine for two stages and collided with the
  latent nodes at 50 the moment a third was added.
*/
function buildWorkflow(req: RenderRequest): Record<string, GraphNode> {
  const g: Record<string, GraphNode> = {};
  g["1"] = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: req.checkpoint } };
  const modelRef: [string, number] = ["1", 0];
  let clipRef: [string, number] = ["1", 1];
  const vaeRef: [string, number] = ["1", 2];

  g["20"] = {
    class_type: "CLIPSetLastLayer",
    inputs: { stop_at_clip_layer: req.clip_skip, clip: clipRef },
  };
  clipRef = ["20", 0];

  g["21"] = { class_type: "CLIPTextEncode", inputs: { text: req.positive, clip: clipRef } };
  g["22"] = { class_type: "CLIPTextEncode", inputs: { text: req.negative, clip: clipRef } };
  let posRef: [string, number] = ["21", 0];
  let negRef: [string, number] = ["22", 0];

  // Each stage chains BOTH conditioning outputs, so adding one never rewires
  // the stages before it. A stage is skipped independently when its image,
  // model or strength is missing.
  let cnId = CN_BASE;
  const stages: [string | null, string | null, number, number][] = [
    [req.depth_image, req.depth_model, req.depth_strength, req.depth_end],
    [req.lineart_image, req.lineart_model, req.lineart_strength, req.lineart_end],
    [req.pose_image, req.pose_model, req.pose_strength, req.pose_end],
  ];
  for (const [image, model, strength, end] of stages) {
    if (!image || !model || strength <= 0) continue;
    const load = String(cnId);
    const loader = String(cnId + 1);
    const apply = String(cnId + 2);
    g[load] = { class_type: "LoadImage", inputs: { image } };
    g[loader] = { class_type: "ControlNetLoader", inputs: { control_net_name: model } };
    g[apply] = {
      class_type: "ControlNetApplyAdvanced",
      inputs: {
        strength: round(strength, 4),
        start_percent: 0.0,
        end_percent: round(end, 4),
        positive: posRef,
        negative: negRef,
        control_net: [loader, 0],
        image: [load, 0],
      },
    };
    posRef = [apply, 0];
    negRef = [apply, 1];
    cnId += CN_STRIDE;
  }

  g["51"] = {
    class_type: "EmptyLatentImage",
    inputs: { width: req.width, height: req.height, batch_size: req.batch_size },
  };
  g["60"] = {
    class_type: "KSampler",
    inputs: {
      seed: req.seed,
      steps: req.steps,
      cfg: req.cfg,
      sampler_name: req.sampler,
      scheduler: req.scheduler,
      denoise: 1.0,
      model: modelRef,
      positive: posRef,
      negative: negRef,
      latent_image: ["51", 0],
    },
  };
  g["61"] = { class_type: "VAEDecode", inputs: { samples: ["60", 0], vae: vaeRef } };
  g["62"] = {
    class_type: "SaveImage",
    inputs: { filename_prefix: "manhwa/panel", images: ["61", 0] },
  };
  return g;
}

// ==========================================================================
// lettering.py — text fitting, balloon geometry, placement, tails
// ==========================================================================

/*
  FONT_PREFS, the families the Python looks for on disk, reused here as a CSS
  stack. The app measures with Pillow against the actual TTF it found; the
  browser measures with whichever of these it has. Same list, different
  rasteriser — so line breaks can land a word differently from the app's.

  `body` resolves to ComicNeue-Bold, which is why it carries weight 700:
  text_role picks a FILE rather than letting the renderer synthesise a weight,
  because synthetic obliquing widens glyphs by a few percent — exactly enough
  for a line that fits in the export to spill out of the balloon in the editor.
*/
type Role = "body" | "bold" | "italic" | "bolditalic" | "narration" | "narration_italic";

const ROLE_FONT: Record<Role, { stack: string; weight: number; italic: boolean }> = {
  body: {
    stack: `"ComicNeue-Bold","ComicNeue","Comic Sans MS",Chalkboard,Verdana,Helvetica`,
    weight: 700,
    italic: false,
  },
  bold: {
    stack: `"ComicNeue-Bold","Comic Sans MS",Chalkboard,Arial,Helvetica`,
    weight: 700,
    italic: false,
  },
  italic: {
    stack: `"ComicNeue-Italic","Comic Sans MS",Helvetica`,
    weight: 400,
    italic: true,
  },
  bolditalic: {
    stack: `"ComicNeue-BoldItalic","ComicNeue-Italic",Helvetica`,
    weight: 700,
    italic: true,
  },
  narration: {
    stack: `"ComicNeue",Georgia,"Times New Roman",Helvetica`,
    weight: 400,
    italic: false,
  },
  narration_italic: {
    stack: `"ComicNeue-Italic",Georgia,Helvetica`,
    weight: 400,
    italic: true,
  },
};

type Font = { role: Role; size: number };

const fontCss = (f: Font): string => {
  const r = ROLE_FONT[f.role];
  return `${r.italic ? "italic " : ""}${r.weight} ${f.size}px ${r.stack}`;
};

let measureCtx: CanvasRenderingContext2D | null = null;
const widthCache = new Map<string, number>();

/*
  Pillow's getlength runs the full shaper and the fitter makes thousands of
  trial wraps, so the Python caches every measurement. Same here, for the same
  reason — the grid search below calls this hard.
*/
function measure(font: Font, s: string): number {
  const key = `${font.role}|${font.size}|${s}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  if (!measureCtx) return s.length * font.size * 0.5;
  measureCtx.font = fontCss(font);
  const val = measureCtx.measureText(s).width;
  if (widthCache.size > 300_000) widthCache.clear();
  widthCache.set(key, val);
  return val;
}

/*
  CSS letter-spacing adds the gap after EVERY glyph, including the last one.
  Pillow has no tracking at all, so the Python advances manually and measures
  with the same rule on both sides — otherwise centred text drifts by
  tracking/2.
*/
const textWidth = (font: Font, s: string, tracking = 0): number =>
  s ? measure(font, s) + tracking * s.length : 0;

/** Font ascent/descent, for the baseline. PIL exposes these as font.getmetrics(). */
function fontMetrics(font: Font): [number, number] {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return [font.size * 0.8, font.size * 0.2];
  measureCtx.font = fontCss(font);
  const m = measureCtx.measureText("Hxg");
  const a = m.fontBoundingBoxAscent;
  const d = m.fontBoundingBoxDescent;
  if (typeof a === "number" && typeof d === "number" && a + d > 0) return [a, d];
  return [font.size * 0.8, font.size * 0.2];
}

function isCjk(ch: string): boolean {
  const o = ch.codePointAt(0) ?? 0;
  return (
    (o >= 0x3040 && o <= 0x30ff) ||
    (o >= 0x3400 && o <= 0x4dbf) ||
    (o >= 0x4e00 && o <= 0x9fff) ||
    (o >= 0xf900 && o <= 0xfaff) ||
    (o >= 0xff00 && o <= 0xff60) ||
    (o >= 0xac00 && o <= 0xd7a3)
  );
}

/** Kinsoku shori, short version: no opening at a line end, no closer at a start. */
const NO_LINE_START = new Set("、。，．・：；？！）〕］｝〉》」』】〟ゝゞーぁぃぅぇぉっゃゅょゎ々!?,.:;)]}»”’");
const NO_LINE_END = new Set("（〔［｛〈《「『【〝([{«“‘");

/** Latin words break on whitespace; CJK breaks between any two characters. */
function tokenise(para: string): [string, boolean][] {
  const units: [string, boolean][] = [];
  let buf = "";
  let pendingSpace = false;
  for (const ch of para) {
    if (/\s/.test(ch)) {
      if (buf) {
        units.push([buf, pendingSpace]);
        buf = "";
        pendingSpace = false;
      }
      pendingSpace = true;
      continue;
    }
    if (isCjk(ch)) {
      if (buf) {
        units.push([buf, pendingSpace]);
        buf = "";
        pendingSpace = false;
      }
      units.push([ch, pendingSpace]);
      pendingSpace = false;
    } else {
      buf += ch;
    }
  }
  if (buf) units.push([buf, pendingSpace]);
  return units;
}

/*
  Break an unbreakable word into NEAR-EQUAL chunks. Greedy max-fill is what
  produced `ANTIDISESTABLISHMENTARIANIS` / `M`; a real letterer splits a
  monster word down the middle.
*/
function splitLong(word: string, font: Font, maxPx: number, tracking: number): string[] {
  const total = textWidth(font, word, tracking);
  if (total <= maxPx || word.length < 2) return [word];
  let parts = Math.max(2, Math.ceil(total / Math.max(1, maxPx)));
  let chunks: string[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const target = total / parts;
    chunks = [];
    let cur = "";
    for (const ch of word) {
      if (cur && textWidth(font, cur + ch, tracking) > target && chunks.length < parts - 1) {
        chunks.push(cur);
        cur = ch;
      } else {
        cur += ch;
      }
    }
    if (cur) chunks.push(cur);
    if (chunks.every((c) => textWidth(font, c, tracking) <= maxPx)) return chunks;
    parts += 1;
  }
  return chunks;
}

/*
  Greedy wrap where every line has its own allowance. Variable widths are what
  let text follow the inside of an oval instead of a rectangle.
*/
function wrapVariable(
  text: string,
  font: Font,
  widths: (i: number) => number,
  tracking = 0,
): string[] {
  if (!text) return [];
  const out: string[] = [];
  const allowance = (i: number) => Math.max(1, widths(i));

  for (const para of text.split("\n")) {
    const units = tokenise(para);
    if (!units.length) {
      out.push("");
      continue;
    }
    let cur = "";
    for (const [word, space] of units) {
      let limit = allowance(out.length);
      const sep = space && cur && !isCjk(word[0]) ? " " : "";
      const trial = cur ? cur + sep + word : word;
      if (!cur) {
        if (textWidth(font, word, tracking) > limit) {
          const chunks = splitLong(word, font, limit, tracking);
          out.push(...chunks.slice(0, -1));
          cur = chunks[chunks.length - 1];
        } else {
          cur = word;
        }
        continue;
      }
      const forced = NO_LINE_START.has(word[0]) || NO_LINE_END.has(cur[cur.length - 1]);
      if (textWidth(font, trial, tracking) <= limit || forced) {
        cur = trial;
      } else {
        out.push(cur);
        limit = allowance(out.length);
        if (textWidth(font, word, tracking) > limit) {
          const chunks = splitLong(word, font, limit, tracking);
          out.push(...chunks.slice(0, -1));
          cur = chunks[chunks.length - 1];
        } else {
          cur = word;
        }
      }
    }
    out.push(cur);
  }
  return out;
}

/** Lower is better. Penalises ragged blocks and, hard, orphan last lines. */
function balanceScore(lines: string[], font: Font, tracking: number): number {
  const ws = lines.filter(Boolean).map((ln) => textWidth(font, ln, tracking));
  if (ws.length < 2) return 0;
  const widest = Math.max(...ws) || 1;
  const mean = ws.reduce((a, b) => a + b, 0) / ws.length;
  const varr = ws.reduce((a, w) => a + (w - mean) ** 2, 0) / ws.length;
  let score = Math.sqrt(varr) / widest;
  const last = ws[ws.length - 1] / widest;
  if (last < 0.34) score += (0.34 - last) * 4.0; // a lone word under a full line
  return score;
}

/*
  Re-wrap at progressively narrower measures, keep the tidiest block. The line
  COUNT is fixed by the widest wrap; squeezing below that only redistributes
  words, which is precisely how a letterer turns "...NO MATTER HOW / LONG IT
  TOOK." into two even lines.
*/
function balanceLines(
  text: string,
  font: Font,
  widths: (i: number) => number,
  tracking = 0,
): string[] {
  const base = wrapVariable(text, font, widths, tracking);
  const n = base.length;
  if (n < 2) return base;
  let best = base;
  let bestScore = balanceScore(base, font, tracking);
  for (const shrink of [0.96, 0.92, 0.88, 0.84, 0.8, 0.76, 0.72, 0.68]) {
    const cand = wrapVariable(text, font, (i) => widths(i) * shrink, tracking);
    if (cand.length !== n) continue;
    const sc = balanceScore(cand, font, tracking);
    if (sc < bestScore - 1e-6) {
      best = cand;
      bestScore = sc;
    }
  }
  return best;
}

/*
  speech / whisper / telepathy / aside are oval-bodied and fall through to the
  default branch of bubbleShapes; the rect kinds are the ones that change how
  text is measured, because an oval only offers its full width along the centre
  line and a box offers the same width everywhere.
*/
const RECT_KINDS = new Set<BubbleKind>(["narration", "caption", "offscreen"]);

/*
  Fraction of the box half-axes actually usable for text, per kind. An oval
  only offers its full width along the centre line; a starburst offers less
  still, because the text has to clear the spike valleys.
*/
const TEXT_INSET: Partial<Record<BubbleKind, [number, number]>> = {
  thought: [0.84, 0.78],
  shout: [0.78, 0.76],
};

type Pt = [number, number];

const ellipsePoints = (cx: number, cy: number, rx: number, ry: number, n = 48): Pt[] =>
  Array.from({ length: n }, (_, i) => [
    cx + rx * Math.cos((2 * Math.PI * i) / n),
    cy + ry * Math.sin((2 * Math.PI * i) / n),
  ]);

/** A shout. Uneven spikes read as anger; even ones read as clip-art. */
function burstPoints(
  cx: number, cy: number, rx: number, ry: number,
  spikes = 13, depth = 0.3, jitter = 0.0,
): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < spikes * 2; i++) {
    const a = (Math.PI * i) / spikes - Math.PI / 2;
    let k = i % 2 === 0 ? 1.0 : 1.0 - depth;
    if (jitter) k *= 1.0 + jitter * Math.sin(i * 2.399 + 1.1) * 0.5;
    pts.push([cx + rx * k * Math.cos(a), cy + ry * k * Math.sin(a)]);
  }
  return pts;
}

/*
  A thought bubble as a ring of overlapping lobes plus a filling core, returned
  as SEPARATE polygons. An earlier version took the convex hull of all the lobe
  points, which is exactly wrong — a hull erases the concave notches between
  lobes, so the cloud came out as a plain ellipse.
*/
function cloudLobes(cx: number, cy: number, rx: number, ry: number, lobes = 11): Pt[][] {
  const shapes: Pt[][] = [ellipsePoints(cx, cy, rx * 0.8, ry * 0.74, 40)];
  for (let i = 0; i < lobes; i++) {
    const a = (2 * Math.PI * i) / lobes;
    shapes.push(
      ellipsePoints(
        cx + rx * 0.74 * Math.cos(a),
        cy + ry * 0.7 * Math.sin(a),
        rx * 0.29,
        ry * 0.31,
        20,
      ),
    );
  }
  return shapes;
}

function roundedRectPoints(
  x: number, y: number, w: number, h: number, r: number, n = 8,
): Pt[] {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const pts: Pt[] = [];
  const corners: [number, number, number, number][] = [
    [x + w - r, y + r, -Math.PI / 2, 0],
    [x + w - r, y + h - r, 0, Math.PI / 2],
    [x + r, y + h - r, Math.PI / 2, Math.PI],
    [x + r, y + r, Math.PI, (3 * Math.PI) / 2],
  ];
  for (const [cx, cy, a0, a1] of corners) {
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return pts;
}

/** The polygons making up a bubble body, in panel pixels. */
function bubbleShapes(b: Bubble, pw: number, ph: number): Pt[][] {
  const x = b.x * pw;
  const y = b.y * ph;
  const w = b.w * pw;
  const h = b.h * ph;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;

  if (b.kind === "borderless") return [];
  if (b.kind === "shout")
    return [burstPoints(cx, cy, rx * 1.06, ry * 1.06, 14, 0.3, 0.22)];
  if (b.kind === "thought") return cloudLobes(cx, cy, rx, ry);
  if (b.kind === "narration") return [roundedRectPoints(x, y, w, h, Math.min(w, h) * 0.03)];
  if (b.kind === "caption") return [roundedRectPoints(x, y, w, h, Math.min(w, h) * 0.18)];
  if (b.kind === "offscreen") return [roundedRectPoints(x, y, w, h, Math.min(w, h) * 0.1)];
  return [ellipsePoints(cx, cy, rx, ry)];
}

/*
  Usable half-width of the text area at vertical offset `dy` from centre. This
  is the function that stops a long first line from running out through the
  side of an oval — the single most visible defect in the old output.
*/
function halfWidthAt(kind: BubbleKind, w: number, h: number, dy: number): number {
  let rx = w / 2;
  let ry = h / 2;
  if (RECT_KINDS.has(kind) || kind === "borderless") return rx;
  const [fx, fy] = TEXT_INSET[kind] ?? [1.0, 1.0];
  rx *= fx;
  ry *= fy;
  if (ry <= 0) return 0;
  const t = 1.0 - (dy / ry) ** 2;
  return t > 0 ? rx * Math.sqrt(t) : 0;
}

const verticalRoom = (kind: BubbleKind, h: number): number =>
  RECT_KINDS.has(kind) || kind === "borderless" ? h : h * (TEXT_INSET[kind] ?? [1, 1])[1];

type TextLayout = {
  lines: string[];
  size: number;
  line_height: number;
  role: Role;
  tracking: number;
  allowances: number[];
  fits: boolean;
};

function textRole(style: BubbleStyle, base: "body" | "narration"): Role {
  if (base === "narration") return style.italic ? "narration_italic" : "narration";
  if (style.bold && style.italic) return "bolditalic";
  if (style.italic) return "italic";
  if (style.bold) return "bold";
  return "body";
}

/*
  layout_text — fit `text` into a box, following the SHAPE.

  Binary-searches the largest size that fits, then spends the balancing budget
  once, on the winner. Balancing every trial size was ~10x the work for an
  answer that only ever mattered for the size actually used.
*/
function layoutText(
  text: string,
  boxW: number,
  boxH: number,
  style: BubbleStyle,
  kind: BubbleKind,
  baseRole: "body" | "narration",
): TextLayout {
  const role = textRole(style, baseRole);
  const tracking = style.tracking;
  const pad = style.padding;
  const display = style.uppercase ? text.toUpperCase() : text;
  const sizeMax = Math.trunc(Math.max(7, style.font_size));
  const sizeMin = Math.trunc(Math.max(6, Math.min(sizeMax, style.font_size_min)));

  if (!display.trim())
    return {
      lines: [], size: sizeMax, line_height: sizeMax * style.line_height,
      role, tracking, allowances: [], fits: true,
    };

  const attempt = (size: number, balance: boolean): TextLayout => {
    const font: Font = { role, size };
    const lineH = size * style.line_height;
    const roomH = verticalRoom(kind, boxH) - pad * 2;

    const allowanceFor = (i: number, n: number): number => {
      const dy = (i - (n - 1) / 2) * lineH;
      const edge = Math.abs(dy) + lineH * 0.4;
      return Math.max(1, 2 * halfWidthAt(kind, boxW, boxH, edge) - pad * 2);
    };

    // The allowance depends on the line count and the line count depends on
    // the allowance, so iterate to a fixed point. Two passes is the norm.
    let n = 1;
    let lines: string[] = [];
    for (let k = 0; k < 8; k++) {
      const cur = n;
      lines = wrapVariable(display, font, (i) => allowanceFor(i, cur), tracking);
      if (lines.length === n) break;
      n = Math.max(1, lines.length);
      if (n > 60) break;
    }
    if (balance) {
      const cur = n;
      lines = balanceLines(display, font, (i) => allowanceFor(i, cur), tracking);
      n = lines.length;
    }
    const allowances = Array.from({ length: n }, (_, i) => allowanceFor(i, n));
    const overflow = lines.some(
      (ln, i) => textWidth(font, ln, tracking) > (allowances[i] ?? 0) + 0.51,
    );
    return {
      lines, size, line_height: lineH, role, tracking, allowances,
      fits: n * lineH <= roomH + 0.51 && !overflow,
    };
  };

  let lo = sizeMin;
  let hi = sizeMax;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (attempt(mid, false).fits) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best === null) return attempt(sizeMin, true);
  const tidy = attempt(best, true);
  // Balancing narrows the measure, so re-check; fall back to the raw wrap if
  // the tidier block no longer fits.
  return tidy.fits ? tidy : attempt(best, false);
}

/*
  estimate_bubble_size — smallest normalised (w, h) holding `text` at its
  natural font size. Sweeps candidate widths and keeps the one whose block
  comes out closest to the aspect the KIND wants: wide and shallow for a
  narration box, close to a lozenge for speech. Sizing runs the same layout
  code the renderer will, so "auto-size" can never disagree with "does it fit".
*/
function estimateBubbleSize(
  text: string,
  style: BubbleStyle,
  panelW: number,
  panelH: number,
  kind: BubbleKind,
): [number, number] {
  if (!(text || "").trim()) return [0.2, 0.08];

  const targetAspect = RECT_KINDS.has(kind) ? 3.0 : 1.75;
  const pad = style.padding;
  const role = textRole(style, RECT_KINDS.has(kind) ? "narration" : "body");
  const size = Math.trunc(Math.max(7, style.font_size));
  const font: Font = { role, size };
  const tracking = style.tracking;
  const display = style.uppercase ? text.toUpperCase() : text;
  const lineH = size * style.line_height;

  let best: [number, number, number] | null = null;
  const lo = 0.14;
  const hi = 0.62;
  const steps = 25;
  for (let i = 0; i <= steps; i++) {
    const w = lo + ((hi - lo) * i) / steps;
    const measurePx = Math.max(1, w * panelW - pad * 2);
    // Plain wrap for the sweep. Balancing shifts a word between lines; it does
    // not change the line COUNT, which is all this loop reads.
    const lines = wrapVariable(display, font, () => measurePx, tracking);
    const n = Math.max(1, lines.length);
    const blockH = n * lineH;
    const blockW = lines.length
      ? Math.max(...lines.map((ln) => textWidth(font, ln, tracking)))
      : measurePx;

    let bw: number;
    let bh: number;
    if (RECT_KINDS.has(kind) || kind === "borderless") {
      bw = blockW + pad * 2;
      bh = blockH + pad * 2;
    } else {
      // Smallest ellipse circumscribing the text block: rx = W/2 * sqrt2.
      const [fx, fy] = TEXT_INSET[kind] ?? [1.0, 1.0];
      bw = ((blockW + pad * 2) * Math.SQRT2) / fx;
      bh = ((blockH + pad * 2) * Math.SQRT2) / fy;
    }
    const nw = bw / panelW;
    const nh = bh / panelH;
    if (nw > 0.66 || nh > 0.55) continue;
    const aspect = bw / Math.max(1, bh);
    const cost =
      Math.abs(Math.log(Math.max(aspect, 0.05) / targetAspect)) + nw * 0.35 + nh * 0.35;
    if (best === null || cost < best[0]) best = [cost, nw, nh];
  }

  if (best === null) return [0.46, 0.3];
  return [round(Math.min(0.66, best[1]), 4), round(Math.min(0.55, best[2]), 4)];
}

/*
  A tail longer than this fraction of the panel's short side reads as a spear
  pointing across the page rather than speech coming from a mouth. Real
  letterers move the balloon instead of stretching the tail. Off-panel voices
  are the deliberate exception — that tail is MEANT to run to the edge.
*/
const MAX_TAIL_FRACTION = 0.17;
const OFFSCREEN_TAIL_FRACTION = 0.85;

const NO_TAIL_KINDS = new Set<BubbleKind>([
  "narration", "caption", "thought", "aside", "borderless",
]);

/*
  Farthest point where a ray from the balloon centre leaves the outline.
  Casting against the REAL outline is what makes a tail meet a starburst at a
  spike and a narration box at its side, instead of at an imaginary ellipse.
*/
function rayHit(poly: Pt[], cx: number, cy: number, ux: number, uy: number): Pt | null {
  let bestT: number | null = null;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    const ex = x2 - x1;
    const ey = y2 - y1;
    const den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((x1 - cx) * ey - (y1 - cy) * ex) / den;
    const s = ((x1 - cx) * uy - (y1 - cy) * ux) / den;
    if (t > 1e-6 && s >= -1e-9 && s <= 1 + 1e-9) {
      if (bestT === null || t > bestT) bestT = t;
    }
  }
  if (bestT === null) return null;
  return [cx + ux * bestT, cy + uy * bestT];
}

function quad(p0: Pt, c: Pt, p1: Pt, n = 10): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    out.push([
      mt * mt * p0[0] + 2 * mt * t * c[0] + t * t * p1[0],
      mt * mt * p0[1] + 2 * mt * t * c[1] + t * t * p1[1],
    ]);
  }
  return out;
}

/** Where the tail actually ends, after clamping. Panel pixels. */
function tailTip(b: Bubble, pw: number, ph: number): Pt | null {
  if (b.tail_x === null || b.tail_y === null) return null;
  if (NO_TAIL_KINDS.has(b.kind) && b.kind !== "thought") return null;
  if (b.link_to) return null;
  const cx = (b.x + b.w / 2) * pw;
  const cy = (b.y + b.h / 2) * ph;
  const tx = b.tail_x * pw;
  const ty = b.tail_y * ph;
  const dist = Math.hypot(tx - cx, ty - cy);
  if (dist < 1e-3) return null;
  const ux = (tx - cx) / dist;
  const uy = (ty - cy) / dist;

  const shapes = bubbleShapes(b, pw, ph);
  let base = shapes.length ? rayHit(shapes[0], cx, cy, ux, uy) : null;
  if (base === null) {
    const rx = (b.w * pw) / 2;
    const ry = (b.h * ph) / 2;
    const den = Math.hypot(ux * ry, uy * rx) || 1;
    base = [cx + (ux * (rx * ry)) / den, cy + (uy * (rx * ry)) / den];
  }

  const frac = b.kind === "offscreen" ? OFFSCREEN_TAIL_FRACTION : MAX_TAIL_FRACTION;
  const cap = frac * Math.min(pw, ph);
  const reach = Math.hypot(tx - base[0], ty - base[1]);
  if (reach > cap) return [base[0] + ux * cap, base[1] + uy * cap];
  return [tx, ty];
}

/*
  A curved, tapering tail attached on the balloon's real perimeter. Both flanks
  hook the same way, which gives a hand-lettered tail its comma shape rather
  than the symmetric traffic cone the old code drew.
*/
function tailPolygon(b: Bubble, pw: number, ph: number): Pt[] | null {
  const tip = tailTip(b, pw, ph);
  if (tip === null) return null;
  const cx = (b.x + b.w / 2) * pw;
  const cy = (b.y + b.h / 2) * ph;
  const dist = Math.hypot(tip[0] - cx, tip[1] - cy) || 1;
  const ux = (tip[0] - cx) / dist;
  const uy = (tip[1] - cy) / dist;
  const nx = -uy;
  const ny = ux;

  const shapes = bubbleShapes(b, pw, ph);
  const outline = shapes.length ? shapes[0] : null;

  const short = Math.min(pw, ph);
  const bw = b.w * pw;
  const bh = b.h * ph;
  // A tail's base has to scale with the balloon it hangs off. A fixed width
  // gives a big balloon a whisker and a small one a plank.
  let half = Math.max(3.0, b.tail_width * short * 0.34, Math.min(bw, bh) * 0.17);
  if (b.kind === "offscreen") half = Math.max(2.5, Math.min(half * 0.42, short * 0.012));

  const hit0 = outline ? rayHit(outline, cx, cy, ux, uy) : null;
  const edge = Math.max(hit0 ? Math.hypot(hit0[0] - cx, hit0[1] - cy) : dist, 1.0);
  const beta = Math.atan2(half, edge);
  const feet: Pt[] = [];
  for (const sgn of [1, -1]) {
    const a = Math.atan2(uy, ux) + sgn * beta;
    const rx = Math.cos(a);
    const ry = Math.sin(a);
    const hit = outline ? rayHit(outline, cx, cy, rx, ry) : null;
    const p: Pt = hit ?? [cx + rx * edge, cy + ry * edge];
    // Tuck the foot just inside so the body fill covers the tail's own outline
    // where it meets the balloon.
    const inset = Math.max(1.0, b.style.stroke_width);
    feet.push([p[0] - rx * inset, p[1] - ry * inset]);
  }

  const reach = Math.hypot(tip[0] - feet[0][0], tip[1] - feet[0][1]);
  let curve = b.tail_curve * reach * 0.16;
  curve = Math.max(-reach * 0.25, Math.min(reach * 0.25, curve));
  const a = feet[0];
  const bb = feet[1];
  const c1: Pt = [(a[0] + tip[0]) / 2 + nx * curve, (a[1] + tip[1]) / 2 + ny * curve];
  const c2: Pt = [(tip[0] + bb[0]) / 2 + nx * curve, (tip[1] + bb[1]) / 2 + ny * curve];
  return [a, ...quad(a, c1, tip, 12), ...quad(tip, c2, bb, 12)];
}

type Rect = [number, number, number, number];

/** Intersection area of two (x, y, w, h) rects. */
function overlapArea(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return ix * iy;
}

/** Monotone along the reading path: down the column, then across. */
function readingKey(r: Rect, reading: string): number {
  const cx = r[0] + r[2] / 2;
  return (r[1] + r[3] / 2) * 4.0 + (reading === "rtl" ? 1.0 - cx : cx);
}

/*
  Balloons are ovals, so boxes may graze by a hair without the ink touching;
  chasing exact zero on a fully packed panel just oscillates.
*/
const OVERLAP_TOLERANCE = 0.004;

/*
  Push overlapping balloons apart, then clamp them back into the panel. Grid
  scoring gets a good first guess; on a busy panel there is often no zero-cost
  cell left, and this turns "least bad" into "actually not touching".
*/
function resolveOverlaps(rects: Rect[], locked: boolean[], iterations = 60): Rect[] {
  const out = rects.map((r) => [...r] as [number, number, number, number]);
  const lock = locked.length ? locked : rects.map(() => false);
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        const ox = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
        const oy = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
        if (ox <= OVERLAP_TOLERANCE || oy <= OVERLAP_TOLERANCE) continue;
        moved = true;
        // Separate along the shallower axis — the smaller correction.
        const acx = a[0] + a[2] / 2;
        const acy = a[1] + a[3] / 2;
        const bcx = b[0] + b[2] / 2;
        const bcy = b[1] + b[3] / 2;
        if (oy <= ox) {
          const push = (oy + 0.006) / 2;
          const s = acy < bcy ? 1.0 : -1.0;
          if (!lock[i]) a[1] -= push * s;
          if (!lock[j]) b[1] += push * s;
          if (lock[i] && !lock[j]) b[1] += push * s;
          if (lock[j] && !lock[i]) a[1] -= push * s;
        } else {
          const push = (ox + 0.006) / 2;
          const s = acx < bcx ? 1.0 : -1.0;
          if (!lock[i]) a[0] -= push * s;
          if (!lock[j]) b[0] += push * s;
        }
      }
    }
    out.forEach((r, i) => {
      if (lock[i]) return;
      r[0] = Math.max(0.01, Math.min(0.99 - r[2], r[0]));
      r[1] = Math.max(0.01, Math.min(0.99 - r[3], r[1]));
    });
    if (!moved) break;
  }
  return out.map((r) => [r[0], r[1], r[2], r[3]] as Rect);
}

/*
  Where auto_layout's final pass will put this balloon's tail tip.

  This deliberately mirrors that pass rather than sharing code with it, and the
  reason is the bug it fixes: tails are assigned AFTER every balloon has been
  placed, so at placement time no tail exists and the cost function cannot
  avoid one. A later balloon could therefore be parked squarely on an earlier
  balloon's tail — which is what the engine did the first time it was run on
  real art, with 128 unit tests passing.
*/
function predictedTail(
  rect: Rect,
  kind: BubbleKind,
  speaker: CharacterInPanel | null,
  linkTo: string | null,
): Pt | null {
  if (linkTo) return null;
  if (NO_TAIL_KINDS.has(kind) && kind !== "thought") return null;
  const cx = rect[0] + rect[2] / 2;
  const cy = rect[1] + rect[3] / 2;
  if (kind === "offscreen") {
    if (Math.min(cx, 1 - cx) <= Math.min(cy, 1 - cy))
      return [cx < 0.5 ? 0.01 : 0.99, Math.min(0.99, cy + 0.06)];
    return [cx, cy < 0.5 ? 0.01 : 0.99];
  }
  if (speaker)
    return [
      Math.min(0.99, Math.max(0.01, speaker.screen_x)),
      Math.min(0.99, Math.max(0.01, speaker.screen_y - 0.04)),
    ];
  return [Math.min(0.97, Math.max(0.03, cx)), Math.min(0.97, rect[1] + rect[3] + 0.12)];
}

/** Bounding box of the area a tail sweeps. A box, not the triangle: it errs
 *  toward keeping neighbours clear, which is the desired bias here. */
function tailCorridor(rect: Rect, tip: Pt | null, tailWidth = 0.06): Rect | null {
  if (tip === null) return null;
  const cx = rect[0] + rect[2] / 2;
  const baseY = rect[1] + rect[3];
  const x0 = Math.min(cx - tailWidth / 2, tip[0]);
  const x1 = Math.max(cx + tailWidth / 2, tip[0]);
  const y0 = Math.min(baseY, tip[1]);
  const y1 = Math.max(baseY, tip[1]);
  return [x0, y0, Math.max(1e-6, x1 - x0), Math.max(1e-6, y1 - y0)];
}

type PlacementTrace = {
  id: string;
  faceCost: number;
  balloonCost: number;
  corridorCost: number;
  preferenceCost: number;
  total: number;
};

/*
  auto_layout — re-flow bubbles: size them to their text and keep them off the
  faces. With no rendered art to detect faces in, it falls back to staging
  hints: a head is roughly a sixth of the frame above the character's anchor
  point. That is the branch running here, because nothing has been drawn yet —
  which is the whole point of the stage.
*/
function autoLayout(
  panel: Panel,
  reading: "ltr" | "rtl",
): { faces: Rect[]; trace: PlacementTrace[] } {
  const faces: Rect[] = [];
  for (const c of panel.characters) {
    if (c.visible) faces.push([c.screen_x - 0.09, Math.max(0, c.screen_y - 0.26), 0.18, 0.22]);
  }

  const ordered = [...panel.bubbles].sort((a, b) => a.order - b.order);
  const placed: Rect[] = [];
  const corridors: Rect[] = [];
  const trace: PlacementTrace[] = [];
  let prevKey = -1e9;

  ordered.forEach((b, i) => {
    b.order = i;
    if (b.locked) {
      placed.push([b.x, b.y, b.w, b.h]);
      prevKey = Math.max(prevKey, readingKey(placed[placed.length - 1], reading));
      return;
    }

    const [w, h] = estimateBubbleSize(b.text, b.style, panel.width, panel.height, b.kind);
    b.w = w;
    b.h = h;

    const speaker =
      panel.characters.find((c) => c.character_id === b.speaker_id && c.visible) ?? null;

    let best: { cost: number; x: number; y: number; parts: number[] } | null = null;
    const step = 0.05;
    const coords = Array.from({ length: Math.trunc(0.97 / step) }, (_, k) =>
      round(0.015 + k * step, 4),
    );
    for (const y of coords) {
      if (y + h > 0.985) continue;
      for (const x of coords) {
        if (x + w > 0.985) continue;
        const rect: Rect = [x, y, w, h];
        let faceCost = 0;
        let balloonCost = 0;
        let corridorCost = 0;
        let prefCost = 0;

        // Never cover a face. Scaled by how much of the face is buried, so
        // grazing an ear is cheap and sitting on the eyes is not.
        for (const f of faces) {
          const ov = overlapArea(rect, f);
          if (ov > 0) faceCost += (240.0 * ov) / Math.max(1e-6, f[2] * f[3]);
        }
        for (const p of placed) balloonCost += (160.0 * overlapArea(rect, p)) / Math.max(1e-6, w * h);
        // ...nor another balloon's TAIL. Weighted below a balloon body because
        // a clipped tail is less destructive than buried text, but well above
        // the layout preferences: a tail that vanishes under a caption takes
        // the line's speaker with it.
        for (const c of corridors)
          corridorCost += (110.0 * overlapArea(rect, c)) / Math.max(1e-6, w * h);

        if (b.kind === "narration" || b.kind === "caption") {
          // Captions belong at the frame's edge, out of the staging.
          prefCost += 6.0 * Math.min(y, 1.0 - (y + h)) + 3.0 * Math.abs(x + w / 2 - 0.5);
        } else if (speaker) {
          const bcx = x + w / 2;
          const bcy = y + h / 2;
          prefCost += 10.0 * Math.hypot(bcx - speaker.screen_x, bcy - (speaker.screen_y - 0.24));
          if (bcy > speaker.screen_y) prefCost += 3.0; // below the head reads as an afterthought
        } else {
          prefCost += Math.abs(x + w / 2 - 0.5) * 0.8;
        }
        // Reading order: this balloon must come after the last one.
        const key = readingKey(rect, reading);
        if (key < prevKey) prefCost += 14.0 * (prevKey - key);
        prefCost += y * 1.6;
        // Hug the frame edge on the reading-entry side.
        prefCost += (reading === "ltr" ? x : 1.0 - (x + w)) * 0.9;

        const cost = faceCost + balloonCost + corridorCost + prefCost;
        if (best === null || cost < best.cost)
          best = { cost, x, y, parts: [faceCost, balloonCost, corridorCost, prefCost] };
      }
    }
    if (best) {
      b.x = best.x;
      b.y = best.y;
      trace.push({
        id: b.id,
        faceCost: best.parts[0],
        balloonCost: best.parts[1],
        corridorCost: best.parts[2],
        preferenceCost: best.parts[3],
        total: best.cost,
      });
    }
    placed.push([b.x, b.y, b.w, b.h]);
    const corridor = tailCorridor(
      placed[placed.length - 1],
      predictedTail(placed[placed.length - 1], b.kind, speaker, b.link_to),
      b.tail_width,
    );
    if (corridor) corridors.push(corridor);
    prevKey = Math.max(prevKey, readingKey(placed[placed.length - 1], reading));
  });

  // Relaxation pass — the grid can only ever pick the least-bad cell.
  const fixed = resolveOverlaps(placed, ordered.map((b) => b.locked));
  ordered.forEach((b, i) => {
    if (!b.locked) {
      b.x = round(fixed[i][0], 4);
      b.y = round(fixed[i][1], 4);
    }
  });

  for (const b of ordered) {
    const speaker =
      panel.characters.find((c) => c.character_id === b.speaker_id && c.visible) ?? null;
    if (NO_TAIL_KINDS.has(b.kind) && b.kind !== "thought") {
      b.tail_x = null;
      b.tail_y = null;
    } else if (b.link_to) {
      b.tail_x = null;
      b.tail_y = null;
    } else if (b.kind === "offscreen") {
      // Point off the nearest edge, so the reader knows the speaker is outside
      // the frame rather than merely somewhere unhelpful.
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      if (Math.min(cx, 1 - cx) <= Math.min(cy, 1 - cy)) {
        b.tail_x = cx < 0.5 ? 0.01 : 0.99;
        b.tail_y = round(cy + 0.06, 4);
      } else {
        b.tail_x = round(cx, 4);
        b.tail_y = cy < 0.5 ? 0.01 : 0.99;
      }
    } else if (speaker) {
      b.tail_x = round(Math.min(0.99, Math.max(0.01, speaker.screen_x)), 4);
      b.tail_y = round(Math.min(0.99, Math.max(0.01, speaker.screen_y - 0.04)), 4);
    } else {
      b.tail_x = round(Math.min(0.97, Math.max(0.03, b.x + b.w / 2)), 4);
      b.tail_y = round(Math.min(0.97, b.y + b.h + 0.12), 4);
    }
  }

  return { faces, trace };
}

// ==========================================================================
// export.py — the webtoon strip
// ==========================================================================

/** Most webtoon platforms cap a single uploaded image around 2000px tall. */
const SLICE_HEIGHT = 1800;

type StripEntry = { panel: Panel; top: number };
type Strip = { width: number; height: number; entries: StripEntry[]; slices: number };

/** build_strip + export_webtoon: one tall image, sliced into upload-sized tiles. */
function buildStrip(panels: Panel[]): Strip {
  const gutter = CANVAS.gutter;
  const width = CANVAS.width;
  const totalH =
    panels.reduce((a, p) => a + p.height, 0) + gutter * (panels.length + 1);
  const entries: StripEntry[] = [];
  let y = gutter;
  for (const p of panels) {
    entries.push({ panel: p, top: y });
    y += p.height + gutter;
  }
  return {
    width,
    height: totalH,
    entries,
    slices: Math.max(1, Math.ceil(totalH / SLICE_HEIGHT)),
  };
}

// ==========================================================================
// Pipeline assembly — the order the app actually runs these in
// ==========================================================================

type Built = {
  scenes: Scene[];
  staging: Map<string, Staging>;
  layout: Map<string, { faces: Rect[]; trace: PlacementTrace[] }>;
};

function buildPipeline(
  storyline: string,
  targetScenes: number,
  targetPanels: number,
  reading: "ltr" | "rtl",
  fontSize: number,
): Built {
  const scenes = buildScenes(storyline, targetScenes);
  const staging = new Map<string, Staging>();
  const layout = new Map<string, { faces: Rect[]; trace: PlacementTrace[] }>();

  for (const scene of scenes) {
    scene.panels = buildPanels(scene, targetPanels);
    scene.character_ids = [
      ...new Set(scene.panels.flatMap((p) => p.characters.map((c) => c.character_id))),
    ];
    for (const panel of scene.panels) {
      /*
        The author's own type size, applied the way the editor applies it: the
        balloon is created with `default_style_for_kind()` and then this field
        is edited on top. It is the input the whole fitter keys off — the
        schema default of 15.0 is small against a 1280px canvas, which is the
        one number here worth turning to see the rest of the machinery work.
      */
      for (const b of panel.bubbles) {
        b.style.font_size = fontSize;
        b.style.font_size_max = Math.max(b.style.font_size_max, fontSize);
      }
      // Staging runs first here on purpose. It rewrites screen_x/screen_y by
      // projecting each figure through the derived camera, and the letterer
      // reads those — which is what makes a balloon follow a figure you moved
      // in the viewport instead of pointing where they used to be.
      staging.set(panel.id, resolveStaging(panel, scene));
      layout.set(panel.id, autoLayout(panel, reading));
    }
  }
  return { scenes, staging, layout };
}

// ==========================================================================
// Presentation
// ==========================================================================

const STAGES = [
  { key: "storyline", label: "storyline", src: "models.Project.storyline" },
  { key: "scenes", label: "scenes", src: "director.build_scenes" },
  { key: "panels", label: "panels", src: "director.build_panels" },
  { key: "blockout", label: "3D blockout", src: "blender_bridge.resolve_staging" },
  { key: "prompt", label: "ComfyUI graph", src: "prompt_builder + comfy.build_workflow" },
  { key: "lettering", label: "lettering", src: "lettering.auto_layout" },
  { key: "export", label: "webtoon export", src: "export.export_webtoon" },
] as const;

/** JSON with floats rounded, so the artefact reads like a record and not noise. */
function jsonText(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v: unknown) =>
      typeof v === "number" && !Number.isInteger(v) ? round(v, 4) : (v as unknown),
    2,
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <div className="mt-2 overflow-x-auto rounded-sm border border-hair-soft bg-sunken">
      <pre className="min-w-max px-3 py-2 font-mono text-[11px] leading-[1.6] text-body">
        {jsonText(value)}
      </pre>
    </div>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 max-w-[64ch] text-sm text-muted">{children}</p>;
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mt-5 font-mono text-xs text-faint">{children}</p>;
}

const polyPoints = (pts: Pt[]): string =>
  pts.map(([x, y]) => `${round(x, 2)},${round(y, 2)}`).join(" ");

/*
  Balloon fitting measures glyphs, which needs a canvas — so the pipeline can
  only run in the browser. This reports false while the static export is being
  prerendered and true once hydrated, which keeps the server HTML and the first
  client render identical without a setState-in-effect.
*/
const neverChanges = () => () => {};
const useHydrated = (): boolean =>
  useSyncExternalStore(
    neverChanges,
    () => true,
    () => false,
  );

export function PipelineStepper() {
  const [storyline, setStoryline] = useState(DEFAULT_STORYLINE);
  const [stage, setStage] = useState(0);
  const [sceneIdx, setSceneIdx] = useState(0);
  const [panelIdx, setPanelIdx] = useState(0);
  const [reading, setReading] = useState<"ltr" | "rtl">("ltr");
  const [controlnets, setControlnets] = useState(false);
  const [fontSize, setFontSize] = useState(28);
  const mounted = useHydrated();

  const built = useMemo(
    () => (mounted ? buildPipeline(storyline, 6, 8, reading, fontSize) : null),
    [mounted, storyline, reading, fontSize],
  );

  // Editing the storyline can leave a selection pointing past the end.
  const sIdx = built ? Math.min(sceneIdx, built.scenes.length - 1) : -1;
  const scene = built?.scenes[sIdx] ?? null;
  const pIdx = scene ? Math.min(panelIdx, scene.panels.length - 1) : -1;
  const panel = scene?.panels[pIdx] ?? null;
  const staging = panel ? built?.staging.get(panel.id) ?? null : null;
  const placement = panel ? built?.layout.get(panel.id) ?? null : null;

  const derived = useMemo(() => {
    if (!panel || !scene) return null;
    const { positive, negative, plan, background } = derivePrompt(panel, scene, STYLE);
    const req = buildRequest(panel, positive, negative, controlnets);
    return { positive, negative, plan, background, req, graph: buildWorkflow(req) };
  }, [panel, scene, controlnets]);

  const strip = useMemo(
    () => (built ? buildStrip(built.scenes.flatMap((s) => s.panels)) : null),
    [built],
  );

  const goto = (n: number) => setStage(Math.max(0, Math.min(STAGES.length - 1, n)));

  return (
    <section className="mt-10 rounded border border-hair bg-raised">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hair px-4 py-3">
        <h2 className="font-prose text-base font-semibold text-bright">
          Storyline to lettered chapter — steppable
        </h2>
        <p className="font-mono text-xs text-dim">ported from backend/app/services/*.py</p>
      </header>

      <div className="px-4 py-4">
        <p className="max-w-[64ch] text-sm text-muted">
          Manhwa Studio turns prose into a lettered vertical-scroll chapter without
          leaving the machine. No art is generated here — what advances stage by
          stage is the <span className="text-body">data</span>: the scene and panel
          schemas, the Blender-space blockout, the ComfyUI graph, and the balloon
          geometry the letterer solves for. Every number below is computed by code
          transcribed from the repo.
        </p>

        {/* stage rail */}
        <nav className="mt-4 overflow-x-auto">
          <ol className="flex min-w-max items-stretch gap-1">
            {STAGES.map((s, i) => (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() => goto(i)}
                  aria-current={i === stage ? "step" : undefined}
                  className={`rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors ${
                    i === stage
                      ? "border-accent text-accent"
                      : i < stage
                        ? "border-hair text-body hover:border-muted"
                        : "border-hair-soft text-dim hover:border-muted hover:text-body"
                  }`}
                >
                  <span className="tabular-nums">{i + 1}</span> {s.label}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => goto(stage - 1)}
            disabled={stage === 0}
            className="rounded-sm border border-hair px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:border-muted hover:text-body disabled:opacity-40"
          >
            back
          </button>
          <button
            type="button"
            onClick={() => goto(stage + 1)}
            disabled={stage === STAGES.length - 1}
            className="rounded-sm border border-accent px-2.5 py-1 font-mono text-xs text-accent transition-colors hover:brightness-125 disabled:opacity-40"
          >
            advance →
          </button>
          <span className="ml-auto font-mono text-xs text-faint">{STAGES[stage].src}</span>
        </div>

        {/* scene / panel selector, once there is something to select */}
        {stage >= 1 && built && built.scenes.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hair-soft pt-3">
            <span className="font-mono text-xs text-faint">scene</span>
            <div className="flex flex-wrap gap-1">
              {built.scenes.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setSceneIdx(i);
                    setPanelIdx(0);
                  }}
                  aria-pressed={i === sIdx}
                  className={`rounded-sm border px-2 py-0.5 font-mono text-xs tabular-nums transition-colors ${
                    i === sIdx
                      ? "border-accent text-accent"
                      : "border-hair text-dim hover:border-muted hover:text-body"
                  }`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
            {stage >= 2 && scene && (
              <>
                <span className="font-mono text-xs text-faint">panel</span>
                <div className="flex flex-wrap gap-1">
                  {scene.panels.map((p, i) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPanelIdx(i)}
                      aria-pressed={i === pIdx}
                      className={`rounded-sm border px-2 py-0.5 font-mono text-xs tabular-nums transition-colors ${
                        i === pIdx
                          ? "border-accent text-accent"
                          : "border-hair text-dim hover:border-muted hover:text-body"
                      }`}
                    >
                      {i + 1}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {!mounted && (
          <p className="mt-6 font-mono text-xs text-faint">measuring glyphs…</p>
        )}

        {mounted && built && built.scenes.length === 0 && stage > 0 && (
          <p className="mt-6 font-mono text-xs text-warning">
            the storyline is empty, so the breakdown produced no scenes — the route
            rejects this with a 400 before the director ever runs
          </p>
        )}

        {mounted && built && (
          <div className="mt-5">
            {stage === 0 && (
              <StageStoryline storyline={storyline} onChange={setStoryline} />
            )}
            {stage === 1 && <StageScenes scenes={built.scenes} scene={scene} />}
            {stage === 2 && <StagePanels scene={scene} panel={panel} />}
            {stage === 3 && <StageBlockout panel={panel} staging={staging} />}
            {stage === 4 && (
              <StagePrompt
                panel={panel}
                derived={derived}
                controlnets={controlnets}
                setControlnets={setControlnets}
              />
            )}
            {stage === 5 && (
              <StageLettering
                panel={panel}
                placement={placement}
                reading={reading}
                setReading={setReading}
                fontSize={fontSize}
                setFontSize={setFontSize}
              />
            )}
            {stage === 6 && <StageExport strip={strip} />}
          </div>
        )}
      </div>
    </section>
  );
}

// -------------------------------------------------------------------------- stage 1

function StageStoryline({
  storyline,
  onChange,
}: {
  storyline: string;
  onChange: (v: string) => void;
}) {
  const paras = storyline.split(/\n\s*\n/).filter((p) => p.trim()).length;
  return (
    <div>
      <Caption>
        The raw field the director reads, blank-line separated. It is the only
        thing on this page I wrote — the projects on disk have empty{" "}
        <span className="font-mono text-xs text-body">storyline</span> fields, so
        there was no authored sample to lift. Edit it and every number downstream
        moves; the cue tables are keyword matches, so a word like{" "}
        <span className="font-mono text-xs text-body">rooftop</span>,{" "}
        <span className="font-mono text-xs text-body">dusk</span> or{" "}
        <span className="font-mono text-xs text-body">cigarette</span> is load-bearing.
      </Caption>
      <label className="sr-only" htmlFor="ms-storyline">
        Storyline
      </label>
      <textarea
        id="ms-storyline"
        value={storyline}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        spellCheck={false}
        className="mt-3 w-full resize-y rounded-sm border border-hair bg-sunken px-3 py-2 font-mono text-[12px] leading-[1.7] text-body focus:border-accent"
      />
      <p className="mt-2 font-mono text-xs text-faint tabular-nums">
        {storyline.length} chars · {paras} paragraph{paras === 1 ? "" : "s"} ·
        target_scenes=6 · target_panels=8 (the route defaults)
      </p>
      <Label>cast on this project — projects/prj_fedb603e54/project.json</Label>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {CHARACTERS.map((c) => (
          <div key={c.id} className="rounded-sm border border-hair-soft bg-sunken px-3 py-2">
            <p className="font-mono text-xs text-body">
              {c.name} <span className="text-faint">{c.id}</span>
            </p>
            <p className="mt-1 font-mono text-[11px] leading-[1.6] text-dim">
              {characterFragment(c, c.default_outfit_id)}
            </p>
            <p className="mt-1 font-mono text-[11px] text-faint tabular-nums">
              identity_seed {c.identity_seed} · presentation {c.presentation}
            </p>
          </div>
        ))}
      </div>
      <Label>style pack — styles.builtin_styles()[0]</Label>
      <p className="mt-2 font-mono text-[11px] text-dim">
        {STYLE.name} · {STYLE.color_mode} · lettering_font {STYLE.lettering_font}
      </p>
    </div>
  );
}

// -------------------------------------------------------------------------- stage 2

function StageScenes({ scenes, scene }: { scenes: Scene[]; scene: Scene | null }) {
  return (
    <div>
      <Caption>
        The offline breakdown splits on blank lines, distributes paragraphs evenly
        across the target, then reads setting, time and mood off keyword tables.
        Crude next to a model pass, and the route says so in as many words — but
        it produces a real editable board instead of stubs. Settings and times
        carry forward when a paragraph names none, which is why scenes 2 and 3
        inherit the rooftop.
      </Caption>
      <Label>Chapter.scenes — {scenes.length} scenes</Label>
      <div className="mt-2 flex flex-col gap-1">
        {scenes.map((s) => (
          <div
            key={s.id}
            className={`rounded-sm border px-3 py-2 ${
              s.id === scene?.id ? "border-accent bg-sunken" : "border-hair-soft"
            }`}
          >
            <p className="font-mono text-xs text-body">
              <span className="text-faint tabular-nums">{s.index}</span> {s.title}
            </p>
            <p className="mt-1 font-mono text-[11px] text-dim">
              setting <span className="text-body">{s.setting || "—"}</span> · time{" "}
              <span className="text-body">{s.time_of_day}</span> · mood{" "}
              <span className="text-body">{s.mood || "—"}</span> ·{" "}
              <span className="tabular-nums">{s.beats.length}</span> beats
            </p>
          </div>
        ))}
      </div>
      {scene && (
        <>
          <Label>the selected scene, as stored</Label>
          <Json
            value={{
              id: scene.id,
              index: scene.index,
              title: scene.title,
              summary: scene.summary,
              setting: scene.setting,
              time_of_day: scene.time_of_day,
              mood: scene.mood,
              character_ids: scene.character_ids,
              beats: scene.beats,
              panels: `[${scene.panels.length} panels]`,
              style_id: null,
              layout: null,
            }}
          />
        </>
      )}
    </div>
  );
}

// -------------------------------------------------------------------------- stage 3

function StagePanels({ scene, panel }: { scene: Scene | null; panel: Panel | null }) {
  if (!scene || !panel) return null;
  return (
    <div>
      <Caption>
        One panel per beat, on a repeating shot rhythm that reads in vertical
        scroll — orient, play, land. Quoted text becomes speech balloons attributed
        to whoever is named in the beat; everything else becomes the description. A
        beat carrying dialogue is pulled off an establishing or wide shot, because
        a line implies a face. The float in the rhythm table is the panel&rsquo;s
        share of the scroll: a webtoon panel&rsquo;s width is fixed by the canvas
        and only its height varies.
      </Caption>
      <Label>shot rhythm applied down the scene</Label>
      <div className="mt-2 overflow-x-auto">
        <table className="min-w-max font-mono text-[11px]">
          <thead>
            <tr className="text-faint">
              <th className="px-2 py-1 text-left font-normal">#</th>
              <th className="px-2 py-1 text-left font-normal">shot</th>
              <th className="px-2 py-1 text-right font-normal">focal</th>
              <th className="px-2 py-1 text-right font-normal">h px</th>
              <th className="px-2 py-1 text-right font-normal">cast</th>
              <th className="px-2 py-1 text-right font-normal">balloons</th>
            </tr>
          </thead>
          <tbody>
            {scene.panels.map((p) => (
              <tr
                key={p.id}
                className={p.id === panel.id ? "text-accent" : "text-dim"}
              >
                <td className="px-2 py-1 tabular-nums">{p.index}</td>
                <td className="px-2 py-1">{p.shot.type}</td>
                <td className="px-2 py-1 text-right tabular-nums">{p.shot.focal_length}mm</td>
                <td className="px-2 py-1 text-right tabular-nums">{p.height}</td>
                <td className="px-2 py-1 text-right tabular-nums">{p.characters.length}</td>
                <td className="px-2 py-1 text-right tabular-nums">{p.bubbles.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Label>models.Panel — the selected panel, before staging or lettering</Label>
      <Json
        value={{
          id: panel.id,
          index: panel.index,
          beat: panel.beat,
          description: panel.description,
          shot: panel.shot,
          characters: panel.characters,
          time_of_day: panel.time_of_day,
          width: panel.width,
          height: panel.height,
          bubbles: panel.bubbles.map((b) => ({
            id: b.id,
            kind: b.kind,
            text: b.text,
            speaker_id: b.speaker_id,
            x: b.x, y: b.y, w: b.w, h: b.h,
            tail_x: b.tail_x, tail_y: b.tail_y,
            order: b.order,
          })),
          fx: panel.fx,
        }}
      />
      <Caption>
        Those balloon coordinates are the director&rsquo;s rough seed — stack down
        the upper-left, alternate sides. The letterer replaces them outright two
        stages from here.
      </Caption>
    </div>
  );
}

// -------------------------------------------------------------------------- stage 4

function StageBlockout({ panel, staging }: { panel: Panel | null; staging: Staging | null }) {
  if (!panel || !staging) return null;
  const cam = staging.camera;
  const figs = staging.figures.filter((f) => f.cip.visible);

  // Plan view: +X right, +Y away from camera. Screen y is flipped so "away"
  // reads as "up the page", the way a floor plan does.
  const pts: [number, number][] = [
    ...figs.map((f) => [f.transform.x, f.transform.y] as [number, number]),
    [cam.x, cam.y],
    [cam.target_x, cam.target_y],
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const pad = 1.2;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad;
  const maxY = Math.max(...ys) + pad;
  const spanX = Math.max(maxX - minX, 0.001);
  const spanY = Math.max(maxY - minY, 0.001);
  const W = 520;
  const H = 300;
  const k = Math.min(W / spanX, H / spanY);
  const ox = (W - spanX * k) / 2;
  const oy = (H - spanY * k) / 2;
  const px = (x: number) => ox + (x - minX) * k;
  const py = (y: number) => oy + (maxY - y) * k;

  const hfovDeg =
    (Math.atan(Math.tan((staging.fov_v * Math.PI) / 180 / 2) * staging.aspect) * 2 * 180) /
    Math.PI;
  const aim = Math.atan2(cam.target_y - cam.y, cam.target_x - cam.x);
  const half = (hfovDeg * Math.PI) / 180 / 2;
  const reach = staging.distance * 1.5 * k;
  const wedge = [
    [px(cam.x), py(cam.y)],
    [px(cam.x) + Math.cos(aim - half) * reach, py(cam.y) - Math.sin(aim - half) * reach],
    [px(cam.x) + Math.cos(aim + half) * reach, py(cam.y) - Math.sin(aim + half) * reach],
  ] as Pt[];

  return (
    <div>
      <Caption>
        Right-handed, Z-up, metres. +X screen right, +Y away from the default
        camera into the set, +Z up; a figure&rsquo;s origin sits between its feet.
        Nothing here needs Blender running — the shot-coverage, aim-height and
        pitch tables are mirrored out of the addon into Python so the backend can
        answer with Blender closed, and a test parses the addon source to assert
        the copies have not drifted.
      </Caption>

      <Label>plan view · {staging.set} set · aspect {staging.aspect}</Label>
      <div className="mt-2 overflow-x-auto rounded-sm border border-hair-soft bg-sunken">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full min-w-[420px]"
          role="img"
          aria-label="Top-down plan of the panel's 3D staging"
        >
          {Array.from({ length: Math.ceil(spanX) + 1 }, (_, i) => {
            const x = Math.ceil(minX) + i;
            return (
              <line
                key={`gx${i}`} x1={px(x)} y1={0} x2={px(x)} y2={H}
                stroke="#161c23" strokeWidth={1}
              />
            );
          })}
          {Array.from({ length: Math.ceil(spanY) + 1 }, (_, i) => {
            const y = Math.ceil(minY) + i;
            return (
              <line
                key={`gy${i}`} x1={0} y1={py(y)} x2={W} y2={py(y)}
                stroke="#161c23" strokeWidth={1}
              />
            );
          })}
          <polygon points={polyPoints(wedge)} fill="#5fc98d" fillOpacity={0.07} />
          <line
            x1={px(cam.x)} y1={py(cam.y)} x2={px(cam.target_x)} y2={py(cam.target_y)}
            stroke="#5fc98d" strokeWidth={1} strokeDasharray="4 4"
          />
          <circle cx={px(cam.target_x)} cy={py(cam.target_y)} r={3} fill="#5fc98d" />
          <circle cx={px(cam.x)} cy={py(cam.y)} r={5} fill="#5fc98d" />
          <text
            x={px(cam.x) + 9} y={py(cam.y) + 4}
            fill="#5fc98d" fontSize={11} fontFamily="ui-monospace, monospace"
          >
            cam {round(cam.focal_length, 0)}mm
          </text>
          {figs.map((f) => {
            const fx = px(f.transform.x);
            const fy = py(f.transform.y);
            // A figure at yaw 0 faces -Y, so forward is (sin yaw, -cos yaw).
            const yaw = (f.transform.yaw * Math.PI) / 180;
            const fwd: [number, number] = [Math.sin(yaw), -Math.cos(yaw)];
            return (
              <g key={f.cip.character_id}>
                <circle cx={fx} cy={fy} r={7} fill="none" stroke="#c7ced6" strokeWidth={1.5} />
                <line
                  x1={fx} y1={fy}
                  x2={fx + fwd[0] * 18} y2={fy - fwd[1] * 18}
                  stroke="#c7ced6" strokeWidth={1.5}
                />
                <text
                  x={fx + 11} y={fy - 9}
                  fill="#c7ced6" fontSize={11} fontFamily="ui-monospace, monospace"
                >
                  {f.name}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="mt-2 font-mono text-[11px] text-faint tabular-nums">
        coverage {SHOT_COVERAGE[panel.shot.type] ?? 1.25}m · vfov{" "}
        {round(staging.fov_v, 2)}° · distance {round(staging.distance, 3)}m (floor 0.6) ·
        azimuth {azimuthFor(panel)}°
      </p>

      <Label>resolve_staging() — figures</Label>
      <Json
        value={staging.figures.map((f) => ({
          name: f.name,
          derived: f.derived,
          transform: f.transform,
          height_m: f.height_m,
          pose: f.pose,
          screen_x: f.cip.screen_x,
          screen_y: f.cip.screen_y,
        }))}
      />
      <Label>derive_camera() — position + look-at, never orbit</Label>
      <Json value={{ ...cam, derived: staging.camera_derived }} />
      <Caption>
        Stored as position plus target rather than yaw/pitch/distance for three
        reasons, in order of what they cost to get wrong: three.js drives a camera
        that way already, Blender computes a position and then look-ats, and orbit
        degenerates — a POV or extreme close-up drives distance toward zero, where
        yaw and pitch stop being defined.{" "}
        {staging.moved > 0 ? (
          <>
            Projecting the figures back through this camera moved{" "}
            <span className="tabular-nums text-body">{staging.moved}</span> screen
            anchor{staging.moved === 1 ? "" : "s"}, and the letterer reads those —
            so the balloons in the next stage follow the staging, not the
            director&rsquo;s guess.
          </>
        ) : (
          <>The projection left the screen anchors where they were.</>
        )}
      </Caption>
    </div>
  );
}

// -------------------------------------------------------------------------- stage 5

type Derived = {
  positive: string;
  negative: string;
  plan: PosePlan;
  background: boolean;
  req: RenderRequest;
  graph: Record<string, GraphNode>;
};

function StagePrompt({
  panel,
  derived,
  controlnets,
  setControlnets,
}: {
  panel: Panel | null;
  derived: Derived | null;
  controlnets: boolean;
  setControlnets: (v: boolean) => void;
}) {
  if (!panel || !derived) return null;
  const { req } = derived;
  const stages: [string, string | null, number, number][] = [
    ["depth", req.depth_image, req.depth_strength, req.depth_end],
    ["lineart", req.lineart_image, req.lineart_strength, req.lineart_end],
    ["pose", req.pose_image, req.pose_strength, req.pose_end],
  ];

  return (
    <div>
      <Caption>
        Ordering matters more than wording on danbooru-captioned checkpoints:
        their training captions run subject → details → quality, so that is the
        order. Leading with the style block instead buried the subject about forty
        tokens deep behind phrases like &ldquo;beautiful detailed eyes&rdquo; —
        themselves female-coded in that tag space — and a male lead rendered as a
        dark-haired woman with <span className="font-mono text-xs">1boy</span>{" "}
        present.
      </Caption>

      <Label>
        positive — {derived.positive.split(",").length} comma tokens
        {derived.background ? " · background panel (figure tokens stripped)" : ""}
      </Label>
      <div className="mt-2 overflow-x-auto rounded-sm border border-hair-soft bg-sunken">
        <p className="px-3 py-2 font-mono text-[11px] leading-[1.75] text-body">
          {derived.positive}
        </p>
      </div>

      <Label>negative — {derived.negative.split(",").length} of a 64-token budget</Label>
      <div className="mt-2 overflow-x-auto rounded-sm border border-hair-soft bg-sunken">
        <p className="px-3 py-2 font-mono text-[11px] leading-[1.75] text-dim">
          {derived.negative}
        </p>
      </div>
      <Caption>
        The cap is not tidiness. The negative once reached 107 entries — longer
        than the positive — once the style pack&rsquo;s own negatives, the machine
        tells, the anatomy list, the sheet list and the pose plan were all
        concatenated, and renders collapsed: a two-character kiss came back as five
        pictograms. Groups carry their own caps as well, because pure
        first-come priority starved everything below it.
      </Caption>

      <Label>pose plan — poses.plan_panel({panel.characters.length} figures)</Label>
      <p className="mt-2 font-mono text-[11px] leading-[1.7] text-dim">
        resolved{" "}
        <span className="text-body">
          {derived.plan.used.length ? derived.plan.used.join(", ") : "nothing — falls back to contrapposto"}
        </span>{" "}
        · hands_visible{" "}
        <span className="text-body">{String(derived.plan.hands_visible)}</span>
      </p>

      <Label>conditioning weights for a {panel.shot.type} shot</Label>
      <div className="mt-2 overflow-x-auto">
        <table className="min-w-max font-mono text-[11px]">
          <thead>
            <tr className="text-faint">
              <th className="px-2 py-1 text-left font-normal">stage</th>
              <th className="px-2 py-1 text-right font-normal">scale</th>
              <th className="px-2 py-1 text-right font-normal">strength</th>
              <th className="px-2 py-1 text-right font-normal">ends at</th>
              <th className="px-2 py-1 text-left font-normal">in graph?</th>
            </tr>
          </thead>
          <tbody>
            {stages.map(([name, image, strength, end]) => {
              const live = Boolean(image) && strength > 0;
              return (
                <tr key={name} className={live ? "text-body" : "text-dim"}>
                  <td className="px-2 py-1">{name}</td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {name === "pose"
                      ? round(poseScale(panel), 2)
                      : round(controlScale(panel), 2)}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{round(strength, 4)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{round(end, 3)}</td>
                  <td className="px-2 py-1">
                    {live ? (
                      <span className="text-accent">yes</span>
                    ) : (
                      <span className="text-faint">
                        {!image ? "no image / model" : "strength 0"}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Caption>
        Depth is capped at <span className="font-mono text-xs">0.35</span> and
        scaled down as the shot tightens; pose is close to its inverse on purpose,
        because a skeleton is most useful exactly where the depth pass is least
        trustworthy. Blender lineart is only used on a panel with no figure in it
        — the Freestyle pass traces the mannequin&rsquo;s box edges exactly, and a
        lineart ControlNet follows contours far more literally than depth follows
        volume, so it reproduced the proxy: a box-limbed dummy with a face.
      </Caption>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setControlnets(!controlnets)}
          aria-pressed={controlnets}
          className={`rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors ${
            controlnets
              ? "border-accent text-accent"
              : "border-hair text-dim hover:border-muted hover:text-body"
          }`}
        >
          ControlNets installed: {controlnets ? "on" : "off"}
        </button>
        <span className="max-w-[46ch] font-mono text-[11px] leading-[1.6] text-faint">
          settings.json on this install has all three null — auto_models found no
          matching model — so the real graph skips all three stages. Toggling on
          shows the other shape with placeholder model names.
        </span>
      </div>

      <Label>
        comfy.build_workflow() — {Object.keys(derived.graph).length} nodes, ComfyUI
        API format
      </Label>
      <Json value={derived.graph} />
      <p className="mt-2 font-mono text-[11px] text-faint tabular-nums">
        seed {req.seed} (identity seeds XORed, + index × 7919) · {req.width}×
        {req.height} · {req.steps} steps · cfg {req.cfg} · {req.checkpoint}
      </p>
    </div>
  );
}

// -------------------------------------------------------------------------- stage 6

function StageLettering({
  panel,
  placement,
  reading,
  setReading,
  fontSize,
  setFontSize,
}: {
  panel: Panel | null;
  placement: { faces: Rect[]; trace: PlacementTrace[] } | null;
  reading: "ltr" | "rtl";
  setReading: (v: "ltr" | "rtl") => void;
  fontSize: number;
  setFontSize: (v: number) => void;
}) {
  if (!panel || !placement) return null;
  const pw = panel.width;
  const ph = panel.height;

  return (
    <div>
      <Caption>
        Balloons are sized to their own text first — the sweep runs the same
        layout code the renderer will, so &ldquo;auto-size&rdquo; can never
        disagree with &ldquo;does it fit&rdquo; — then placed by scoring every
        cell of a 5% grid. With no art rendered yet there is nothing to detect
        faces in, so the cost function falls back to staging hints: a head is
        roughly a sixth of the frame above the character&rsquo;s anchor.
      </Caption>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-faint">reading order</span>
          {(["ltr", "rtl"] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setReading(r)}
              aria-pressed={reading === r}
              className={`rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors ${
                reading === r
                  ? "border-accent text-accent"
                  : "border-hair text-dim hover:border-muted hover:text-body"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-faint">style.font_size</span>
          {[15, 28, 44].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFontSize(s)}
              aria-pressed={fontSize === s}
              className={`rounded-sm border px-2.5 py-1 font-mono text-xs tabular-nums transition-colors ${
                fontSize === s
                  ? "border-accent text-accent"
                  : "border-hair text-dim hover:border-muted hover:text-body"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 max-w-[64ch] font-mono text-[11px] leading-[1.6] text-faint">
        15 is the schema default, and it is small against a 1280px canvas — the
        balloon shrinks to fit the words rather than the words growing to fill a
        balloon. Turn it up and watch the fitter binary-search a size down toward
        font_size_min, re-wrap to the oval&rsquo;s curve, and the placement solve
        find somewhere the bigger box still clears both faces.
      </p>

      <Label>
        panel geometry · {pw}×{ph} · balloon coords normalised 0..1
      </Label>
      <div className="mt-2 overflow-x-auto rounded-sm border border-hair-soft bg-sunken p-3">
        <svg
          viewBox={`0 0 ${pw} ${ph}`}
          className="mx-auto block h-auto w-full max-w-[340px]"
          role="img"
          aria-label="Panel layout with speech balloon placement"
        >
          {/* export._placeholder's stand-in colours — no art has been drawn */}
          <rect x={0} y={0} width={pw} height={ph} fill="#e9e6e1" />
          {placement.faces.map((f, i) => (
            <rect
              key={`f${i}`}
              x={f[0] * pw} y={f[1] * ph} width={f[2] * pw} height={f[3] * ph}
              fill="none" stroke="#b8b2a8" strokeWidth={3} strokeDasharray="12 10"
            />
          ))}
          {panel.characters
            .filter((c) => c.visible)
            .map((c) => (
              <g key={c.character_id}>
                <circle
                  cx={c.screen_x * pw} cy={c.screen_y * ph} r={9}
                  fill="#8a8378"
                />
                <text
                  x={c.screen_x * pw + 16} y={c.screen_y * ph + 7}
                  fill="#7a736a" fontSize={26} fontFamily="ui-monospace, monospace"
                >
                  {characterById(c.character_id)?.name ?? ""}
                </text>
              </g>
            ))}

          {panel.bubbles.map((b) => {
            const shapes = bubbleShapes(b, pw, ph);
            const tail = tailPolygon(b, pw, ph);
            const lay = layoutText(
              b.text, b.w * pw, b.h * ph, b.style, b.kind,
              b.kind === "narration" || b.kind === "caption" ? "narration" : "body",
            );
            const font: Font = { role: lay.role, size: lay.size };
            const [ascent, descent] = fontMetrics(font);
            const cx = (b.x + b.w / 2) * pw;
            const cy = (b.y + b.h / 2) * ph;
            const top = cy - (lay.lines.length * lay.line_height) / 2;
            const lead = (lay.line_height - (ascent + descent)) / 2;
            const dash = b.style.dash.length >= 2 ? b.style.dash.join(" ") : undefined;
            return (
              <g key={b.id} opacity={b.style.opacity}>
                {tail && (
                  <polygon
                    points={polyPoints(tail)}
                    fill={b.style.fill}
                    stroke={b.style.stroke}
                    strokeWidth={b.style.stroke_width}
                  />
                )}
                {shapes.map((s, i) => (
                  <polygon
                    key={i}
                    points={polyPoints(s)}
                    fill={b.style.fill}
                    stroke={b.style.stroke}
                    strokeWidth={b.style.stroke_width}
                    strokeDasharray={dash}
                  />
                ))}
                {/* re-fill without the outline, so lobe and tail seams vanish */}
                {shapes.map((s, i) => (
                  <polygon key={`fill${i}`} points={polyPoints(s)} fill={b.style.fill} />
                ))}
                {lay.lines.map((ln, i) => {
                  const lw = textWidth(font, ln, lay.tracking);
                  const avail = lay.allowances[i] ?? b.w * pw;
                  const x =
                    b.style.align === "left"
                      ? cx - avail / 2
                      : b.style.align === "right"
                        ? cx + avail / 2 - lw
                        : cx - lw / 2;
                  return (
                    <text
                      key={`t${i}`}
                      x={x}
                      y={top + i * lay.line_height + lead + ascent}
                      fill={b.style.text_color}
                      fontSize={lay.size}
                      fontWeight={ROLE_FONT[lay.role].weight}
                      fontStyle={ROLE_FONT[lay.role].italic ? "italic" : "normal"}
                      fontFamily={ROLE_FONT[lay.role].stack}
                      letterSpacing={lay.tracking || undefined}
                    >
                      {ln}
                    </text>
                  );
                })}
              </g>
            );
          })}
          <rect
            x={0} y={0} width={pw} height={ph}
            fill="none" stroke="#1a1a1a" strokeWidth={6}
          />
        </svg>
      </div>
      {panel.bubbles.length === 0 && (
        <p className="mt-2 font-mono text-[11px] text-faint">
          this beat carries no quoted dialogue, so the panel has no balloons — pick
          a panel whose beat has a line in quotes
        </p>
      )}

      {placement.trace.length > 0 && (
        <>
          <Label>placement cost of the winning cell, per balloon</Label>
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-max font-mono text-[11px]">
              <thead>
                <tr className="text-faint">
                  <th className="px-2 py-1 text-left font-normal">balloon</th>
                  <th className="px-2 py-1 text-right font-normal">face ×240</th>
                  <th className="px-2 py-1 text-right font-normal">balloon ×160</th>
                  <th className="px-2 py-1 text-right font-normal">tail ×110</th>
                  <th className="px-2 py-1 text-right font-normal">preference</th>
                  <th className="px-2 py-1 text-right font-normal">total</th>
                </tr>
              </thead>
              <tbody className="text-dim">
                {placement.trace.map((t, i) => (
                  <tr key={t.id}>
                    <td className="px-2 py-1 tabular-nums">{i}</td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {round(t.faceCost, 2)}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {round(t.balloonCost, 2)}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {round(t.corridorCost, 2)}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {round(t.preferenceCost, 2)}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-body">
                      {round(t.total, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Caption>
            The tail column exists because of a bug found on real art with 128 unit
            tests green: tails are assigned after every balloon has been placed, so
            at placement time no tail exists and the cost function could not avoid
            one. A later balloon was parked squarely on an earlier balloon&rsquo;s
            tail. The fix predicts the corridor from the rect alone — the geometry
            is cheap and fully determined — and charges for crossing it.
          </Caption>
        </>
      )}

      <Label>models.Bubble — after auto_layout</Label>
      <Json
        value={panel.bubbles.map((b) => ({
          id: b.id,
          kind: b.kind,
          text: b.text,
          speaker_id: b.speaker_id,
          x: b.x, y: b.y, w: b.w, h: b.h,
          tail_x: b.tail_x, tail_y: b.tail_y,
          tail_width: b.tail_width, tail_curve: b.tail_curve,
          order: b.order,
          style: {
            font: b.style.font,
            font_size: b.style.font_size,
            font_size_min: b.style.font_size_min,
            line_height: b.style.line_height,
            align: b.style.align,
            uppercase: b.style.uppercase,
            padding: b.style.padding,
            stroke_width: b.style.stroke_width,
            dash: b.style.dash,
          },
        }))}
      />
    </div>
  );
}

// -------------------------------------------------------------------------- stage 7

function StageExport({ strip }: { strip: Strip | null }) {
  if (!strip) return null;
  const W = strip.width;
  const H = strip.height;
  return (
    <div>
      <Caption>
        One continuous vertical strip at the canvas width, gutters top and bottom
        and between every panel, then sliced into upload-sized tiles. The canvas
        width is 1280 rather than the old 800 webtoon standard because panels
        generate around 896px wide and exporting at 800 downsampled every single
        one.
      </Caption>
      <Label>
        build_strip() · {strip.entries.length} panels · {W}×{H}px ·{" "}
        {strip.slices} slices at {SLICE_HEIGHT}px
      </Label>
      <div className="mt-2 overflow-x-auto rounded-sm border border-hair-soft bg-sunken p-3">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="mx-auto block h-[520px] w-auto"
          role="img"
          aria-label="The assembled webtoon strip with slice boundaries"
        >
          <rect x={0} y={0} width={W} height={H} fill={CANVAS.background} />
          {strip.entries.map(({ panel, top }) => (
            <g key={panel.id}>
              <rect
                x={0} y={top} width={W} height={panel.height}
                fill="#e9e6e1" stroke="#1a1a1a" strokeWidth={6}
              />
              <text
                x={40} y={top + 130}
                fill="#5c554b" fontSize={110} fontFamily="ui-monospace, monospace"
              >
                {panel.shot.type}
              </text>
            </g>
          ))}
          {Array.from({ length: strip.slices - 1 }, (_, i) => (
            <line
              key={i}
              x1={0} y1={(i + 1) * SLICE_HEIGHT} x2={W} y2={(i + 1) * SLICE_HEIGHT}
              stroke="#d4635c" strokeWidth={8} strokeDasharray="40 30"
            />
          ))}
        </svg>
      </div>
      <p className="mt-2 font-mono text-[11px] text-faint">
        red rules are the tile boundaries — they cut through panels, which is why
        the exporter writes the strip first and crops afterwards rather than
        packing panels into pages
      </p>
      <Label>slice manifest</Label>
      <Json
        value={Array.from({ length: strip.slices }, (_, i) => ({
          file: `chapter_${String(i + 1).padStart(3, "0")}.png`,
          top: i * SLICE_HEIGHT,
          bottom: Math.min(H, (i + 1) * SLICE_HEIGHT),
          width: W,
        }))}
      />
      <Caption>
        And that is the whole chain: prose in, a machine-checkable chapter out,
        with the art generation the one step that needs a GPU. Everything on this
        page ran in the browser from the same tables the app runs on.
      </Caption>
    </div>
  );
}
