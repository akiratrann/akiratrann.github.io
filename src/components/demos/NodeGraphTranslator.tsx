"use client";

import { useMemo, useState, type ReactNode } from "react";

/*
  A faithful browser port of animagen's request-to-graph compiler.

  Everything below comes from api/main.py: build_workflow() and the four graph
  mutators it calls in order (_apply_loras, _apply_control, _apply_hires,
  _apply_upscale), the PROFILES table, the preset folding in _apply_preset /
  _compose_prompt, and the api/workflows/txt2img.json template they deep-copy.
  The node ids, class_types, output slot numbers and default values on screen
  are the ones the running API posts to ComfyUI's /prompt.

  No image is generated here and none could be — diffusion happens on the far
  side of that POST, on a GPU. The compilation is the part worth looking at:
  it is what makes the GPU swappable.

  State is a plain immutable form object; the graph is rebuilt by a pure
  function on every render, so nothing here reads a ref or a mutable cache.
*/

// ---------------------------------------------------------------------------
// Constants lifted from api/main.py
// ---------------------------------------------------------------------------

/** Minted-node id blocks. Each mutator owns one so ids can never collide. */
const LORA_NODE_BASE = 100;
const CONTROL_NODE_BASE = 200;
const HIRES_NODE_BASE = 400;
const UPSCALE_NODE_BASE = 410;

const MAX_LORAS = 3;

/* Spherical interpolation respects latent-space geometry; bilinear on a latent
   is interpolating coordinates that are not linear. */
const HIRES_UPSCALE_METHOD = "bislerp";
const HIRES_MIN_SCALE = 1.05;
const HIRES_MAX_SCALE = 1.6; // past ~1.6x in one step SD1.5 duplicates subjects
const HIRES_DENOISE = 0.45;

const UPSCALE_MODEL_FACTOR = 4.0;
const UPSCALE_DEFAULT_SCALE = 2.0;
const UPSCALE_MODEL = "RealESRGAN_x4plus_anime_6B.pth";

/* T2I-Adapter rather than a full ControlNet: 147.6 MB against 689 MB, and its
   hint encoder runs once per generation instead of once per step. */
const CONTROL_MODEL = "t2iadapter_depth-fp16.safetensors";
const CONTROL_IMAGE = "animagen_control/default_CAM_medium.png";

const SAMPLERS = [
  "ddim", "dpm_2", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "dpmpp_sde",
  "euler", "euler_ancestral", "heun", "lms", "uni_pc",
];
const SCHEDULERS = [
  "ddim_uniform", "exponential", "karras", "normal", "sgm_uniform", "simple",
];

type SizeKey = "square" | "portrait" | "landscape" | "portrait_wide" | "landscape_wide";

type Profile = {
  buckets: Record<SizeKey, [number, number]>;
  cfg: number;
  steps: number;
  clipSkip: number;
  negative: string;
};

/*
  Generation settings are per model family, not universal. A model produces
  mangled anatomy outside the resolutions it was trained on, and the negative
  stack is literal strings from its training captions — SDXL's vocabulary is
  not SD1.5's. Switching checkpoints switches the whole profile with it.
*/
const PROFILES: Record<"sd15" | "sdxl", Profile> = {
  sd15: {
    buckets: {
      square: [512, 512],
      portrait: [512, 768],
      landscape: [768, 512],
      portrait_wide: [576, 832],
      landscape_wide: [832, 576],
    },
    cfg: 7.0,
    steps: 28,
    // Most SD1.5 anime checkpoints descend from NovelAI, trained with the last
    // CLIP layer dropped. Skip 1 is not an error but is measurably muddier.
    clipSkip: 2,
    negative:
      "lowres, bad anatomy, bad hands, text, error, missing fingers, " +
      "extra digit, fewer digits, cropped, worst quality, low quality, " +
      "normal quality, jpeg artifacts, signature, watermark, username, blurry",
  },
  sdxl: {
    buckets: {
      square: [1024, 1024],
      portrait: [832, 1216],
      landscape: [1216, 832],
      portrait_wide: [896, 1152],
      landscape_wide: [1152, 896],
    },
    cfg: 8.5,
    steps: 28,
    // SDXL's text encoders were not trained with a dropped layer.
    clipSkip: 1,
    negative:
      "lowres, bad, text, error, missing, extra, fewer, cropped, " +
      "jpeg artifacts, worst quality, bad quality, watermark, bad aesthetic, " +
      "unfinished, chromatic aberration, scan, scan artifacts",
  },
};

/** _infer_family() — the family is read off the filename unless overridden. */
function inferFamily(ckpt: string): "sd15" | "sdxl" {
  const lowered = ckpt.toLowerCase();
  return ["xl", "pony", "illustrious", "noob"].some((m) => lowered.includes(m))
    ? "sdxl"
    : "sd15";
}

/** Both of these are checkpoints this repo actually fetches. */
const CHECKPOINTS = [
  "Counterfeit-V3.0_fix_fp16.safetensors",
  "AnimeBoysXL-v3.0.safetensors",
];

/** Stand-ins for whatever is in models/loras/ — see the note under the graph. */
const LORA_NAMES = [
  "mnhw-style-sd15.safetensors",
  "character/ren-v2.safetensors",
  "detail/add_detail.safetensors",
];

type Preset = {
  id: string;
  label: string;
  family: string | null;
  prefix: string;
  suffix: string;
  negativeAdd: string;
  strip: string[];
  cfg: number | null;
  steps: number | null;
  sampler: string | null;
  scheduler: string | null;
};

