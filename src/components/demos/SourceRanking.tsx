"use client";

import { useMemo, useState } from "react";

/*
  Pocket Planet's recommendation ranker, running in the browser.

  Every weight, curve and guard below is transcribed from the real source:
  the scoring model from travel_app/src/data/ranking.ts, and the per-publisher
  mention weights + the mention counter from travel_app/server/assemble.ts.

  The catalogue is a frozen sample — 28 places from the real Wikivoyage parses
  of Kyoto and Hoi An, carrying their real Wikidata sitelink counts, their real
  heritage designations, and the real per-publisher mention counts that
  computeBuzz() produced over the project's cached source corpus. The mining
  that produces those counts is a networked server job; the function that turns
  them into an order is this one, unchanged.

  The model's central claim is that it computes TWO numbers and never adds them
  together: `score` is evidence about the PLACE, `confidence` is completeness of
  OUR LISTING. A photo cannot move a ranking. That separation is the thing the
  toggles below are here to make visible.
*/

// ---------------------------------------------------------------------------
// Constants — RANKING_WEIGHTS, src/data/ranking.ts
//
// The live deployment reads these through wt(), which falls back to these
// compiled-in defaults whenever the self-tuner's persisted state predates a
// weight. The on-disk learned state (v29) only carries completeness weights, so
// every EVIDENCE weight below is what the live ranker actually uses.
// ---------------------------------------------------------------------------
const W = {
  // Evidence — these, and only these, produce `score`.
  mentionMax: 38,
  mentionFull: 24,
  encyclopedicMax: 30,
  encyclopedicFloor: 3,
  encyclopedicFull: 55,
  heritageWorld: 20,
  heritageAny: 10,
  heritageEach: 4,
  heritageMax: 30,
  notableKeywordBonus: 3,
  notableKeywordCap: 12,
  civicNamePenalty: 45,
  // Completeness — these produce `confidence` and nothing else.
  hasCoordinates: 6,
  hasWikidata: 14,
  hasImage: 10,
  hasUrl: 6,
  hasHours: 3,
  hasPrice: 3,
  hasAddress: 4,
  descriptionLengthMax: 22,
  descriptionLengthChars: 320,
} as const;

/** meritDenominator() — an absolute scale, so 70 means the same in every city. */
const MERIT_FULL =
  W.mentionMax + W.encyclopedicMax + W.heritageMax + W.notableKeywordCap; // 110

/** confidenceDenominator() — "how much of our listing is filled in". */
const CONF_FULL =
  W.hasCoordinates +
  W.hasWikidata +
  W.hasImage +
  W.hasUrl +
  W.hasHours +
  W.hasPrice +
  W.hasAddress +
  W.descriptionLengthMax; // 68

/** BUZZ_CAP — ceiling on the total mention boost for a single place. */
const BUZZ_CAP = 24;

type Provider =
  | "Lonely Planet"
  | "Reddit"
  | "YouTube"
  | "Travel Stack Exchange";

/** BUZZ_WEIGHT, server/assemble.ts. What a mention on each platform is worth. */
const PROVIDERS: { id: Provider; weight: number; note: string }[] = [
  { id: "Lonely Planet", weight: 8, note: "authoritative editorial" },
  { id: "Reddit", weight: 5, note: "recommendation-rich" },
  { id: "YouTube", weight: 4, note: "recommendation-rich" },
  { id: "Travel Stack Exchange", weight: 2, note: "skews to logistics" },
];

// ---------------------------------------------------------------------------
// Prominence phrases — DEFAULT_PROMINENCE_KEYWORDS, src/data/ranking.ts.
//
// Known bias, stated in the source and repeated here because it decides
// rankings: the list is mostly English and is matched against the listing's own
// description, so a place written up in English can earn these points and the
// same place described only in Japanese cannot. Which is why it is worth 3 a
// phrase with a ceiling of 12, against 38 for mentions.
// ---------------------------------------------------------------------------
const DEFAULT_PROMINENCE_KEYWORDS = [
  "unesco", "world heritage", "world-famous", "world famous", "iconic",
  "must-see", "must see", "must-visit", "must visit", "most famous",
  "best-known", "best known", "renowned", "landmark", "the largest",
  "the oldest", "the tallest", "the biggest", "the highest", "symbol of",
  "national treasure", "masterpiece", "spectacular", "breathtaking",
  "not to be missed", "one of the", "highlight",
  "世界遺産", "国宝", "세계유산", "di sản thế giới", "มรดกโลก",
];

/** Cues the self-tuner added to the live learned state (learned.json v29). */
const LEARNED_PROMINENCE_KEYWORDS = [
  "taisha",
  "grand shrine",
  "ancient house",
  "world heritage",
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does this phrase live in a script where `\b` means anything? */
function isLatinPhrase(k: string): boolean {
  return /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}]+$/u.test(k);
}

/*
  buildProminenceRegex(). Split by script: JavaScript's `\b` is ASCII-only, so
  wrapping a CJK or Thai phrase in word boundaries produces a pattern that can
  never match. Latin phrases keep their guards so "iconic" does not fire inside
  "iconically"; the rest are matched bare.
*/
const PROMINENCE_RES: RegExp[] = (() => {
  const all = [...DEFAULT_PROMINENCE_KEYWORDS, ...LEARNED_PROMINENCE_KEYWORDS];
  const latin = all
    .filter(isLatinPhrase)
    .map((k) => escapeRe(k).replace(/\s+/g, "[ -]"));
  const other = all.filter((k) => !isLatinPhrase(k)).map(escapeRe);
  const out: RegExp[] = [];
  if (latin.length) out.push(new RegExp("\\b(" + latin.join("|") + ")\\b", "gi"));
  if (other.length) out.push(new RegExp("(" + other.join("|") + ")", "gi"));
  return out;
})();

// ---------------------------------------------------------------------------
// Civic / utility names. The last-resort relevance check for listings carrying
// no structured data, and it only ever DEMOTES — a keyword can be wrong, and
// burying a real attraction is recoverable in a way that deleting it is not.
// Matched against the NAME only.
// ---------------------------------------------------------------------------
const CIVIC_NAME_PATTERNS = [
  "elementary school", "primary school", "middle school", "junior high school",
  "high school", "secondary school", "special needs school", "kindergarten",
  "nursery school", "driving school",
  "post office", "city hall", "town hall", "village office", "ward office",
  "municipal office", "prefectural office", "city office", "police station",
  "police box", "fire station", "tax office", "employment office",
  "general hospital", "city hospital", "central hospital", "regional hospital",
  "district hospital", "university hospital", "psychiatric hospital",
  "clinic", "health centre", "health center", "medical centre", "medical center",
  "atm",
  "water treatment", "sewage", "power plant", "power station", "substation",
  "landfill", "incinerator", "car park", "parking lot", "petrol station",
  "gas station", "filling station",
];

const CIVIC_NAME_PATTERNS_INTL = [
  "小学校", "中学校", "高等学校", "支援学校", "幼稚園", "郵便局", "市役所", "町役場",
  "区役所", "警察署", "交番", "消防署", "病院", "診療所", "浄水場",
  "小学", "中学", "派出所", "医院", "邮局", "郵局",
  "초등학교", "중학교", "고등학교", "우체국", "경찰서", "병원",
  "ngân hàng", "bưu điện", "trường tiểu học", "trường trung học", "bệnh viện",
  "trạm y tế", "ủy ban nhân dân",
  "โรงเรียน", "โรงพยาบาล",
];