/*
  api/workflows/presets.json, verbatim. Two things are tuned into all of them
  on purpose: CFG sits at 6.0 rather than 7.0 (at 7 the model over-commits and
  the result gets the hard, evenly-lit look that reads as AI), and "masterpiece,
  best quality" is *stripped* rather than added — it is the most-trained-on
  caption pair in the SD1.5 anime lineage, so it pulls hard toward the mean.
*/
const PRESETS: Preset[] = [
  {
    id: "loose_painterly",
    label: "Loose painterly",
    family: "sd15",
    prefix:
      "painterly, visible brush strokes, thick paint texture, loose linework, " +
      "unfinished edges, rough shading, painted skin texture, impasto, gouache",
    suffix: "soft directional light, painted background",
    negativeAdd:
      "monochrome, greyscale, smooth shading, airbrushed, plastic skin, 3d, cg, " +
      "render, flat vector, sharp clean lineart, oversaturated, multicolored hair, " +
      "colored inner hair",
    strip: ["masterpiece", "best quality", "absurdres", "highres"],
    cfg: 6.0,
    steps: 32,
    sampler: "dpmpp_2m",
    scheduler: "karras",
  },
  {
    id: "hard_noir",
    label: "Hard noir",
    family: "sd15",
    prefix:
      "film noir, chiaroscuro, high contrast, heavy black shadows, hard rim " +
      "lighting, single light source, deep blacks, cast shadow across face, " +
      "limited palette, night",
    suffix: "cinematic lighting, dark background",
    negativeAdd:
      "monochrome, greyscale, flat lighting, low contrast, washed out, " +
      "overexposed, pastel colors, bright daylight, ambient occlusion only",
    strip: ["masterpiece", "best quality", "absurdres", "highres"],
    cfg: 6.0,
    steps: 30,
    sampler: "dpmpp_2m",
    scheduler: "karras",
  },
  {
    id: "flat_webtoon",
    label: "Flat webtoon",
    family: "sd15",
    prefix:
      "webtoon, korean manhwa style, clean thin lineart, even line weight, flat " +
      "cel shading, two tone shading, muted colour palette, muted natural tones, " +
      "simple background, white background",
    suffix: "soft even lighting",
    negativeAdd:
      "monochrome, greyscale, painterly, brush strokes, oil painting, heavy " +
      "shadows, gradient shading, photorealistic, 3d, render, busy background, " +
      "oversaturated, multicolored hair, colored inner hair",
    strip: ["masterpiece", "best quality", "absurdres", "highres"],
    cfg: 6.0,
    steps: 26,
    sampler: "dpmpp_2m",
    scheduler: "karras",
  },
  {
    id: "soft_semi_real",
    label: "Soft semi-realistic",
    family: "sd15",
    prefix:
      "semi-realistic, realistic proportions, detailed skin texture, subsurface " +
      "scattering, soft shading, soft diffused lighting, delicate features, " +
      "subtle blush, fine hair strands, shallow depth of field",
    suffix: "muted natural colour, window light",
    negativeAdd:
      "monochrome, greyscale, flat colour, cel shading, thick outlines, cartoon, " +
      "chibi, doll, plastic skin, waxy, oversaturated",
    strip: ["masterpiece", "best quality", "absurdres", "highres"],
    cfg: 6.0,
    steps: 32,
    sampler: "dpmpp_2m",
    scheduler: "karras",
  },
];

// ---------------------------------------------------------------------------
// Graph model
// ---------------------------------------------------------------------------

/** A link is [source node id, source output slot] — ComfyUI's API format. */
type Link = [string, number];
type InputValue = string | number | Link;
type Origin = "template" | "loras" | "control" | "hires" | "upscale";

type GNode = {
  id: string;
  classType: string;
  inputs: Record<string, InputValue>;
  origin: Origin;
};

type Graph = {
  /* An array, not an object. JS reorders integer-like keys numerically, which
     would quietly re-sort a payload Python emits in insertion order. */
  nodes: GNode[];
  /** "nodeId.inputKey" for every link a mutator moved off the template. */
  rewired: Set<string>;
};

const isLink = (v: InputValue): v is Link => Array.isArray(v);

function at(g: Graph, id: string): GNode {
  const node = g.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

/* The mutators read node 3's *resolved* inputs rather than remembering what
   they were, so these accessors mirror that and refuse anything else. */
function linkAt(n: GNode, key: string): Link {
  const v = n.inputs[key];
  if (!isLink(v)) throw new Error(`${n.id}.${key} is not a link`);
  return [v[0], v[1]];
}
function numAt(n: GNode, key: string): number {
  const v = n.inputs[key];
  if (typeof v !== "number") throw new Error(`${n.id}.${key} is not a number`);
  return v;
}
function strAt(n: GNode, key: string): string {
  const v = n.inputs[key];
  if (typeof v !== "string") throw new Error(`${n.id}.${key} is not a string`);
  return v;
}

/** api/workflows/txt2img.json, in its own key order. */
function freshTemplate(): Graph {
  const n = (
    id: string,
    classType: string,
    inputs: Record<string, InputValue>,
  ): GNode => ({ id, classType, inputs, origin: "template" });

  return {
    nodes: [
      n("4", "CheckpointLoaderSimple", { ckpt_name: CHECKPOINTS[0] }),
      n("5", "EmptyLatentImage", { width: 512, height: 768, batch_size: 1 }),
      n("6", "CLIPTextEncode", { text: "", clip: ["20", 0] }),
      n("7", "CLIPTextEncode", { text: "", clip: ["20", 0] }),
      n("3", "KSampler", {
        seed: 0,
        steps: 28,
        cfg: 7.0,
        sampler_name: "euler_ancestral",
        scheduler: "normal",
        denoise: 1.0,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      }),
      // CheckpointLoaderSimple emits MODEL 0, CLIP 1, VAE 2.
      n("8", "VAEDecode", { samples: ["3", 0], vae: ["4", 2] }),
      n("9", "SaveImage", { filename_prefix: "animagen", images: ["8", 0] }),
      n("20", "CLIPSetLastLayer", { clip: ["4", 1], stop_at_clip_layer: -2 }),
    ],
    rewired: new Set<string>(),
  };
}

// ---------------------------------------------------------------------------
// The four graph mutators, in the order build_workflow() calls them
// ---------------------------------------------------------------------------

/*
  _apply_loras — chain LoraLoader nodes between the checkpoint and everything
  downstream. Applied conditionally rather than kept in the template as
  pass-throughs: a LoraLoader at strength 0 still round-trips the weights and
  perturbs them. With no LoRAs the graph stays exactly the one that has been
  generating all along.
*/
function applyLoras(g: Graph, count: number): void {
  if (count <= 0) return;

  // LoraLoader emits the same MODEL/CLIP pair, so each swap is a drop-in.
  let modelSrc: Link = ["4", 0];
  let clipSrc: Link = ["4", 1];

  for (let offset = 0; offset < count; offset++) {
    const id = String(LORA_NODE_BASE + offset);
    g.nodes.push({
      id,
      classType: "LoraLoader",
      origin: "loras",
      inputs: {
        lora_name: LORA_NAMES[offset],
        strength_model: 1.0,
        strength_clip: 1.0,
        model: modelSrc,
        clip: clipSrc,
      },
    });
    modelSrc = [id, 0];
    clipSrc = [id, 1];
  }

  at(g, "3").inputs.model = modelSrc;
  g.rewired.add("3.model");
  /* The patched CLIP goes into CLIPSetLastLayer, not straight to the encoders.
     Rewiring the encoders would orphan node 20 and silently drop clip_skip for
     every LoRA generation. Both encoders stay on 20 — giving the negative
     prompt unpatched CLIP would change what the LoRA is contrasted against. */
  at(g, "20").inputs.clip = clipSrc;
  g.rewired.add("20.clip");
}

/*
  _apply_control — splice depth conditioning between the text encoders and the
  sampler. Runs after _apply_loras, and that order is the point: LoRAs rewire
  what CLIP the encoders read from, ControlNet consumes what those encoders
  produce. ControlNetApplyAdvanced emits both branches, so the negative prompt
  is conditioned on the same hint; applying the hint to the positive branch
  only is a common hand-wiring mistake and shows up as a washed-out image.
*/
function applyControl(g: Graph, on: boolean): void {
  if (!on) return;

  const loadId = String(CONTROL_NODE_BASE);
  const netId = String(CONTROL_NODE_BASE + 1);
  const applyId = String(CONTROL_NODE_BASE + 2);

  g.nodes.push({
    id: loadId,
    classType: "LoadImage",
    origin: "control",
    inputs: { image: CONTROL_IMAGE },
  });
  g.nodes.push({
    id: netId,
    classType: "ControlNetLoader",
    origin: "control",
    inputs: { control_net_name: CONTROL_MODEL },
  });
  g.nodes.push({
    id: applyId,
    classType: "ControlNetApplyAdvanced",
    origin: "control",
    inputs: {
      positive: ["6", 0],
      negative: ["7", 0],
      control_net: [netId, 0],
      image: [loadId, 0],
      strength: 1.0,
      start_percent: 0.0,
      end_percent: 1.0,
    },
  });

  // Slot 0 is the conditioned positive, slot 1 the conditioned negative.
  at(g, "3").inputs.positive = [applyId, 0];
  at(g, "3").inputs.negative = [applyId, 1];
  g.rewired.add("3.positive");
  g.rewired.add("3.negative");
}

/*
  _apply_hires — a latent upscale and a second sampler pass after KSampler 3.
  Deliberately last but one, and it has to be: the second pass must sample with
  the same model, positive and negative the first one *ended up* with, or it
  silently drops the LoRA stack and the depth hint and redraws at 0.45 denoise
  without them — which looks like "the LoRA is weak" rather than a wiring bug.
  Reading node 3's resolved links is what makes that automatic.
*/
function applyHires(g: Graph, on: boolean, scale: number): void {
  if (!on) return;

  const upscaleId = String(HIRES_NODE_BASE);
  const samplerId = String(HIRES_NODE_BASE + 1);
  const base = at(g, "3");

  g.nodes.push({
    id: upscaleId,
    classType: "LatentUpscaleBy",
    origin: "hires",
    inputs: {
      samples: ["3", 0],
      upscale_method: HIRES_UPSCALE_METHOD,
      scale_by: scale,
    },
  });
  g.nodes.push({
    id: samplerId,
    classType: "KSampler",
    origin: "hires",
    inputs: {
      // Seed and conditioning are shared with pass one on purpose: the second
      // pass elaborates the first pass's image, it does not draw a second one.
      seed: numAt(base, "seed"),
      steps: numAt(base, "steps"),
      cfg: numAt(base, "cfg"),
      sampler_name: strAt(base, "sampler_name"),
      scheduler: strAt(base, "scheduler"),
      denoise: HIRES_DENOISE,
      // Copied, not aliased — a shared reference would make a later edit to one
      // sampler's links quietly move the other's.
      model: linkAt(base, "model"),
      positive: linkAt(base, "positive"),
      negative: linkAt(base, "negative"),
      latent_image: [upscaleId, 0],
    },
  });

  at(g, "8").inputs.samples = [samplerId, 0];
  g.rewired.add("8.samples");
}

/*
  _apply_upscale — run the decoded image through an ESRGAN model on the way to
  SaveImage. After VAEDecode, so it composes with the hires pass rather than
  competing with it: hires invents structure, this sharpens what is there.
*/
function applyUpscale(g: Graph, on: boolean, scale: number): void {
  if (!on) return;

  const loaderId = String(UPSCALE_NODE_BASE);
  const applyId = String(UPSCALE_NODE_BASE + 1);

  g.nodes.push({
    id: loaderId,
    classType: "UpscaleModelLoader",
    origin: "upscale",
    inputs: { model_name: UPSCALE_MODEL },
  });
  g.nodes.push({
    id: applyId,
    classType: "ImageUpscaleWithModel",
    origin: "upscale",
    inputs: { upscale_model: [loaderId, 0], image: ["8", 0] },
  });

  let src: Link = [applyId, 0];
  if (scale < UPSCALE_MODEL_FACTOR) {
    /* lanczos on the way back down. The downsample is where most of the
       apparent sharpness comes from — a soft kernel here would undo the
       ESRGAN pass we just paid for. Downsampling a 4x result to 2x
       supersamples, so it beats asking a 2x model directly. */
    const downId = String(UPSCALE_NODE_BASE + 2);
    g.nodes.push({
      id: downId,
      classType: "ImageScaleBy",
      origin: "upscale",
      inputs: {
        image: [applyId, 0],
        upscale_method: "lanczos",
        scale_by: Math.round((scale / UPSCALE_MODEL_FACTOR) * 1e4) / 1e4,
      },
    });
    src = [downId, 0];
  }
  at(g, "9").inputs.images = src;
  g.rewired.add("9.images");
}

// ---------------------------------------------------------------------------
// Prompt composition (_tags / _tag_key / _compose_prompt / _compose_negative)
// ---------------------------------------------------------------------------

const tags = (text: string) =>
  text.split(",").map((t) => t.trim()).filter((t) => t.length > 0);

/* Booru tags arrive as both `male_focus` and `male focus` depending on who
   typed them, and the model treats them the same, so dedupe has to as well. */
const tagKey = (tag: string) => tag.toLowerCase().replace(/_/g, " ").trim();

/** prefix, then the caller's prompt minus stripped tags, then suffix. */
function composePrompt(prompt: string, preset: Preset): string {
  const drop = new Set(preset.strip.map(tagKey));
  const body = tags(prompt).filter((t) => !drop.has(tagKey(t)));

  const seen = new Set<string>();
  const out: string[] = [];
  // Style leads: tokens early in a CLIP prompt carry slightly more weight, and
  // a style tag buried after forty subject tags stops steering anything. The
  // caller's own tags keep their relative order — they describe the picture.
  for (const tag of [...tags(preset.prefix), ...body, ...tags(preset.suffix)]) {
    const key = tagKey(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  // A strip list that happens to cover everything typed would leave an empty
  // prompt, which is a 422 from a field the caller never touched.
  return out.join(", ") || prompt;
}

/** Additive by design: the UI pre-fills the negative box, so an override rule
    would mean preset negatives never applied at all. */
function composeNegative(negative: string, add: string): string {
  const seen = new Set(tags(negative).map(tagKey));
  const extra = tags(add).filter((t) => !seen.has(tagKey(t)));
  if (!extra.length) return negative;
  return [...tags(negative), ...extra].join(", ");
}

// ---------------------------------------------------------------------------
// Request resolution
// ---------------------------------------------------------------------------

type Form = {
  checkpoint: string;
  prompt: string;
  negativePrompt: string;
  size: SizeKey;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number;
  batchSize: number;
  clipSkip: number;
  presetId: string;
  loraCount: number;
  control: boolean;
  hires: boolean;
  hiresScale: number;
  upscale: boolean;
  upscaleScale: number;
};

/** Where a resolved value came from — the visible half of model_fields_set. */
type Source = "default" | "profile" | "preset" | "set";

type Resolved = {
  family: "sd15" | "sdxl";
  prompt: string;
  negativePrompt: string;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  clipSkip: number;
  width: number;
  height: number;
  from: Record<string, Source>;
  presetError: string | null;
  /** Tags the preset's strip list actually removed from what the caller typed. */
  stripped: string[];
};

/*
  _apply_preset folds a preset in as *defaults only*: every field the caller set
  explicitly wins. `explicit` is the caller's own model_fields_set, which is why
  the real code captures it before character expansion — expansion rewrites
  prompt and loras via model_copy, and those fields would then look explicitly
  set, making a preset's stack silently vanish.
*/
function resolveRequest(form: Form, explicit: ReadonlySet<string>): Resolved {
  const family = inferFamily(form.checkpoint);
  const profile = PROFILES[family];
  const from: Record<string, Source> = {};

  const pick = <T,>(field: string, mine: T, fallback: T, kind: Source): T => {
    if (explicit.has(field)) {
      from[field] = "set";
      return mine;
    }
    from[field] = kind;
    return fallback;
  };

  let negativePrompt = pick("negative_prompt", form.negativePrompt, profile.negative, "profile");
  let steps = pick("steps", form.steps, profile.steps, "profile");
  let cfg = pick("cfg", form.cfg, profile.cfg, "profile");
  const clipSkip = pick("clip_skip", form.clipSkip, profile.clipSkip, "profile");
  // sampler/scheduler default on the request model, not on the profile.
  let sampler = pick("sampler", form.sampler, "euler_ancestral", "default");
  let scheduler = pick("scheduler", form.scheduler, "normal", "default");

  let prompt = form.prompt;
  from.prompt = "set";
  let presetError: string | null = null;
  let stripped: string[] = [];

  const preset = PRESETS.find((p) => p.id === form.presetId) ?? null;
  if (preset) {
    if (preset.family !== null && preset.family !== family) {
      // The real guard, verbatim in shape: a 400 before anything is queued.
      presetError =
        `preset ${preset.id} is written for ${preset.family} tags but the ` +
        `loaded checkpoint is ${family}`;
    } else {
      const drop = new Set(preset.strip.map(tagKey));
      stripped = tags(prompt).filter((t) => drop.has(tagKey(t)));
      prompt = composePrompt(prompt, preset);
      from.prompt = "preset";
      negativePrompt = composeNegative(negativePrompt, preset.negativeAdd);
      from.negative_prompt = "preset";
      if (preset.cfg !== null && !explicit.has("cfg")) {
        cfg = preset.cfg;
        from.cfg = "preset";
      }
      if (preset.steps !== null && !explicit.has("steps")) {
        steps = preset.steps;
        from.steps = "preset";
      }
      if (preset.sampler !== null && !explicit.has("sampler")) {
        sampler = preset.sampler;
        from.sampler = "preset";
      }
      if (preset.scheduler !== null && !explicit.has("scheduler")) {
        scheduler = preset.scheduler;
        from.scheduler = "preset";
      }
    }
  }

  const [width, height] = profile.buckets[form.size];
  return {
    family, prompt, negativePrompt, steps, cfg, sampler, scheduler, clipSkip,
    width, height, from, presetError, stripped,
  };
}

/** build_workflow(req, seed) — deep-copy the template, write the flat fields
    in, then run the four mutators. The last two read links the first two may
    have rewritten, so the order is load-bearing. */
function buildWorkflow(form: Form, r: Resolved): Graph {
  const g = freshTemplate();

  at(g, "4").inputs.ckpt_name = form.checkpoint;
  // ComfyUI counts layers from the end, so skip N is stop_at_clip_layer -N.
  at(g, "20").inputs.stop_at_clip_layer = -Math.abs(r.clipSkip);
  at(g, "5").inputs.width = r.width;
  at(g, "5").inputs.height = r.height;
  at(g, "5").inputs.batch_size = form.batchSize;
  at(g, "6").inputs.text = r.prompt;
  at(g, "7").inputs.text = r.negativePrompt;
  at(g, "3").inputs.seed = form.seed;
  at(g, "3").inputs.steps = r.steps;
  at(g, "3").inputs.cfg = r.cfg;
  at(g, "3").inputs.sampler_name = r.sampler;
  at(g, "3").inputs.scheduler = r.scheduler;

  applyLoras(g, form.loraCount);
  applyControl(g, form.control);
  applyHires(g, form.hires, form.hiresScale);
  applyUpscale(g, form.upscale, form.upscaleScale);
  return g;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/* Python writes 7.0 where JSON.stringify writes 7. These are the input keys
   the API carries as floats, so the payload shown matches the one posted. */
const FLOAT_KEYS = new Set([
  "cfg", "denoise", "strength", "strength_model", "strength_clip",
  "start_percent", "end_percent", "scale_by",
]);

function renderValue(key: string, v: InputValue): string {
  if (isLink(v)) return `[${JSON.stringify(v[0])}, ${v[1]}]`;
  if (typeof v === "number") {
    return FLOAT_KEYS.has(key) && Number.isInteger(v) ? v.toFixed(1) : String(v);
  }
  return JSON.stringify(v);
}

function toJson(g: Graph): string {
  const body = g.nodes
    .map((n) => {
      const inputs = Object.entries(n.inputs)
        .map(([k, v]) => `      ${JSON.stringify(k)}: ${renderValue(k, v)}`)
        .join(",\n");
      return (
        `  ${JSON.stringify(n.id)}: {\n` +
        `    "class_type": ${JSON.stringify(n.classType)},\n` +
        `    "inputs": {\n${inputs}\n    }\n  }`
      );
    })
    .join(",\n");
  return `{\n${body}\n}`;
}

// ---------------------------------------------------------------------------
// Layout — longest-path layering over the DAG the mutators just produced
// ---------------------------------------------------------------------------

const NODE_W = 140;
const NODE_H = 36;
const COL_GAP = 8;
const ROW_H = 66;
const PAD_Y = 10;
const TEXT_X = 6;
const CLASS_SIZE = 9;
const META_SIZE = 8.5;
/* Measured advance of the mono face as a fraction of its size. Used only to
   keep node labels inside their 140px box — SVG will not wrap or clip them. */
const MONO_ADV = 0.66;
const TEXT_W = NODE_W - TEXT_X * 2;

type Placed = { node: GNode; x: number; y: number };
type Edge = {
  key: string;
  /** Pre-baked cubic. The control offset is proportional to the span so a
      one-layer hop stays a short hook and a ten-layer hop sweeps. */
  d: string;
  rewired: boolean;
};

function layoutGraph(g: Graph): {
  placed: Placed[]; edges: Edge[]; width: number; height: number;
} {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();

  const depthOf = (id: string): number => {
    const memo = depth.get(id);
    if (memo !== undefined) return memo;
    const node = byId.get(id);
    if (!node) return 0;
    depth.set(id, 0); // in-progress guard; the graph is always a DAG
    let d = 0;
    for (const v of Object.values(node.inputs)) {
      if (isLink(v)) d = Math.max(d, depthOf(v[0]) + 1);
    }
    depth.set(id, d);
    return d;
  };
  for (const n of g.nodes) depthOf(n.id);

  const layers: GNode[][] = [];
  for (const n of g.nodes) {
    const d = depth.get(n.id) ?? 0;
    if (!layers[d]) layers[d] = [];
    layers[d].push(n);
  }

  const widest = Math.max(...layers.map((l) => l.length));
  const width = Math.max(560, widest * (NODE_W + COL_GAP) - COL_GAP);
  const height = layers.length * ROW_H + PAD_Y * 2 - (ROW_H - NODE_H);

  const pos = new Map<string, Placed>();
  const placed: Placed[] = [];
  layers.forEach((layer, d) => {
    const rowW = layer.length * (NODE_W + COL_GAP) - COL_GAP;
    const startX = (width - rowW) / 2;
    layer.forEach((node, i) => {
      const p: Placed = {
        node,
        x: startX + i * (NODE_W + COL_GAP),
        y: PAD_Y + d * ROW_H,
      };
      pos.set(node.id, p);
      placed.push(p);
    });
  });

  const edges: Edge[] = [];
  for (const n of g.nodes) {
    const target = pos.get(n.id);
    if (!target) continue;
    for (const [key, v] of Object.entries(n.inputs)) {
      if (!isLink(v)) continue;
      const source = pos.get(v[0]);
      if (!source) continue;
      const x1 = source.x + NODE_W / 2;
      const y1 = source.y + NODE_H;
      const x2 = target.x + NODE_W / 2;
      const y2 = target.y - 6; // leave room for the arrowhead
      const bow = Math.max(10, (y2 - y1) * 0.4);
      edges.push({
        key: `${n.id}.${key}`,
        d: `M${x1},${y1} C${x1},${y1 + bow} ${x2},${y2 - bow} ${x2},${y2}`,
        rewired: g.rewired.has(`${n.id}.${key}`),
      });
    }
  }
  return { placed, edges, width, height };
}

/** The widget values worth showing inside a 140px box, truncated to whatever
    the `#id ` prefix leaves room for. Presentation only — every value is in
    full in the node table and the JSON. */
function summarise(n: GNode): string {
  const budget =
    Math.floor(TEXT_W / (META_SIZE * MONO_ADV)) - (n.id.length + 2);

  const raw = (() => {
    if (n.classType === "EmptyLatentImage") {
      return `${numAt(n, "width")}x${numAt(n, "height")}`;
    }
    const keys =
      n.classType === "KSampler"
        ? ["steps", "cfg", "denoise"]
        : Object.keys(n.inputs).filter((k) => !isLink(n.inputs[k]));
    return keys
      .map((k) => {
        const v = n.inputs[k];
        if (v === undefined || isLink(v)) return "";
        // Model names are addressed by their path under models/…; the leaf is
        // the only part that fits and the only part that identifies them.
        return typeof v === "string" ? v.split("/").pop() ?? v : renderValue(k, v);
      })
      .filter(Boolean)
      .join(" · ");
  })();

  return raw.length > budget ? `${raw.slice(0, Math.max(budget - 1, 0))}…` : raw;
}

/** SVG neither wraps nor clips text, so a class_type wider than its box gets
    squeezed rather than allowed to run into its neighbour. */
function squeezeTo(text: string, size: number): number | undefined {
  return text.length * size * MONO_ADV > TEXT_W ? TEXT_W : undefined;
}

const EDGE = "#38424d";
const EDGE_HOT = "#5fc98d";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const INITIAL: Form = {
  checkpoint: CHECKPOINTS[0],
  // The request in the project's own README.
  prompt:
    "1girl, solo, white hair, red eyes, school uniform, cherry blossoms, " +
    "masterpiece, best quality",
  negativePrompt: PROFILES.sd15.negative,
  size: "portrait",
  steps: PROFILES.sd15.steps,
  cfg: PROFILES.sd15.cfg,
  sampler: "euler_ancestral",
  scheduler: "normal",
  // Fixed rather than rolled, so the server render and the client render agree.
  seed: 913_448_270_115_302,
  batchSize: 1,
  clipSkip: PROFILES.sd15.clipSkip,
  presetId: "",
  loraCount: 0,
  control: false,
  hires: false,
  hiresScale: 1.5,
  upscale: false,
  upscaleScale: UPSCALE_DEFAULT_SCALE,
};

type Tab = "graph" | "nodes" | "json";

const MUTATORS: { origin: Origin; name: string }[] = [
  { origin: "loras", name: "_apply_loras" },
  { origin: "control", name: "_apply_control" },
  { origin: "hires", name: "_apply_hires" },
  { origin: "upscale", name: "_apply_upscale" },
];

export function NodeGraphTranslator() {
  const [form, setForm] = useState<Form>(INITIAL);
  const [explicit, setExplicit] = useState<ReadonlySet<string>>(new Set<string>());
  const [tab, setTab] = useState<Tab>("graph");

  /** Every edit both writes the value and marks the field explicitly set,
      which is what stops a preset from overwriting it. */
  function edit<K extends keyof Form>(key: K, value: Form[K], field?: string) {
    setForm((f) => ({ ...f, [key]: value }));
    if (field) setExplicit((e) => new Set(e).add(field));
  }

  const { resolved, graph, layout, json } = useMemo(() => {
    const r = resolveRequest(form, explicit);
    const g = buildWorkflow(form, r);
    return { resolved: r, graph: g, layout: layoutGraph(g), json: toJson(g) };
  }, [form, explicit]);

  const linkCount = graph.nodes.reduce(
    (sum, n) => sum + Object.values(n.inputs).filter(isLink).length,
    0,
  );
  const profile = PROFILES[resolved.family];

  return (
    <section className="mt-10 rounded border border-hair bg-raised">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hair px-4 py-3">
        <h2 className="font-prose text-base font-semibold text-bright">
          Flat request &rarr; ComfyUI node graph
        </h2>
        <p className="font-mono text-xs text-dim">ported from api/main.py</p>
      </header>

      <div className="px-4 py-4">
        <p className="max-w-[64ch] text-sm text-muted">
          animagen&rsquo;s FastAPI layer never asks the caller to draw a graph. It takes
          a flat JSON body and compiles it &mdash; <span className="font-mono text-xs text-body">build_workflow()</span>{" "}
          deep-copies <span className="font-mono text-xs text-body">txt2img.json</span>, writes the
          scalars in, then runs four mutators that mint nodes and <em>rewire existing
          links</em>. Edit the request; the payload that would be POSTed to ComfyUI&rsquo;s{" "}
          <span className="font-mono text-xs text-body">/prompt</span> is below, live.
        </p>

        {/* ------------------------------------------------ the flat request */}
        <div className="mt-4 rounded-sm border border-hair-soft bg-sunken p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-mono text-xs text-faint">POST /api/generate</p>
            <p className="font-mono text-[11px] text-faint">
              family <span className="text-body">{resolved.family}</span> inferred from
              the filename
            </p>
          </div>

          <label className="mt-3 block">
            <span className="font-mono text-[11px] text-dim">ckpt</span>
            <select
              value={form.checkpoint}
              onChange={(e) => edit("checkpoint", e.target.value)}
              className="mt-1 w-full rounded-sm border border-hair bg-ground px-2 py-1 font-mono text-xs text-body"
            >
              {CHECKPOINTS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>

          <Field label="prompt" source={resolved.from.prompt}>
            <textarea
              rows={2}
              value={form.prompt}
              onChange={(e) => edit("prompt", e.target.value)}
              className="w-full resize-y rounded-sm border border-hair bg-ground px-2 py-1.5 font-mono text-xs leading-relaxed text-body"
            />
          </Field>

          <Field label="negative_prompt" source={resolved.from.negative_prompt}>
            <textarea
              rows={2}
              value={explicit.has("negative_prompt") ? form.negativePrompt : profile.negative}
              onChange={(e) => edit("negativePrompt", e.target.value, "negative_prompt")}
              className="w-full resize-y rounded-sm border border-hair bg-ground px-2 py-1.5 font-mono text-xs leading-relaxed text-body"
            />
          </Field>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="size" source="set">
              <select
                value={form.size}
                onChange={(e) => edit("size", e.target.value as SizeKey)}
                className="w-full rounded-sm border border-hair bg-ground px-2 py-1 font-mono text-xs text-body"
              >
                {(Object.keys(profile.buckets) as SizeKey[]).map((k) => (
                  <option key={k} value={k}>
                    {k} &mdash; {profile.buckets[k][0]}x{profile.buckets[k][1]}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="sampler" source={resolved.from.sampler}>
              <select
                value={resolved.sampler}
                onChange={(e) => edit("sampler", e.target.value, "sampler")}
                className="w-full rounded-sm border border-hair bg-ground px-2 py-1 font-mono text-xs text-body"
              >
                {SAMPLERS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>

            <Field label="scheduler" source={resolved.from.scheduler}>
              <select
                value={resolved.scheduler}
                onChange={(e) => edit("scheduler", e.target.value, "scheduler")}
                className="w-full rounded-sm border border-hair bg-ground px-2 py-1 font-mono text-xs text-body"
              >
                {SCHEDULERS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>

            <Field label="seed" source="set">
              <div className="flex gap-2">
                <input
                  type="number"
                  value={form.seed}
                  min={0}
                  max={Number.MAX_SAFE_INTEGER}
                  onChange={(e) => edit("seed", Math.max(0, Number(e.target.value) || 0))}
                  className="w-full rounded-sm border border-hair bg-ground px-2 py-1 font-mono text-xs tabular-nums text-body"
                />
                <button
                  type="button"
                  // seed: -1 in the body means exactly this, server-side.
                  onClick={() => edit("seed", Math.floor(Math.random() * 2 ** 53))}
                  className="shrink-0 rounded-sm border border-hair px-2 py-1 font-mono text-xs text-dim transition-colors hover:border-muted hover:text-body"
                >
                  roll
                </button>
              </div>
            </Field>

            <Slider
              label="steps" source={resolved.from.steps} value={resolved.steps}
              min={1} max={60} step={1}
              onChange={(v) => edit("steps", v, "steps")}
            />
            <Slider
              label="cfg" source={resolved.from.cfg} value={resolved.cfg}
              min={1} max={15} step={0.5} decimals={1}
              onChange={(v) => edit("cfg", v, "cfg")}
            />
            <Slider
              label="clip_skip" source={resolved.from.clip_skip} value={resolved.clipSkip}
              min={1} max={4} step={1}
              onChange={(v) => edit("clipSkip", v, "clip_skip")}
            />
            <Slider
              label="batch_size" source="set" value={form.batchSize}
              min={1} max={4} step={1}
              onChange={(v) => edit("batchSize", v)}
            />
          </div>

          <Field label="preset" source={form.presetId ? "set" : "default"}>
            <select
              value={form.presetId}
              onChange={(e) => edit("presetId", e.target.value)}
              className="w-full rounded-sm border border-hair bg-ground px-2 py-1 font-mono text-xs text-body"
            >
              <option value="">null &mdash; no style preset</option>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.id} &mdash; {p.label}</option>
              ))}
            </select>
          </Field>

          {resolved.presetError && (
            <p className="mt-2 font-mono text-[11px] text-error">
              400 &mdash; {resolved.presetError}
            </p>
          )}

          {/* A preset supplies defaults, but it rewrites the prompt outright —
              so show what node 6 actually ends up encoding. */}
          {resolved.from.prompt === "preset" && (
            <div className="mt-2 rounded-sm border border-hair-soft bg-ground px-2 py-1.5">
              <p className="font-mono text-[11px] text-faint">
                _compose_prompt &rarr; node 6 text
              </p>
              <p className="mt-1 font-mono text-[11px] leading-relaxed break-words text-body">
                {resolved.prompt}
              </p>
              {resolved.stripped.length > 0 && (
                <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-faint">
                  stripped{" "}
                  <span className="text-warning">{resolved.stripped.join(", ")}</span>{" "}
                  &mdash; the most-trained-on caption pair in the SD1.5 anime lineage,
                  so it pulls hard toward the mean of everything ever tagged with it.
                  Style is described by describing it.
                </p>
              )}
            </div>
          )}

          {/* the four optional blocks — these are what change the graph's shape */}
          <div className="mt-4 border-t border-hair-soft pt-3">
            <p className="font-mono text-[11px] text-faint">
              optional blocks &mdash; each one is a mutator, absent means the graph is
              node-for-node the one that existed before the feature
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] text-dim">loras</span>
              {[0, 1, 2, 3].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => edit("loraCount", n)}
                  aria-pressed={form.loraCount === n}
                  className={`rounded-sm border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                    form.loraCount === n
                      ? "border-accent text-accent"
                      : "border-hair text-dim hover:border-muted hover:text-body"
                  }`}
                >
                  {n}
                </button>
              ))}
              <span className="font-mono text-[11px] text-faint">max {MAX_LORAS}</span>
              <Toggle
                label="control"
                on={form.control}
                onClick={() => edit("control", !form.control)}
              />
              <Toggle
                label="hires"
                on={form.hires}
                onClick={() => edit("hires", !form.hires)}
              />
              <Toggle
                label="upscale"
                on={form.upscale}
                onClick={() => edit("upscale", !form.upscale)}
              />
            </div>

            {form.hires && (
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Slider
                  label="hires.scale" source="set" value={form.hiresScale}
                  min={HIRES_MIN_SCALE} max={HIRES_MAX_SCALE} step={0.05} decimals={2}
                  onChange={(v) => edit("hiresScale", v)}
                />
                <p className="self-center font-mono text-[11px] text-faint">
                  capped at {HIRES_MAX_SCALE} &mdash; past that SD1.5 duplicates
                  subjects in one step
                </p>
              </div>
            )}
            {form.upscale && (
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Slider
                  label="upscale.scale" source="set" value={form.upscaleScale}
                  min={1.25} max={UPSCALE_MODEL_FACTOR} step={0.25} decimals={2}
                  onChange={(v) => edit("upscaleScale", v)}
                />
                <p className="self-center font-mono text-[11px] text-faint">
                  net magnification; the model is {UPSCALE_MODEL_FACTOR}x, so anything
                  below adds an ImageScaleBy on the way down
                </p>
              </div>
            )}
          </div>
        </div>

        {/* ------------------------------------------------------- the graph */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {(["graph", "nodes", "json"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={`rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors ${
                tab === t
                  ? "border-accent text-accent"
                  : "border-hair text-dim hover:border-muted hover:text-body"
              }`}
            >
              {t}
            </button>
          ))}
          <span className="ml-auto font-mono text-[11px] tabular-nums text-faint">
            {graph.nodes.length} nodes &middot; {linkCount} links
          </span>
        </div>

        <div className="mt-2 rounded-sm border border-hair-soft bg-sunken">
          {tab === "graph" && (
            <>
              <div className="scroll-x p-3">
                <svg
                  width={layout.width}
                  height={layout.height}
                  viewBox={`0 0 ${layout.width} ${layout.height}`}
                  role="img"
                  aria-label={`ComfyUI node graph, ${graph.nodes.length} nodes and ${linkCount} links`}
                >
                  <defs>
                    <marker id="ngt-head" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                      <path d="M0,0 L6,3 L0,6 Z" fill={EDGE} />
                    </marker>
                    <marker id="ngt-head-hot" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                      <path d="M0,0 L6,3 L0,6 Z" fill={EDGE_HOT} />
                    </marker>
                  </defs>

                  {layout.edges.map((e) => (
                    <path
                      key={e.key}
                      d={e.d}
                      fill="none"
                      stroke={e.rewired ? EDGE_HOT : EDGE}
                      strokeWidth={e.rewired ? 1.4 : 1}
                      markerEnd={`url(#ngt-head${e.rewired ? "-hot" : ""})`}
                    />
                  ))}

                  {layout.placed.map(({ node, x, y }) => {
                    const minted = node.origin !== "template";
                    return (
                      <g key={node.id}>
                        <rect
                          x={x} y={y} width={NODE_W} height={NODE_H} rx="3"
                          fill="#12161b"
                          stroke={minted ? EDGE_HOT : "#242c35"}
                          strokeWidth="1"
                        />
                        <text
                          x={x + TEXT_X} y={y + 14}
                          fontFamily="var(--font-mono)" fontSize={CLASS_SIZE}
                          textLength={squeezeTo(node.classType, CLASS_SIZE)}
                          lengthAdjust="spacingAndGlyphs"
                          fill={minted ? "#edf1f5" : "#c7ced6"}
                        >
                          {node.classType}
                        </text>
                        <text
                          x={x + TEXT_X} y={y + 27}
                          fontFamily="var(--font-mono)" fontSize={META_SIZE}
                          fill="#5d6873"
                        >
                          <tspan fill="#38424d">#{node.id}</tspan>{" "}
                          {summarise(node)}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-hair-soft px-3 py-2 font-mono text-[11px] text-faint">
                <span>
                  <span className="text-accent">&#9633;</span> minted at build time
                </span>
                <span>
                  <span className="text-accent">&rarr;</span> link a mutator rewired
                </span>
                {MUTATORS.filter((m) => graph.nodes.some((n) => n.origin === m.origin)).map((m) => (
                  <span key={m.origin}>
                    {m.name} &rarr;{" "}
                    <span className="text-dim">
                      {graph.nodes.filter((n) => n.origin === m.origin).map((n) => n.id).join(", ")}
                    </span>
                  </span>
                ))}
              </div>
            </>
          )}

          {tab === "nodes" && (
            <ul className="divide-y divide-hair-soft">
              {graph.nodes.map((n) => (
                <li key={n.id} className="px-3 py-2">
                  <p className="font-mono text-xs">
                    <span className="text-faint">#{n.id}</span>{" "}
                    <span className={n.origin === "template" ? "text-body" : "text-accent"}>
                      {n.classType}
                    </span>
                  </p>
                  <dl className="mt-1 grid grid-cols-[9rem_1fr] gap-x-3 font-mono text-[11px]">
                    {Object.entries(n.inputs).map(([k, v]) => {
                      const moved = graph.rewired.has(`${n.id}.${k}`);
                      return (
                        <div key={k} className="contents">
                          <dt className="text-dim">
                            {k} {isLink(v) ? <span className="text-faint">&larr;</span> : "="}
                          </dt>
                          <dd
                            className={`break-all ${
                              moved ? "text-accent" : isLink(v) ? "text-note" : "text-body"
                            }`}
                          >
                            {isLink(v) ? `#${v[0]} slot ${v[1]}` : renderValue(k, v)}
                            {moved && <span className="text-faint"> &middot; rewired</span>}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                </li>
              ))}
            </ul>
          )}

          {tab === "json" && (
            <div className="scroll-x p-3">
              <pre className="font-mono text-[11px] leading-relaxed text-body">{json}</pre>
            </div>
          )}
        </div>

        <p className="mt-3 max-w-[64ch] font-mono text-[11px] leading-relaxed text-faint">
          Ported from <span className="text-dim">api/main.py</span> (build_workflow,
          _apply_loras, _apply_control, _apply_hires, _apply_upscale, _apply_preset,
          _compose_prompt) and <span className="text-dim">api/workflows/txt2img.json</span>.
          The LoRA filenames are stand-ins &mdash; the real ones are whatever is in
          models/loras/, which the API scans per request. Nothing here reaches a
          network; ComfyUI is on the other side of the POST this builds.
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<Source, string> = {
  default: "model default",
  profile: "profile default",
  preset: "from preset",
  set: "",
};

function Field({
  label,
  source,
  children,
}: {
  label: string;
  source?: Source;
  children: ReactNode;
}) {
  const note = source ? SOURCE_LABEL[source] : "";
  return (
    <label className="mt-3 block">
      <span className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] text-dim">{label}</span>
        {note && <span className="font-mono text-[11px] text-faint">{note}</span>}
      </span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function Slider({
  label,
  source,
  value,
  min,
  max,
  step,
  decimals = 0,
  onChange,
}: {
  label: string;
  source?: Source;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  onChange: (v: number) => void;
}) {
  const note = source ? SOURCE_LABEL[source] : "";
  return (
    <label className="block">
      <span className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] text-dim">
          {label}{" "}
          <span className="tabular-nums text-body">{value.toFixed(decimals)}</span>
        </span>
        {note && <span className="font-mono text-[11px] text-faint">{note}</span>}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5 h-1 w-full cursor-pointer appearance-none rounded-sm bg-hair accent-[#5fc98d]"
      />
    </label>
  );
}

function Toggle({
  label,
  on,
  onClick,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`rounded-sm border px-2 py-0.5 font-mono text-[11px] transition-colors ${
        on
          ? "border-accent text-accent"
          : "border-hair text-dim hover:border-muted hover:text-body"
      }`}
    >
      {label}
    </button>
  );
}