const CIVIC_RE = new RegExp(
  "\\b(" +
    CIVIC_NAME_PATTERNS.map(escapeRe)
      .map((k) => k.replace(/\s+/g, "[ -]"))
      .join("|") +
    ")\\b",
  "i",
);
const CIVIC_RE_INTL = new RegExp(
  "(" + CIVIC_NAME_PATTERNS_INTL.map(escapeRe).join("|") + ")",
  "i",
);

/* The museum in the former post office is pardoned outright. */
const ATTRACTION_RE =
  /\b(museum|gallery|memorial|monument|shrine|temple|cathedral|basilica|church|mosque|synagogue|castle|palace|fort|fortress|ruins?|park|garden|beach|waterfall|onsen|spa|market|bazaar|theatre|theater|gallery|heritage|historic|historical|national\s+treasure)\b/i;

/** Does the NAME say this is a civic/utility building rather than a sight? */
function looksCivic(name: string): boolean {
  if (ATTRACTION_RE.test(name)) return false;
  return CIVIC_RE.test(name) || CIVIC_RE_INTL.test(name);
}

/**
 * Wikidata P1435 values that mean UNESCO World Heritage. Deliberately item ids
 * rather than words: a Q-number means the same thing in every language, so
 * unlike the keyword list above this check carries no language bias.
 */
const WORLD_HERITAGE = new Set(["Q9259", "Q43113623"]);

/**
 * encyclopedicFraction(). Logarithmic between a floor and a ceiling, because
 * the interesting difference is at the bottom: 3 editions to 10 is the step
 * from parish-notable to internationally known, while 57 to 77 separates two
 * places that are both simply famous.
 */
function encyclopedicFraction(sitelinks: number): number {
  const floor = Math.max(1, W.encyclopedicFloor);
  const full = Math.max(floor + 1, W.encyclopedicFull);
  if (!Number.isFinite(sitelinks) || sitelinks <= floor) return 0;
  const frac =
    (Math.log(sitelinks) - Math.log(floor)) / (Math.log(full) - Math.log(floor));
  return Math.max(0, Math.min(1, frac));
}

const normalizeName = (name: string) =>
  name.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The live learned overrides, straight off the deployment's learned.json. Each
 * one is a real traveller correction — and the keys are what the reader typed,
 * which is why resolveOverrides() below exists.
 */
const FEEDBACK_OVERRIDES: Record<string, number> = {
  "japanese covered bridge": -60,
  "old house of tan ky": 50,
  "fushimi inari": 25,
};

/**
 * resolveOverrides(). A key that is not an exact name is matched as a leading
 * whole-word prefix — "fushimi inari" -> "Fushimi Inari Taisha" — and ONLY when
 * exactly one place matches. Before this existed the correction was accepted,
 * stored, shown as applied, and changed no ranking at all.
 */
function resolveOverrides(
  names: string[],
  overrides: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const norm = names.map(normalizeName);
  const present = new Set(norm);
  for (const [key, value] of Object.entries(overrides)) {
    if (present.has(key)) {
      out[key] = value;
      continue;
    }
    const hits = norm.filter((n) => n === key || n.startsWith(key + " "));
    if (hits.length === 1) out[hits[0]] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The shipped sample.
//
// Real Wikivoyage listings from the project's own .measure-cache snapshots,
// with `sitelinks` and `heritage` as resolved from Wikidata, and `mentions` as
// counted by the real computeBuzz() over the real cached corpus (5 Lonely
// Planet + 3 YouTube + 1 Travel Stack Exchange sources for Kyoto; 6 Travel
// Stack Exchange + 3 YouTube for Hoi An). `order` is the listing's position in
// the source article, kept here because the model's most consequential decision
// was to throw it out.
// ---------------------------------------------------------------------------
type CityId = "Kyoto" | "Hoi An";
type CategoryId =
  | "sights" | "culture" | "nature" | "activities" | "food"
  | "nightlife" | "shopping";

interface Listing {
  coords: boolean;
  wikidata: boolean;
  image: boolean;
  url: boolean;
  hours: boolean;
  price: boolean;
  address: boolean;
}

interface Place {
  city: CityId;
  name: string;
  category: CategoryId;
  order: number;
  sitelinks: number;
  heritage: string[];
  mentions: Partial<Record<Provider, number>>;
  description: string;
  listing: Listing;
}

const PLACES: Place[] = [
  {
    city: "Kyoto",
    name: "Fushimi Inari Taisha",
    category: "culture",
    order: 226,
    sitelinks: 40,
    heritage: ["Q1188622"],
    mentions: { "Lonely Planet": 6, YouTube: 6 },
    description:
      "Another of Kyoto's jewels, located just south of Higashiyama in the Fushimi area. Dedicated to Inari, the Japanese fox goddess, Fushimi-Inari-taisha is the head shrine (taisha) for 40,000 Inari shrines across Japan. Stretching 230 meters up the hill behind it are hundreds of bright red torii (gates). A visitor could easily spend several hours walking up the hillside, taking in the beautiful views of the city of Kyoto and walking through the torii, which appear luminescent in the late afternoon sun. Countless stone foxes, also referred to as Inari, are also dotted along the path. Watch your fingers as you go - the fox spirits are said to be able to possess people by slipping through their fingernails.",
    listing: { coords: true, wikidata: true, image: true, url: true, hours: true, price: true, address: false },
  },
  {
    city: "Kyoto",
    name: "Kiyomizu Temple",
    category: "culture",
    order: 124,
    sitelinks: 77,
    heritage: ["Q1139795", "Q43113623"],
    mentions: { "Lonely Planet": 14, YouTube: 13 },
    description:
      "This temple complex, with its spectacular location overlooking the city, is a deservedly popular attraction, approached by either of two tourist-filled souvenir-shop-lined streets, Kiyomizu-zaka or Chawan-zaka.",
    listing: { coords: true, wikidata: true, image: true, url: true, hours: true, price: true, address: true },
  },
  {
    city: "Kyoto",
    name: "Kinkaku-ji Temple",
    category: "culture",
    order: 178,
    sitelinks: 57,
    heritage: ["Q43113623", "Q1139795", "Q26764449", "Q94987823"],
    mentions: { "Lonely Planet": 5, YouTube: 4 },
    description:
      "The Temple of the Golden Pavilion, formally known as Rokuonji (鹿苑寺), is the most popular tourist attraction in Kyoto. The pavilion was built as a retirement villa for Shogun Ashikaga Yoshimitsu in the late 14th century, and converted into a temple by his son. However, the pavilion was burnt down in 1950, by a young monk who had become obsessed with it. (The story became the basis for Yukio Mishima's novel The Temple of the Golden Pavilion.) The beautiful landscaping and the reflection of the temple on the face of the water make for a striking sight, but keeping the mobs of visitors out of your photos will be a stern test for your framing abilities. Get there early if you can to beat the school groups. Visitors follow a path through the moss garden surrounding the pavilion, before emerging into a square crowded with gift shops. It's only a short walk from Ryōan-ji (below), making for an easy pairing (and study in contrasts).",
    listing: { coords: true, wikidata: true, image: true, url: true, hours: true, price: true, address: true },
  },
  {
    city: "Kyoto",
    name: "Nijō Castle",
    category: "culture",
    order: 39,
    sitelinks: 29,
    heritage: ["Q1139795", "Q43113623", "Q30834580", "Q94987823"],
    mentions: { "Lonely Planet": 2, YouTube: 1 },
    description:
      "Certainly one of the highlights of Kyoto, with fine gardens and splendid centuries-old structures. The castle was built by the Tokugawa shoguns to serve as the shogun's residence in Kyoto. After the fall of the Tokugawa shogunate, the castle served as an imperial residence before being converted to a museum and opened to the public. The series of ornately-decorated reception rooms within the Ninomaru Palace complex is particularly impressive, and known for its \"nightingale floors\" - wooden flooring which makes bird-like squeaking sounds when stepped on so as to give advance warning when someone was approaching. From the empty base of the donjon that once overlooked the innermost section of the fortress (known as the Honmaru), you can get good views over parts of the castle compound and the wider city beyond. The donjon and original Honmaru Palace burnt down in two separate fires; the current Honmaru Palace was originally part of a prince's residence, and moved to its current location in the Meiji Period (late 19th century). The Honmaru Palace was opened to the public for the first time in 18 years on September 1, 2024, but reservations are required, and it will cost an additional ¥1,000. See also Japanese castles.",
    listing: { coords: true, wikidata: true, image: true, url: true, hours: true, price: true, address: true },
  },
  {
    city: "Kyoto",
    name: "Heian Shrine",
    category: "culture",
    order: 130,
    sitelinks: 27,
    heritage: ["Q1188622"],
    mentions: { "Lonely Planet": 3, YouTube: 3 },
    description:
      "Built in 1895 in commemoration of the 1100th anniversary of Kyoto, the shrine was designed as a scaled-down replica of the original Imperial Palace. The Shin'en Garden encircling the backside of the shrine is one of the city's most beautiful gardens and a popular place for hanami, particularly for those who prefer pink blossoms.",
    listing: { coords: true, wikidata: true, image: true, url: true, hours: true, price: true, address: true },
  },
  {
    city: "Kyoto",
    name: "Ryōan-ji",
    category: "culture",
    order: 179,
    sitelinks: 32,
    heritage: ["Q43113623", "Q1188622", "Q30834580", "Q94987823"],
    mentions: { "Lonely Planet": 1 },
    description:
      "Famous for its Zen garden, which is considered to be one of the most notable examples of the \"dry-landscape\" style. Surrounded by low walls, an austere arrangement of fifteen rocks sits on a bed of white gravel. That's it: no trees, no hills, no ponds, and no trickling water. Behind the simple temple that overlooks the rock garden is a stone washbasin called Tsukubai said to have been contributed by Tokugawa Mitsukuni in the 17th century. It bears a simple but profound four-character inscription: \"I learn only to be contented\". There is a fantastic boiled tofu (湯豆腐 yudōfu) restaurant on the grounds, which you should be able to find by following the route away from the rock garden and towards the exit. It is slightly expensive, but serves delicious, traditional tofu dishes. There is also a small cafe, serving food including vegetarian yudōfu dishes, from 11am to 3pm. The rest of the grounds are worth a look too - particularly the large pond.",
    listing: { coords: true, wikidata: true, image: true, url: true, hours: true, price: true, address: false },
  },
  {
    city: "Kyoto",
    name: "Ginkakuji",
    category: "culture",
    order: 146,
    sitelinks: 33,
    heritage: ["Q1139795", "Q43113623", "Q26764449", "Q94987823"],
    mentions: { YouTube: 1 },
    description:
      "This temple, known as the Silver Pavilion and restored between 2008 and 2010, is at the northern end of the Philosopher's Walk. Much like its golden counterpart Kinkakuji, the Silver Pavilion is often choked with tourists, shuffling past a scrupulously-maintained dry landscape Zen garden and the surrounding moss garden, before posing for pictures in front of the Pavilion across a pond. Unlike its counterpart, however, the Silver Pavilion was never actually covered in silver; only the name had been applied before the plans fell apart. Be sure not to miss the display of Very Important Mosses!",
    listing: { coords: true, wikidata: true, image: true, url: true, hours: true, price: true, address: true },
  },
  {
    city: "Kyoto",
    name: "Tō-ji",
    category: "culture",
    order: 46,
    sitelinks: 30,
    heritage: ["Q1139795", "Q43113623", "Q30834580"],
    mentions: {},
    description:
      "An impressive complex of Buddhist temple buildings, this site features the tallest pagoda in Japan. Bright colors decorate the interior of many buildings on the site, and Buddhist sculptures compliment the color choices. The grounds include a relaxing garden, and cherry blossoms. The Kōbō-san market fair is held here on the 21st of every month.",
    listing: { coords: true, wikidata: true, image: true, url: true, hours: true, price: true, address: true },
  },
  {
    city: "Kyoto",
    name: "Daigo-ji",
    category: "culture",
    order: 231,
    sitelinks: 23,
    heritage: ["Q1139795", "Q43113623"],
    mentions: { YouTube: 1 },
    description:
      "Daigoji is a large temple complex consisting of the garan (main complex), Sanbōin Garden, and Reihōkan Museum. The size and position of the temple, slightly removed from the city, creates a more peaceful, serene setting. As a registered World Heritage Site, the temple has a lot of history, with the oldest remaining structure being the five-story pagoda built in 951. The Sanbōin is the temple's garden, and despite being rather pricey is truly beautiful. The museum houses many of the temple's treasures. Daigoji Temple is famous for being one of Kyoto's best places to view cherry blossoms in the spring and the leaves in the fall. Although the main temple complex is always worth visiting, those visiting in the autumn should consider paying the extra fee to see the Sanbōin garden, as it becomes especially beautiful with the vivid colors of the leaves (sadly pictures are not allowed in the Sanbōin).",
    listing: { coords: true, wikidata: true, image: true, url: true, hours: true, price: true, address: true },
  },
  {
    city: "Kyoto",
    name: "Maruyama Park",
    category: "culture",
    order: 136,
    sitelinks: 10,
    heritage: ["Q11414752"],
    mentions: { "Lonely Planet": 3 },
    description:
      "One of the most popular spot for cherry blossom viewing in Kyoto, and can get extremely crowded at that time of year. The park's star attraction is a weeping cherry tree (shidarezakura), which offers an ethereal vision lit up in the night. Outside of the season, a nice spot to rest yourself during travelling around the Higashiyama area. Main entrance to the park is through Yasaka Shrine.",
    listing: { coords: true, wikidata: true, image: true, url: true, hours: false, price: true, address: true },
  },
  {
    city: "Kyoto",
    name: "Bamboo Forest",
    category: "culture",
    order: 3,
    sitelinks: 21,
    heritage: [],
    mentions: { "Lonely Planet": 3, YouTube: 9 },
    description:
      "This is the reason why most people head into this area, all taking the same looking pictures. You should visit when the sun is at its highest point, because the forest is quite dark and will only let in a few sun rays — don't wait until the afternoon. Note, the bamboo forest is free, but you might get the impression that you have to cross through the Tenryū-ji temple and gardens to reach it, don't or it will cost you ¥500. Just take the walkway route just south of the railway tracks, which begins at the upper end of the main road leading north from the Randen tram terminal.",
    listing: { coords: true, wikidata: true, image: true, url: false, hours: false, price: true, address: false },
  },
  {
    city: "Kyoto",
    name: "Kyoto National Museum",
    category: "culture",
    order: 127,
    sitelinks: 25,
    heritage: ["Q1188622"],
    mentions: { "Lonely Planet": 1 },
    description:
      "It is near Sanjusangen-do, and has a large collection of ancient Japanese sculpture, ceramics, metalwork, painting, and other artifacts. (It's quite similar to the Tokyo National Museum in Tokyo/Ueno.) The Museum building is fairly grand, but the statue of Rodin's The Thinker out front is a bit out of place, as there's no Western art inside. It's seven minutes east of Shichijo Keihan.",
    listing: { coords: true, wikidata: true, image: true, url: true, hours: true, price: true, address: true },
  },
  {
    city: "Kyoto",
    name: "Nishiki Market",
    category: "shopping",
    order: 60,
    sitelinks: 7,
    heritage: [],
    mentions: { "Lonely Planet": 8, YouTube: 17 },
    description:
      "An enclosed traditional shopping street, expensive but full of interesting shops and products, including great souvenirs and snacks. It runs east-west, a block north of Shijo-dori, and at its eastern end it connects to Teramachi-dori, another, newer shopping street that runs north-south.",
    listing: { coords: true, wikidata: true, image: true, url: true, hours: false, price: false, address: true },
  },
  {
    city: "Kyoto",
    name: "Toei Kyoto Studio Park",
    category: "activities",
    order: 2,
    sitelinks: 6,
    heritage: [],
    mentions: {},
    description:
      "Toei Kyoto Studio Park is an active film studio which continues to be used for the filming of period dramas. Visitors may visit the outdoor sets used in many samurai movies, and if they are lucky, could potentially observe the filming of a period drama.",
    listing: { coords: true, wikidata: true, image: true, url: true, hours: true, price: true, address: true },
  },
  {
    city: "Kyoto",
    name: "Funaoka Onsen",
    category: "activities",
    order: 1,
    sitelinks: 0,
    heritage: [],
    mentions: {},
    description:
      "Funaoka Onsen is one of the oldest public bath houses in Kyoto still in operation. Its classic building is an excellent example of bath house architecture of the beginning of the 20th century. Funaoka Onsen is popular with both locals and visitors and is a must if you have an hour to spare.",
    listing: { coords: true, wikidata: false, image: true, url: true, hours: true, price: true, address: true },
  },
  {
    city: "Hoi An",
    name: "Japanese Covered Bridge",
    category: "sights",
    order: 0,
    sitelinks: 15,
    heritage: [],
    mentions: { YouTube: 4 },
    description:
      "The bridge was constructed in the early 1600s by the Japanese community, roughly 40 years before they left the city to return to Japan under the strict policy of sakoku enforced by the Tokugawa Shogunate, and renovated in 1986. Today, it's the symbol of Hoi An. Entry is one coupon, but it's possible to cross back and forth several times without meeting a ticket-checker. If your scruples bother you, leave a tribute for the pig statue or the dog statue standing guard at opposite ends of the bridge.",
    listing: { coords: true, wikidata: true, image: true, url: false, hours: false, price: false, address: false },
  },
  {
    city: "Hoi An",
    name: "Old house of Tan Ky",
    category: "sights",
    order: 10,
    sitelinks: 0,
    heritage: [],
    mentions: { YouTube: 3 },
    description:
      "As above, a younger member of the family will provide a cup of tea and a \"tour\" that doesn't stray from the front room of the house, as you'd need to step over sleeping members of the older generation to go anywhere else. The design of the house shows how local architecture incorporated Japanese and Chinese influences. Japanese elements include the crab shell-shaped ceiling supported by three beams in the living room. Chinese poems written in mother-of-pearl are hanging from a number of the columns that hold up the roof.",
    listing: { coords: true, wikidata: false, image: true, url: false, hours: false, price: false, address: true },
  },
  {
    city: "Hoi An",
    name: "An Bang Beach",
    category: "nature",
    order: 23,
    sitelinks: 0,
    heritage: [],
    mentions: { YouTube: 6 },
    description:
      "An Bang Beach is a relaxed stretch of coastline just a few kilometres north of Hoi An’s ancient town. Known for its soft white sand and relatively calm waters, it offers a quieter alternative to the busier nearby beaches, with a laid-back village atmosphere.",
    listing: { coords: true, wikidata: false, image: true, url: false, hours: false, price: false, address: false },
  },
  {
    city: "Hoi An",
    name: "Hoi An memories show",
    category: "nature",
    order: 21,
    sitelinks: 0,
    heritage: [],
    mentions: { YouTube: 1 },
    description:
      "A big musical-esque show on the history of Hoi An, from early settlers until the golden era as an important trading port. Huge stage, very good lighting effects and several hundred actors active at the same time. Situated on an island in the river. The whole island area surrounding the stage is a renaissance theme park with the same topic of the history of Hoi An. Leading up to the main show, there are mini-shows with reenactments and dance performances in different places around the theme park. Tickets can be bought when entering the island via the two bridges, or online (sometimes cheaper at Getyourguide or Klook due to promotions). Eco seats have a perfectly good view, no need for the higher classes. If possible, arrive at the main stage before 19:30 to queue for choosing a good seat.",
    listing: { coords: true, wikidata: false, image: false, url: true, hours: true, price: true, address: false },
  },
  {
    city: "Hoi An",
    name: "Night Market",
    category: "shopping",
    order: 32,
    sitelinks: 0,
    heritage: [],
    mentions: { YouTube: 7 },
    description:
      "Selling what night markets sell, overpriced finger food and local handiwork.",
    listing: { coords: true, wikidata: false, image: false, url: false, hours: false, price: false, address: false },
  },
  {
    city: "Hoi An",
    name: "Morning Market",
    category: "shopping",
    order: 31,
    sitelinks: 0,
    heritage: [],
    mentions: { YouTube: 4 },
    description: "Produce, fish, and meat at local prices.",
    listing: { coords: true, wikidata: false, image: true, url: false, hours: false, price: false, address: false },
  },
  {
    city: "Hoi An",
    name: "Central Market",
    category: "shopping",
    order: 29,
    sitelinks: 0,
    heritage: [],
    mentions: { YouTube: 1 },
    description: "Produce and other stuff. Beware of the more touristy prices.",
    listing: { coords: true, wikidata: false, image: true, url: false, hours: false, price: false, address: true },
  },
  {
    city: "Hoi An",
    name: "Nathan Tailors",
    category: "shopping",
    order: 33,
    sitelinks: 0,
    heritage: [],
    mentions: {},
    description:
      "Owner-operated by Linda, who trained at Blue Eye Tailor before opening her own shop. Men's and women's tailoring; she handles measurements and fittings personally. Suits from US$129, shirts from US$49. Walk-ins accepted, same-day for shirts and 2-3 days for suits. Also accepts remote orders for customers who want to re-order after returning home.",
    listing: { coords: true, wikidata: false, image: false, url: true, hours: true, price: true, address: true },
  },
  {
    city: "Hoi An",
    name: "White Rose",
    category: "food",
    order: 45,
    sitelinks: 0,
    heritage: [],
    mentions: { YouTube: 4 },
    description:
      "The shop that makes most of the \"white rose\" dumplings served all around town.",
    listing: { coords: true, wikidata: false, image: false, url: false, hours: true, price: true, address: true },
  },
  {
    city: "Hoi An",
    name: "Quan Cong Temple",
    category: "culture",
    order: 1,
    sitelinks: 0,
    heritage: [],
    mentions: { YouTube: 1 },
    description:
      "Founded in the 15th century, this temple is dedicated to Quan Cong, a Chinese general who is remembered and worshipped for his qualities of loyalty, integrity and justice. Statues of him and several others are inside the temple.",
    listing: { coords: true, wikidata: false, image: true, url: false, hours: false, price: false, address: true },
  },
  {
    city: "Hoi An",
    name: "Museum of Trade Ceramics",
    category: "culture",
    order: 6,
    sitelinks: 0,
    heritage: [],
    mentions: { YouTube: 1 },
    description:
      "The dusty, unlabeled displays of broken pottery are eminently forgettable, but the house itself is nice enough, and it provides a good opportunity to explore the shape and layout of an old Hoi An home.",
    listing: { coords: true, wikidata: false, image: true, url: false, hours: false, price: false, address: true },
  },
  {
    city: "Hoi An",
    name: "Dong Duong",
    category: "culture",
    order: 25,
    sitelinks: 4,
    heritage: [],
    mentions: {},
    description:
      "Ruined Cham tower, the sole major remnant of a large Buddhist Cham period (9th century, 875-915 under Indravarman II) temple-complex that was originally 155x326 m. Other minor remnants are also visible.",
    listing: { coords: false, wikidata: true, image: true, url: false, hours: false, price: false, address: false },
  },
  {
    city: "Hoi An",
    name: "Hoi An Silk Village",
    category: "activities",
    order: 22,
    sitelinks: 0,
    heritage: [],
    mentions: {},
    description:
      "Revived 300-year-old Champa silk traditions. Half day tours encompassing the entire silk process, from silkworms to dressmaking. Showroom in a converted Quang Nam-style house with 100 different ao dai, representing all of the 54 different minority groups in Vietnam. Also a spacious colonial-style restaurant serving local dishes and a silk showroom where professional tailors custom design and make garments for visitors.",
    listing: { coords: true, wikidata: false, image: false, url: true, hours: true, price: false, address: true },
  },
];

const CITIES: CityId[] = ["Kyoto", "Hoi An"];

/** The app's own taxonomy, src/data/categories.ts, in its own order. */
const CATEGORY_LABEL: Record<CategoryId, string> = {
  sights: "Sights & Landmarks",
  culture: "Museums & Culture",
  nature: "Nature & Outdoors",
  activities: "Activities & Tours",
  food: "Food",
  nightlife: "Nightlife & Drinks",
  shopping: "Shopping",
};
const CATEGORY_ORDER: CategoryId[] = [
  "sights", "culture", "nature", "activities", "food", "nightlife", "shopping",
];

// ---------------------------------------------------------------------------
// The model. scorePlace() + rankDestinations(), src/data/ranking.ts.
// ---------------------------------------------------------------------------

interface Toggles {
  sources: Record<Provider, boolean>;
  encyclopedic: boolean;
  heritage: boolean;
  prominence: boolean;
  feedback: boolean;
}

const ALL_ON: Toggles = {
  sources: {
    "Lonely Planet": true,
    Reddit: true,
    YouTube: true,
    "Travel Stack Exchange": true,
  },
  encyclopedic: true,
  heritage: true,
  prominence: true,
  feedback: true,
};

interface MentionRow {
  provider: Provider;
  count: number;
  weight: number;
  points: number;
  on: boolean;
}

type Basis = "evidence" | "unrated" | "demoted";

interface Scored {
  place: Place;
  /** Mention term. */
  rows: MentionRow[];
  rawWeighted: number;
  buzz: number;
  mentionMerit: number;
  /** Encyclopedic breadth. */
  encFrac: number;
  encMerit: number;
  /** Heritage designations. */
  heritageRaw: number;
  heritageMerit: number;
  isWorldHeritage: boolean;
  /** Prominence phrases found in the listing's own description. */
  promMatches: string[];
  promMerit: number;
  /** Traveller feedback, and the civic-name demotion. */
  overrideMerit: number;
  civicMerit: number;
  /** Outcome. */
  merit: number;
  score: number;
  basis: Basis;
  completeness: number;
  confidence: number;
  rank: number;
}

function scoreOne(
  p: Place,
  t: Toggles,
  overrides: Record<string, number>,
): Omit<Scored, "rank"> {
  let merit = 0;
  let hasEvidence = false;

  // --- mentions. computeBuzz(), then the ranker turns points into a fraction.
  const rows: MentionRow[] = PROVIDERS.map((pr) => {
    const count = p.mentions[pr.id] ?? 0;
    const on = t.sources[pr.id];
    return {
      provider: pr.id,
      count,
      weight: pr.weight,
      on,
      points: on ? count * pr.weight : 0,
    };
  });
  const rawWeighted = rows.reduce((s, r) => s + r.points, 0);
  const buzz = Math.min(BUZZ_CAP, rawWeighted);
  let mentionMerit = 0;
  if (buzz > 0) {
    mentionMerit = Math.min(1, buzz / Math.max(1, W.mentionFull)) * W.mentionMax;
    merit += mentionMerit;
    hasEvidence = true;
  }

  // --- encyclopedic breadth.
  const encFrac = t.encyclopedic ? encyclopedicFraction(p.sitelinks) : 0;
  let encMerit = 0;
  if (encFrac > 0) {
    encMerit = encFrac * W.encyclopedicMax;
    merit += encMerit;
    hasEvidence = true;
  }

  // --- official heritage designations.
  let heritageRaw = 0;
  let heritageMerit = 0;
  let isWorldHeritage = false;
  if (t.heritage && p.heritage.length) {
    isWorldHeritage = p.heritage.some((q) => WORLD_HERITAGE.has(q));
    heritageRaw = W.heritageAny + (p.heritage.length - 1) * W.heritageEach;
    if (isWorldHeritage) heritageRaw += W.heritageWorld;
    heritageMerit = Math.min(W.heritageMax, heritageRaw);
    merit += heritageMerit;
    hasEvidence = true;
  }

  // --- prominence phrases. Deliberately NOT counted as evidence on its own:
  // our own guidebook calling a place a highlight is not an outside source.
  const promMatches: string[] = [];
  let promMerit = 0;
  if (t.prominence && p.description) {
    for (const re of PROMINENCE_RES) {
      re.lastIndex = 0;
      const hits = p.description.match(re);
      if (hits) promMatches.push(...hits);
    }
    if (promMatches.length > 0) {
      promMerit = Math.min(
        W.notableKeywordCap,
        promMatches.length * W.notableKeywordBonus,
      );
      merit += promMerit;
    }
  }

  // --- direct traveller feedback.
  let overrideMerit = 0;
  if (t.feedback) {
    const o = overrides[normalizeName(p.name)];
    if (o) {
      overrideMerit = o;
      merit += o;
      hasEvidence = true;
    }
  }

  // --- applied last, so it outweighs whatever else argued for a civic building.
  let civicMerit = 0;
  if (looksCivic(p.name)) {
    civicMerit = -W.civicNamePenalty;
    merit += civicMerit;
  }

  // --- completeness. Computed, reported, labelled, and never added to merit.
  const l = p.listing;
  let completeness = 0;
  if (l.coords) completeness += W.hasCoordinates;
  if (l.wikidata) completeness += W.hasWikidata;
  if (l.image) completeness += W.hasImage;
  if (l.url) completeness += W.hasUrl;
  if (l.hours) completeness += W.hasHours;
  if (l.price) completeness += W.hasPrice;
  if (l.address) completeness += W.hasAddress;
  const descLen = p.description.length;
  if (descLen > 0) {
    completeness +=
      Math.min(1, descLen / Math.max(1, W.descriptionLengthChars)) *
      W.descriptionLengthMax;
  }

  return {
    place: p,
    rows,
    rawWeighted,
    buzz,
    mentionMerit,
    encFrac,
    encMerit,
    heritageRaw,
    heritageMerit,
    isWorldHeritage,
    promMatches,
    promMerit,
    overrideMerit,
    civicMerit,
    merit,
    score:
      merit > 0 ? Math.max(0, Math.min(100, Math.round((merit / MERIT_FULL) * 100))) : 0,
    basis: merit < 0 ? "demoted" : hasEvidence ? "evidence" : "unrated",
    completeness,
    confidence: Math.max(
      0,
      Math.min(100, Math.round((completeness / CONF_FULL) * 100)),
    ),
  };
}

/** TIER — evidence first, then the places we know nothing about, then demoted. */
const TIER: Record<Basis, number> = { evidence: 0, unrated: 1, demoted: 2 };

/**
 * compareForRank(). Evidence first, ordered by how much of it there is. Then
 * the unrated tail, ordered by how complete its listing is — which is NOT a
 * claim about merit. Article order is the final tie-break, purely for stability.
 */
function compareForRank(a: Scored, b: Scored): number {
  const ta = TIER[a.basis];
  const tb = TIER[b.basis];
  if (ta !== tb) return ta - tb;
  if (ta === 1) return b.confidence - a.confidence || a.place.order - b.place.order;
  return b.score - a.score || a.place.order - b.place.order;
}

/** rankDestinations(): rank is assigned WITHIN each category. */
function rankCity(city: CityId, t: Toggles): Scored[] {
  const places = PLACES.filter((p) => p.city === city);
  const overrides = resolveOverrides(
    places.map((p) => p.name),
    FEEDBACK_OVERRIDES,
  );
  const scored = places.map((p) => ({ ...scoreOne(p, t, overrides), rank: 0 }));

  const byCategory = new Map<CategoryId, Scored[]>();
  for (const s of scored) {
    const arr = byCategory.get(s.place.category) ?? [];
    arr.push(s);
    byCategory.set(s.place.category, arr);
  }
  for (const arr of byCategory.values()) {
    arr.sort(compareForRank);
    arr.forEach((s, i) => {
      s.rank = i + 1;
    });
  }
  return scored;
}

// ---------------------------------------------------------------------------
// Presentation.
// ---------------------------------------------------------------------------

const TERM_COLOR = {
  mention: "#5fc98d",
  encyclopedic: "#8fa8bc",
  heritage: "#d9764a",
  prominence: "#5d6873",
  feedbackUp: "#2e6b4e",
  negative: "#d4635c",
} as const;

const BASIS_STYLE: Record<Basis, { label: string; cls: string }> = {
  evidence: { label: "evidence", cls: "text-accent border-accent" },
  unrated: { label: "unrated", cls: "text-dim border-hair" },
  demoted: { label: "demoted", cls: "text-error border-hair" },
};

export function SourceRanking() {
  const [city, setCity] = useState<CityId>("Kyoto");
  const [toggles, setToggles] = useState<Toggles>(ALL_ON);
  const [open, setOpen] = useState<string | null>("Fushimi Inari Taisha");

  const ranked = useMemo(() => rankCity(city, toggles), [city, toggles]);
  const baseline = useMemo(() => rankCity(city, ALL_ON), [city]);

  const baseRank = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of baseline) m.set(s.place.name, s.rank);
    return m;
  }, [baseline]);

  /** Matched mentions per provider in this city — what a toggle actually has. */
  const supply = useMemo(() => {
    const m: Record<Provider, number> = {
      "Lonely Planet": 0, Reddit: 0, YouTube: 0, "Travel Stack Exchange": 0,
    };
    for (const p of PLACES) {
      if (p.city !== city) continue;
      for (const pr of PROVIDERS) m[pr.id] += p.mentions[pr.id] ?? 0;
    }
    return m;
  }, [city]);

  const groups = CATEGORY_ORDER.map((c) => ({
    category: c,
    items: ranked
      .filter((s) => s.place.category === c)
      .sort(compareForRank),
  })).filter((g) => g.items.length > 0);

  const rated = ranked.filter((s) => s.basis === "evidence").length;
  const dirty =
    PROVIDERS.some((pr) => !toggles.sources[pr.id]) ||
    !toggles.encyclopedic ||
    !toggles.heritage ||
    !toggles.prominence ||
    !toggles.feedback;

  const setSource = (id: Provider) =>
    setToggles((t) => ({
      ...t,
      sources: { ...t.sources, [id]: !t.sources[id] },
    }));

  const setTerm = (k: "encyclopedic" | "heritage" | "prominence" | "feedback") =>
    setToggles((t) => ({ ...t, [k]: !t[k] }));

  return (
    <section className="mt-10 rounded border border-hair bg-raised">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hair px-4 py-3">
        <h2 className="font-prose text-base font-semibold text-bright">
          Consensus ranking — take a source away
        </h2>
        <p className="font-mono text-xs text-dim">
          ported from src/data/ranking.ts + server/assemble.ts
        </p>
      </header>

      <div className="px-4 py-4">
        <p className="max-w-[64ch] text-sm text-muted">
          The guide never invents a recommendation. It counts how often real
          sources <span className="text-body">name</span> a place, weights each
          publisher, and ranks on the result. The score below is an{" "}
          <span className="text-body">absolute</span> percentage of the evidence
          a place could possibly carry &mdash; not a ratio to the best entry in
          this city &mdash; so 70 means the same thing in Kyoto and in Hoi An.
          Switch a publisher off and the order recomputes: that is the consensus
          mechanism, with nothing else holding it up.
        </p>

        {/* ---------------- city ---------------- */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {CITIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                setCity(c);
                setOpen(null);
              }}
              aria-pressed={city === c}
              className={`rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors ${
                city === c
                  ? "border-accent text-accent"
                  : "border-hair text-dim hover:border-muted hover:text-body"
              }`}
            >
              {c}
            </button>
          ))}
          <span className="font-mono text-xs text-faint">
            {rated}/{ranked.length} places carry evidence
          </span>
        </div>

        {/* ---------------- source toggles ---------------- */}
        <div className="mt-4 rounded border border-hair-soft bg-sunken p-3">
          <p className="font-mono text-[10px] uppercase tracking-wider text-faint">
            mention sources &mdash; BUZZ_WEIGHT, server/assemble.ts
          </p>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {PROVIDERS.map((pr) => {
              const on = toggles.sources[pr.id];
              const has = supply[pr.id] > 0;
              return (
                <button
                  key={pr.id}
                  type="button"
                  onClick={() => setSource(pr.id)}
                  aria-pressed={on}
                  className={`flex items-baseline gap-2 rounded-sm border px-2 py-1.5 text-left font-mono text-xs transition-colors ${
                    on
                      ? "border-hair bg-raised text-body hover:border-muted"
                      : "border-hair-soft text-faint hover:border-hair"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`mt-[3px] h-2 w-2 shrink-0 rounded-[1px] border ${
                      on ? "border-accent" : "border-faint"
                    }`}
                    style={on ? { background: TERM_COLOR.mention } : undefined}
                  />
                  <span className="min-w-0 flex-1 truncate">{pr.id}</span>
                  <span className={`tabular-nums ${on ? "text-accent" : ""}`}>
                    &times;{pr.weight}
                  </span>
                  <span className="w-[8.5rem] shrink-0 text-right text-[10px] text-faint">
                    {has ? `${supply[pr.id]} mentions matched` : "0 in this corpus"}
                  </span>
                </button>
              );
            })}
          </div>

          <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-faint">
            other evidence terms &mdash; RANKING_WEIGHTS
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <TermToggle
              on={toggles.encyclopedic}
              onClick={() => setTerm("encyclopedic")}
              color={TERM_COLOR.encyclopedic}
              label="Wikipedia breadth"
              weight="max 30"
            />
            <TermToggle
              on={toggles.heritage}
              onClick={() => setTerm("heritage")}
              color={TERM_COLOR.heritage}
              label="heritage designations"
              weight="max 30"
            />
            <TermToggle
              on={toggles.prominence}
              onClick={() => setTerm("prominence")}
              color={TERM_COLOR.prominence}
              label="prominence phrases"
              weight="max 12"
            />
            <TermToggle
              on={toggles.feedback}
              onClick={() => setTerm("feedback")}
              color={TERM_COLOR.feedbackUp}
              label="traveller feedback"
              weight="3 live"
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => setToggles(ALL_ON)}
              disabled={!dirty}
              className="rounded-sm border border-hair px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:border-muted hover:text-body disabled:cursor-default disabled:border-hair-soft disabled:text-faint disabled:hover:border-hair-soft"
            >
              restore every source
            </button>
            <span className="font-mono text-[10px] text-faint">
              {dirty
                ? "arrows show the move against the full-evidence order"
                : "all terms live — this is what the app ships"}
            </span>
          </div>
        </div>

        {/* ---------------- ranked list ---------------- */}
        <div className="mt-5 flex flex-col gap-5">
          {groups.map((g) => (
            <div key={g.category}>
              <h3 className="flex items-baseline gap-2 border-b border-hair-soft pb-1 font-mono text-[11px] uppercase tracking-wider text-muted">
                {CATEGORY_LABEL[g.category]}
                <span className="text-faint">{g.items.length}</span>
              </h3>
              <ol className="flex flex-col">
                {g.items.map((s) => (
                  <Row
                    key={s.place.name}
                    s={s}
                    delta={(baseRank.get(s.place.name) ?? s.rank) - s.rank}
                    showDelta={dirty}
                    open={open === s.place.name}
                    onToggle={() =>
                      setOpen((o) => (o === s.place.name ? null : s.place.name))
                    }
                  />
                ))}
              </ol>
            </div>
          ))}
        </div>

        {/* ---------------- the boundary ---------------- */}
        <div className="mt-6 border-t border-hair-soft pt-3">
          <p className="max-w-[66ch] font-mono text-[11px] leading-relaxed text-faint">
            <span className="text-dim">Where this demo stops.</span> Mining the
            sources is a networked server job &mdash; Wikivoyage parsing,
            Wikidata lookups, Lonely Planet, YouTube, Reddit and Travel Stack
            Exchange ingestion. This page ships a frozen sample of 28 places from
            the real Kyoto and Hoi An parses, with the mention counts that the
            real computeBuzz() produced over the project&rsquo;s cached corpus.
            Reddit fetched nothing for these two cities and Travel Stack Exchange
            matched no place names, so their weights are real and their supply
            here is zero. Everything from those counts onward &mdash; the
            weighting, the log curve, the caps, the tiers, the tie-breaks &mdash;
            is the shipped function.
          </p>
          <p className="mt-2 max-w-[66ch] font-mono text-[11px] leading-relaxed text-faint">
            <span className="text-dim">A ninth term is missing on purpose.</span>{" "}
            Position in the source article used to be the model&rsquo;s heaviest
            input. Wikivoyage&rsquo;s Kyoto article is ordered by district, not by
            merit: Kinkaku-ji is listing 178 and Fushimi Inari 226, while the
            bath house and the film-studio park sit at 1 and 2. It is
            anti-correlated with everything travellers say, so it now only breaks
            ties. The <span className="text-dim">ord</span> number on each row is
            that position &mdash; read it against the ranking.
          </p>
        </div>
      </div>
    </section>
  );
}

function TermToggle({
  on,
  onClick,
  color,
  label,
  weight,
}: {
  on: boolean;
  onClick: () => void;
  color: string;
  label: string;
  weight: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`flex items-baseline gap-2 rounded-sm border px-2 py-1 font-mono text-xs transition-colors ${
        on
          ? "border-hair bg-raised text-body hover:border-muted"
          : "border-hair-soft text-faint hover:border-hair"
      }`}
    >
      <span
        aria-hidden
        className={`h-2 w-2 shrink-0 rounded-[1px] border ${
          on ? "border-transparent" : "border-faint"
        }`}
        style={on ? { background: color } : undefined}
      />
      {label}
      <span className="text-faint">{weight}</span>
    </button>
  );
}

function Row({
  s,
  delta,
  showDelta,
  open,
  onToggle,
}: {
  s: Scored;
  delta: number;
  showDelta: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const basis = BASIS_STYLE[s.basis];
  return (
    <li className="border-b border-hair-soft last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 py-2 text-left transition-colors hover:bg-sunken"
      >
        <span className="w-5 shrink-0 text-right font-mono text-xs tabular-nums text-faint">
          {s.rank}
        </span>
        <span className="w-5 shrink-0 font-mono text-[10px] tabular-nums">
          {showDelta && delta !== 0 ? (
            <span className={delta > 0 ? "text-accent" : "text-warning"}>
              {delta > 0 ? "▲" : "▼"}
              {Math.abs(delta)}
            </span>
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-sm ${
              s.basis === "demoted" ? "text-dim line-through" : "text-body"
            }`}
          >
            {s.place.name}
          </span>
          <span className="mt-1 block">
            <ScoreBar s={s} />
          </span>
        </span>
        <span className="w-[4.25rem] shrink-0 text-right">
          {s.basis === "evidence" ? (
            <span className="font-mono text-sm tabular-nums text-bright">
              {s.score}
            </span>
          ) : (
            <span className="font-mono text-[10px] text-dim">
              {basis.label}
            </span>
          )}
          <span className="block font-mono text-[10px] tabular-nums text-faint">
            ord {s.place.order}
          </span>
        </span>
      </button>
      {open ? <Detail s={s} /> : null}
    </li>
  );
}

/** Each evidence term as a slice of the 110-point denominator. */
function ScoreBar({ s }: { s: Scored }) {
  const seg = [
    { v: s.mentionMerit, c: TERM_COLOR.mention },
    { v: s.encMerit, c: TERM_COLOR.encyclopedic },
    { v: s.heritageMerit, c: TERM_COLOR.heritage },
    { v: s.promMerit, c: TERM_COLOR.prominence },
    {
      v: Math.abs(s.overrideMerit) + Math.abs(s.civicMerit),
      c: s.overrideMerit + s.civicMerit >= 0
        ? TERM_COLOR.feedbackUp
        : TERM_COLOR.negative,
    },
  ].filter((x) => x.v > 0.01);

  return (
    <span className="flex h-1 w-full max-w-[22rem] gap-px overflow-hidden rounded-[1px] bg-sunken">
      {seg.map((x, i) => (
        <span
          key={i}
          style={{
            width: `${(x.v / MERIT_FULL) * 100}%`,
            background: x.c,
          }}
        />
      ))}
    </span>
  );
}

function Detail({ s }: { s: Scored }) {
  const active = s.rows.filter((r) => r.count > 0);
  return (
    <div className="mb-3 rounded border border-hair-soft bg-sunken px-3 py-3">
      <div className="scroll-x">
        <table className="w-full min-w-[30rem] border-collapse font-mono text-[11px]">
          <thead>
            <tr className="text-faint">
              <th className="w-[9rem] py-1 text-left font-normal">term</th>
              <th className="py-1 text-left font-normal">what the code read</th>
              <th className="w-[4rem] py-1 text-right font-normal">points</th>
            </tr>
          </thead>
          <tbody className="text-dim">
            <Term
              color={TERM_COLOR.mention}
              name="mentions"
              points={s.mentionMerit}
              dim={s.buzz === 0}
            >
              {active.length === 0 ? (
                <span className="text-faint">
                  no source in this corpus names it
                </span>
              ) : (
                <>
                  {active.map((r) => (
                    <span
                      key={r.provider}
                      className={`mr-2 inline-block ${
                        r.on ? "text-body" : "text-faint line-through"
                      }`}
                    >
                      {r.provider} {r.count}&times;{r.weight}={r.count * r.weight}
                    </span>
                  ))}
                  <span className="block pt-0.5 text-faint">
                    sum {s.rawWeighted}
                    {s.rawWeighted > BUZZ_CAP ? (
                      <span className="text-warning">
                        {" "}
                        &rarr; capped at BUZZ_CAP {BUZZ_CAP}
                      </span>
                    ) : null}{" "}
                    &rarr; {s.buzz}/{W.mentionFull} of full attestation &times;{" "}
                    {W.mentionMax}
                  </span>
                </>
              )}
            </Term>

            <Term
              color={TERM_COLOR.encyclopedic}
              name="encyclopedic"
              points={s.encMerit}
              dim={s.encMerit === 0}
            >
              {s.place.sitelinks <= W.encyclopedicFloor ? (
                <span className="text-faint">
                  {s.place.sitelinks} Wikipedia editions &mdash; at or below the
                  floor of {W.encyclopedicFloor}, earns nothing
                </span>
              ) : (
                <>
                  <span className="text-body">
                    {s.place.sitelinks} Wikipedia language editions
                  </span>
                  <span className="block pt-0.5 text-faint">
                    log curve between {W.encyclopedicFloor} and{" "}
                    {W.encyclopedicFull} &rarr; {(s.encFrac * 100).toFixed(1)}% of{" "}
                    {W.encyclopedicMax}
                  </span>
                </>
              )}
            </Term>

            <Term
              color={TERM_COLOR.heritage}
              name="heritage"
              points={s.heritageMerit}
              dim={s.heritageMerit === 0}
            >
              {s.place.heritage.length === 0 ? (
                <span className="text-faint">no Wikidata P1435 designation</span>
              ) : (
                <>
                  <span className="text-body">
                    {s.place.heritage.join(" · ")}
                  </span>
                  <span className="block pt-0.5 text-faint">
                    {W.heritageAny} any + {s.place.heritage.length - 1}&times;
                    {W.heritageEach} extra
                    {s.isWorldHeritage ? ` + ${W.heritageWorld} UNESCO` : ""} ={" "}
                    {s.heritageRaw}
                    {s.heritageRaw > W.heritageMax ? (
                      <span className="text-warning">
                        {" "}
                        &rarr; capped at {W.heritageMax}
                      </span>
                    ) : null}
                  </span>
                </>
              )}
            </Term>

            <Term
              color={TERM_COLOR.prominence}
              name="prominence"
              points={s.promMerit}
              dim={s.promMerit === 0}
            >
              {s.promMatches.length === 0 ? (
                <span className="text-faint">
                  no cue phrase in the listing&rsquo;s own description
                </span>
              ) : (
                <>
                  {s.promMatches.map((m, i) => (
                    <span
                      key={`${m}-${i}`}
                      className="mr-1 inline-block rounded-[1px] border border-hair px-1 text-body"
                    >
                      {m}
                    </span>
                  ))}
                  <span className="block pt-0.5 text-faint">
                    {s.promMatches.length}&times;{W.notableKeywordBonus}, ceiling{" "}
                    {W.notableKeywordCap} &mdash; small because the cue list is
                    mostly English
                  </span>
                </>
              )}
            </Term>

            {s.overrideMerit !== 0 ? (
              <Term
                color={
                  s.overrideMerit > 0
                    ? TERM_COLOR.feedbackUp
                    : TERM_COLOR.negative
                }
                name="feedback"
                points={s.overrideMerit}
                dim={false}
              >
                <span className={s.overrideMerit > 0 ? "text-accent" : "text-error"}>
                  a traveller told us directly
                </span>
                <span className="block pt-0.5 text-faint">
                  learned.json override on &ldquo;
                  {Object.keys(FEEDBACK_OVERRIDES).find(
                    (k) =>
                      normalizeName(s.place.name) === k ||
                      normalizeName(s.place.name).startsWith(k + " "),
                  )}
                  &rdquo;
                </span>
              </Term>
            ) : null}

            {s.civicMerit !== 0 ? (
              <Term
                color={TERM_COLOR.negative}
                name="civic name"
                points={s.civicMerit}
                dim={false}
              >
                <span className="text-error">
                  the NAME says civic or utility, not an attraction
                </span>
              </Term>
            ) : null}

            <tr className="border-t border-hair">
              <td className="py-1.5 pl-4 text-muted">merit</td>
              <td className="py-1.5 text-faint">
                {s.merit.toFixed(1)} / {MERIT_FULL} attainable
                {s.basis === "unrated" ? (
                  <span className="text-dim">
                    {" "}
                    &mdash; nothing outside names it, so it is not ranked on merit
                  </span>
                ) : null}
                {s.basis === "demoted" ? (
                  <span className="text-error">
                    {" "}
                    &mdash; net-negative, sorts below the places we know nothing
                    about
                  </span>
                ) : null}
              </td>
              <td className="py-1.5 text-right tabular-nums text-bright">
                {s.basis === "evidence" ? s.score : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="mt-2.5 border-t border-hair-soft pt-2 font-mono text-[10px] leading-relaxed text-faint">
        <span className="text-dim">confidence {s.confidence}</span> &mdash;{" "}
        {s.completeness.toFixed(1)}/{CONF_FULL} of our own listing filled in
        (photo {s.place.listing.image ? "yes" : "no"}, hours{" "}
        {s.place.listing.hours ? "yes" : "no"}, price{" "}
        {s.place.listing.price ? "yes" : "no"}, address{" "}
        {s.place.listing.address ? "yes" : "no"}, {s.place.description.length}{" "}
        chars of description). This number is a fact about our data, not about
        the place, so it is reported apart and is never added to the score. The
        model before this one was made almost entirely of it &mdash; the heaviest
        single term was whether Wikimedia happened to hold a photo.
      </p>
    </div>
  );
}

function Term({
  color,
  name,
  points,
  dim,
  children,
}: {
  color: string;
  name: string;
  points: number;
  dim: boolean;
  children: React.ReactNode;
}) {
  return (
    <tr className="align-top">
      <td className="py-1.5 pr-2">
        <span className="flex items-baseline gap-1.5">
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-[1px]"
            style={{ background: dim ? "transparent" : color, border: dim ? "1px solid #38424d" : undefined }}
          />
          <span className={dim ? "text-faint" : "text-muted"}>{name}</span>
        </span>
      </td>
      <td className="py-1.5 pr-2">{children}</td>
      <td
        className={`py-1.5 text-right tabular-nums ${
          points < 0 ? "text-error" : dim ? "text-faint" : "text-body"
        }`}
      >
        {points === 0 ? "—" : points > 0 ? `+${points.toFixed(1)}` : points.toFixed(1)}
      </td>
    </tr>
  );
}
