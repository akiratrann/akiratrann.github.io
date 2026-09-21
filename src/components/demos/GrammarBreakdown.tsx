"use client";

import { useEffect, useState, type ReactNode } from "react";

/*
  The hand-the-phone-over loop out of LingoBridge, running offline.

  The control flow is transcribed from the four Expo routes —
  app/app/index.tsx, phrase.tsx, listen.tsx and analysis.tsx — including the
  transitions that are easy to miss: setPhrase() clearing the previous answer
  (app/src/state.tsx), "Say this next" rebuilding a Phrase out of a suggested
  reply with four fields left empty, and the romanization gate that renders
  nothing at all for Latin-script targets.

  What is NOT ported, because it does not exist as code: the tokenisation.
  There is no tokeniser, no aligner and no morphology table in this repo. The
  word-by-word split, the glosses, the parts of speech, the lemmas and the
  grammar notes are all produced by a language model at request time, held in
  shape by the JSON Schema in server/src/schemas.ts — that schema is the only
  thing on the client's side of the line, and it is reproduced verbatim below.
  Nothing here calls a model, and nothing here pretends to be one: the three
  exchanges are fixed records, written by hand to the schema's shape, because
  LingoBridge persists nothing (README, "Known gaps") and so no response from
  a real run survived to be shipped.

  State is one immutable Session advanced by pure functions.
*/

/* ---- the contract, verbatim from server/src/schemas.ts ------------------ */

type Phrase = {
  target_text: string;
  romanization: string;
  translation: string;
  literal_gloss: string;
  register: "casual" | "neutral" | "polite" | "formal";
  pronunciation_tip: string;
  handoff_note: string;
  alternatives: {
    target_text: string;
    romanization: string;
    translation: string;
    when_to_use: string;
  }[];
};

type Token = {
  surface: string;
  romanization: string;
  lemma: string;
  pos: string;
  meaning: string;
  note: string;
};

type GrammarPoint = {
  title: string;
  explanation: string;
  example_target: string;
  example_translation: string;
};

type SuggestedReply = {
  target_text: string;
  romanization: string;
  translation: string;
  intent: string;
};

type Analysis = {
  corrected_text: string;
  romanization: string;
  translation: string;
  gist: string;
  tokens: Token[];
  grammar: GrammarPoint[];
  register: string;
  suggested_replies: SuggestedReply[];
};

/* ---- real data, verbatim from the server ------------------------------- */

type Language = {
  code: string;
  name: string;
  nativeName: string;
  script: "latin" | "non-latin";
  flag: string;
};

/** Four of the twenty in server/src/languages.ts. */
const LANGUAGES: Record<string, Language> = {
  "en-US": { code: "en-US", name: "English", nativeName: "English", script: "latin", flag: "🇺🇸" },
  "es-ES": { code: "es-ES", name: "Spanish", nativeName: "Español", script: "latin", flag: "🇪🇸" },
  "ja-JP": { code: "ja-JP", name: "Japanese", nativeName: "日本語", script: "non-latin", flag: "🇯🇵" },
  "ko-KR": { code: "ko-KR", name: "Korean", nativeName: "한국어", script: "non-latin", flag: "🇰🇷" },
};

type Topic = { id: string; title: string; emoji: string; blurb: string; prompts: string[] };

/** server/src/topics.ts, all six, unedited. The prompts are intents, not
 *  sentences — the model localizes them. */
const TOPICS: Topic[] = [
  {
    id: "directions",
    title: "Getting around",
    emoji: "🧭",
    blurb: "Streets, stations, and asking someone to point",
    prompts: [
      "Ask how to get to the train station from here",
      "Ask which platform this train leaves from",
      "Ask if this bus goes to the airport",
      "Ask how long it takes to walk there",
      "Ask them to show me on the map",
    ],
  },
  {
    id: "food",
    title: "Food & drink",
    emoji: "🍜",
    blurb: "Ordering, allergies, and asking what's good",
    prompts: [
      "Ask what they recommend here",
      "Say I can't eat pork and ask what's safe",
      "Ask what's in this dish",
      "Ask for the bill",
      "Ask if I can sit anywhere or if I should wait",
    ],
  },
  {
    id: "stay",
    title: "Where I'm staying",
    emoji: "🏨",
    blurb: "Check-in, keys, and things that broke",
    prompts: [
      "Ask what time check-out is",
      "Say the room key isn't working",
      "Ask if I can leave my bags here after checking out",
      "Ask for the wifi password",
    ],
  },
  {
    id: "shopping",
    title: "Buying things",
    emoji: "🛍️",
    blurb: "Prices, sizes, and paying",
    prompts: [
      "Ask how much this costs",
      "Ask if they take card",
      "Ask if they have this in a different size",
      "Ask if I can try it on",
    ],
  },
  {
    id: "trouble",
    title: "When something's wrong",
    emoji: "🆘",
    blurb: "Pharmacy, lost items, and getting help",
    prompts: [
      "Say I lost my phone and ask what to do",
      "Ask where the nearest pharmacy is",
      "Say I need a doctor",
      "Ask them to call the police",
      "Say I think I'm on the wrong train",
    ],
  },
  {
    id: "people",
    title: "Talking to people",
    emoji: "💬",
    blurb: "Small talk that goes somewhere",
    prompts: [
      "Ask what they'd do here if they had one day",
      "Say I'm learning the language and ask them to speak slowly",
      "Ask how to say this word correctly",
      "Ask where locals actually eat around here",
      "Thank someone properly for helping me",
    ],
  },
];

/* Speech rates from app/src/speech.ts — device voices, offline, no key. */
const RATE_NORMAL = 0.82;
const RATE_SLOW = 0.5;

/* Deployment constants: server/src/config.ts defaults and server/fly.toml. */
const STT_MODEL = "whisper-large-v3-turbo";
const STT_HOST = "https://api.groq.com/openai/v1";
const ANALYSIS_MODEL = "gemini-flash-latest";
const AUDIO_CAP_MB = 25;

/* ---- the three recorded exchanges -------------------------------------- */

type Exchange = {
  id: string;
  nativeCode: string;
  targetCode: string;
  topicId: string;
  /** One of the real TOPICS prompts, sent as `intent` to POST /api/phrase. */
  intent: string;
  phrase: Phrase;
  /** What Whisper returned, before the analysis step repaired it. */
  transcript: string;
  analysis: Analysis;
};

const EXCHANGES: Exchange[] = [
  {
    id: "ja-platform",
    nativeCode: "en-US",
    targetCode: "ja-JP",
    topicId: "directions",
    intent: "Ask which platform this train leaves from",
    phrase: {
      target_text: "この電車は何番線から出ますか？",
      romanization: "Kono densha wa nanban-sen kara demasu ka?",
      translation: "Which platform does this train leave from?",
      literal_gloss: "this train as-for what-number-track from departs ?",
      register: "polite",
      pronunciation_tip: "nanban-sen runs together as one word — not three.",
      handoff_note: "すみません。下のボタンを押して、お答えを話していただけますか。",
      alternatives: [
        {
          target_text: "この電車、何番線ですか？",
          romanization: "Kono densha, nanban-sen desu ka?",
          translation: "This train — which platform?",
          when_to_use: "Shorter and easier to read aloud, and the dropped particle is normal in speech.",
        },
        {
          target_text: "恐れ入りますが、この電車の乗り場を教えていただけますか。",
          romanization: "Osoreirimasu ga, kono densha no noriba o oshiete itadakemasu ka.",
          translation: "Excuse me — could you tell me where this train boards?",
          when_to_use: "At a staffed window, or when you have just interrupted someone.",
        },
      ],
    },
    transcript: "五番線です でも次のは特急なので追加料金がかかりますよ",
    analysis: {
      corrected_text: "五番線です。でも、次のは特急なので、追加料金がかかりますよ。",
      romanization: "Goban-sen desu. Demo, tsugi no wa tokkyū na node, tsuika ryōkin ga kakarimasu yo.",
      translation: "Platform five. But the next one is a limited express, so there's a surcharge.",
      gist: "Go to platform 5 — but the next train costs extra on top of your ticket. Ask where to buy the supplement, or wait for a local.",
      register:
        "Polite です・ます — the form station staff use with passengers. Answer in です・ます too. Keigo would be over-formal here and would sound like you are the one on duty.",
      tokens: [
        {
          surface: "五番線",
          romanization: "goban-sen",
          lemma: "番線",
          pos: "number + counter",
          meaning: "platform five",
          note: "番線 is the counter for numbered tracks. The number attaches straight to it — no particle, no word for “platform”.",
        },
        {
          surface: "です",
          romanization: "desu",
          lemma: "だ",
          pos: "polite copula",
          meaning: "it is",
          note: "A complete answer in Japanese can be one noun plus です. Nothing is missing here.",
        },
        {
          surface: "でも",
          romanization: "demo",
          lemma: "でも",
          pos: "conjunction",
          meaning: "but",
          note: "Sentence-initial “but”. This is the conversational one; けれども is its stiffer cousin.",
        },
        {
          surface: "次の",
          romanization: "tsugi no",
          lemma: "次",
          pos: "noun + linking の",
          meaning: "the next one",
          note: "の stands in for a noun you both already have in mind — 次の〔電車〕. Japanese drops the repeated word but keeps the particle.",
        },
        {
          surface: "は",
          romanization: "wa",
          lemma: "は",
          pos: "topic particle",
          meaning: "as for",
          note: "Contrast, not just topic: the next train as against the one just named. が there would lose the warning.",
        },
        {
          surface: "特急",
          romanization: "tokkyū",
          lemma: "特急",
          pos: "noun",
          meaning: "limited express",
          note: "A faster service class that costs more than the base fare.",
        },
        {
          surface: "なので",
          romanization: "na node",
          lemma: "だ",
          pos: "copula + reason ending",
          meaning: "because it is",
          note: "ので gives a reason. After a noun the copula surfaces as な — 特急だので is wrong.",
        },
        {
          surface: "追加料金",
          romanization: "tsuika ryōkin",
          lemma: "追加料金",
          pos: "compound noun",
          meaning: "surcharge",
          note: "",
        },
        {
          surface: "が",
          romanization: "ga",
          lemma: "が",
          pos: "subject particle",
          meaning: "—",
          note: "Marks what かかる applies to. With かかる the money is the subject; there is no “you” anywhere in the sentence.",
        },
        {
          surface: "かかります",
          romanization: "kakarimasu",
          lemma: "かかる",
          pos: "verb, polite",
          meaning: "is incurred",
          note: "かかる is what money and time do. Polite ます form, matching the です earlier.",
        },
        {
          surface: "よ",
          romanization: "yo",
          lemma: "よ",
          pos: "sentence-final particle",
          meaning: "just so you know",
          note: "Flags something the listener probably does not know yet. Friendly rather than pushy — without it the warning lands flat.",
        },
      ],
      grammar: [
        {
          title: "ので — because, softly",
          explanation:
            "ので ties a reason to what follows inside one sentence. It is gentler than から, which is why staff reach for it right before telling you something inconvenient. After a noun the copula becomes な: 特急なので.",
          example_target: "工事中なので、こちらは通れません。",
          example_translation: "It's under construction, so you can't get through this way.",
        },
        {
          title: "は does contrast as well as topic",
          explanation:
            "は says what the sentence is about, and quietly adds “this one, unlike the others”. 次のは sets the next train against the trains after it. Swap in が and you get a neutral introduction, losing the point of the sentence.",
          example_target: "これは大丈夫ですが、あれは有料です。",
          example_translation: "This one's fine, but that one costs money.",
        },
        {
          title: "Cost takes が, not を",
          explanation:
            "かかる means something is expended — money, time — and the thing spent is its subject. So it is 料金が, never 料金を. The charge simply happens; nobody is doing it to you.",
          example_target: "駅まで十分ぐらいかかります。",
          example_translation: "It takes about ten minutes to the station.",
        },
      ],
      suggested_replies: [
        {
          target_text: "特急券はどこで買えますか？",
          romanization: "Tokkyū-ken wa doko de kaemasu ka?",
          translation: "Where can I buy the express ticket?",
          intent: "deal with the surcharge",
        },
        {
          target_text: "次の普通電車は何時ですか？",
          romanization: "Tsugi no futsū densha wa nanji desu ka?",
          translation: "What time is the next local train?",
          intent: "avoid the surcharge",
        },
        {
          target_text: "すみません、もう一度ゆっくりお願いします。",
          romanization: "Sumimasen, mō ichido yukkuri onegaishimasu.",
          translation: "Sorry — once more, slowly please.",
          intent: "ask them to repeat",
        },
        {
          target_text: "ありがとうございます、助かりました。",
          romanization: "Arigatō gozaimasu, tasukarimashita.",
          translation: "Thank you — that helped.",
          intent: "thank them and go",
        },
      ],
    },
  },
  {
    id: "es-pork",
    nativeCode: "en-US",
    targetCode: "es-ES",
    topicId: "food",
    intent: "Say I can't eat pork and ask what's safe",
    phrase: {
      target_text: "No puedo comer cerdo. ¿Qué me recomienda que no lleve?",
      romanization: "",
      translation: "I can't eat pork. What would you recommend that doesn't have any?",
      literal_gloss: "not I-can to-eat pork. what me you-recommend that not it-carries?",
      register: "polite",
      pronunciation_tip: "In Spain the c in cerdo is a soft th; an s is understood everywhere.",
      handoff_note: "Disculpe, ¿podría pulsar el botón y contestarme en voz alta? Muchas gracias.",
      alternatives: [
        {
          target_text: "Soy alérgico al cerdo. ¿Qué platos puedo tomar?",
          romanization: "",
          translation: "I'm allergic to pork. Which dishes can I have?",
          when_to_use: "When it is medical. Alérgico is taken far more seriously than a preference.",
        },
        {
          target_text: "¿Este plato lleva cerdo?",
          romanization: "",
          translation: "Does this dish have pork in it?",
          when_to_use: "When you have already chosen something and only need to check it.",
        },
      ],
    },
    transcript: "el pollo al ajillo no lleva nada de cerdo pero el arroz lo hacemos con caldo de jamón",
    analysis: {
      corrected_text:
        "El pollo al ajillo no lleva nada de cerdo, pero el arroz lo hacemos con caldo de jamón.",
      romanization: "",
      translation:
        "The garlic chicken has no pork in it at all, but we make the rice with ham stock.",
      gist: "The chicken is safe, the rice is not. Order the chicken and ask for a different side.",
      register:
        "Ordinary service register — friendly, not formal. Nothing in the reply addresses you directly, so there is no tú/usted signal to copy; stay with usted with someone you have just met and you cannot be wrong.",
      tokens: [
        {
          surface: "El pollo",
          romanization: "",
          lemma: "pollo",
          pos: "noun phrase",
          meaning: "the chicken",
          note: "",
        },
        {
          surface: "al ajillo",
          romanization: "",
          lemma: "ajillo",
          pos: "fixed phrase",
          meaning: "in garlic sauce",
          note: "al = a + el. A set preparation — garlic, oil, chilli — not a literal “to the little garlic”.",
        },
        {
          surface: "no",
          romanization: "",
          lemma: "no",
          pos: "negator",
          meaning: "not",
          note: "Spanish negates by putting no immediately before the verb. Nothing else moves.",
        },
        {
          surface: "lleva",
          romanization: "",
          lemma: "llevar",
          pos: "verb, 3rd singular",
          meaning: "contains",
          note: "Literally “carries”. For food this is the ordinary word for what is in a dish, and it agrees with the dish, not with you.",
        },
        {
          surface: "nada de",
          romanization: "",
          lemma: "nada",
          pos: "quantifier",
          meaning: "not a bit of",
          note: "Pairs with the earlier no. Together they mean “none whatsoever” — stronger than plain no lleva cerdo.",
        },
        {
          surface: "cerdo",
          romanization: "",
          lemma: "cerdo",
          pos: "noun",
          meaning: "pork",
          note: "",
        },
        {
          surface: "pero",
          romanization: "",
          lemma: "pero",
          pos: "conjunction",
          meaning: "but",
          note: "",
        },
        {
          surface: "el arroz",
          romanization: "",
          lemma: "arroz",
          pos: "noun phrase, fronted",
          meaning: "the rice",
          note: "Moved ahead of the verb to put it under the spotlight. Neutral order would be hacemos el arroz con…",
        },
        {
          surface: "lo",
          romanization: "",
          lemma: "lo",
          pos: "object pronoun",
          meaning: "it",
          note: "Points back at el arroz. When the object is fronted, Spanish repeats it as a pronoun — the doubling is required, not sloppy.",
        },
        {
          surface: "hacemos",
          romanization: "",
          lemma: "hacer",
          pos: "verb, 1st plural",
          meaning: "we make",
          note: "“We” is the kitchen, not the speaker personally.",
        },
        {
          surface: "con caldo de jamón",
          romanization: "",
          lemma: "caldo",
          pos: "prepositional phrase",
          meaning: "with ham stock",
          note: "jamón is pork. This is the half of the sentence that matters to you.",
        },
      ],
      grammar: [
        {
          title: "llevar is the ingredient verb",
          explanation:
            "Ask what a dish lleva rather than what it tiene. It is what menus and waiters use for what is inside something, and it is what will come back at you. It agrees with the dish: lleva for one, llevan for several.",
          example_target: "¿Lleva frutos secos?",
          example_translation: "Does it have nuts in it?",
        },
        {
          title: "The double negative is the correct form",
          explanation:
            "Spanish keeps no before the verb even when a negative word follows. No lleva nada de cerdo is not “doesn't have nothing” — it is the standard emphatic “has no pork at all”. Dropping the no is the actual mistake.",
          example_target: "No hay nadie en la cocina.",
          example_translation: "There's nobody in the kitchen.",
        },
        {
          title: "Fronted object, doubled pronoun",
          explanation:
            "Putting the object first is how Spanish emphasises it, and then the object is echoed by a pronoun before the verb: el arroz lo hacemos. Hearing that extra lo is your clue that what came before it is the object, not the subject.",
          example_target: "El pescado lo traen de Galicia.",
          example_translation: "The fish, they bring in from Galicia.",
        },
      ],
      suggested_replies: [
        {
          target_text: "Entonces el pollo, pero con patatas en vez de arroz.",
          romanization: "",
          translation: "The chicken then, but with potatoes instead of rice.",
          intent: "take the safe dish, swap the side",
        },
        {
          target_text: "¿Hay algún plato sin cerdo que no lleve arroz?",
          romanization: "",
          translation: "Is there a pork-free dish that doesn't come with rice?",
          intent: "ask for another option",
        },
        {
          target_text: "Perdone, ¿puede repetirlo más despacio?",
          romanization: "",
          translation: "Sorry, could you say that again more slowly?",
          intent: "ask them to repeat",
        },
      ],
    },
  },
  {
    id: "ko-bags",
    nativeCode: "en-US",
    targetCode: "ko-KR",
    topicId: "stay",
    intent: "Ask if I can leave my bags here after checking out",
    phrase: {
      target_text: "체크아웃한 뒤에 여기에 짐을 맡길 수 있을까요?",
      romanization: "Chekeuaut-han dwie yeogie jimeul matgil su isseulkkayo?",
      translation: "Could I leave my bags here after I check out?",
      literal_gloss: "check-out-did after here-at luggage-OBJ entrust possibility would-there-be?",
      register: "polite",
      pronunciation_tip: "맡길 comes out as mat-kil — the ㅌ hardens the ㄱ behind it.",
      handoff_note: "죄송하지만 아래 버튼을 누르고 대답을 말씀해 주시겠어요?",
      alternatives: [
        {
          target_text: "짐 좀 맡아 주실 수 있나요?",
          romanization: "Jim jom mata jusil su innayo?",
          translation: "Could you look after my bags?",
          when_to_use: "Asks them to do it for you rather than asking permission. Warmer, and harder to refuse.",
        },
        {
          target_text: "짐 보관 서비스가 있나요?",
          romanization: "Jim bogwan seobiseu-ga innayo?",
          translation: "Do you have a luggage storage service?",
          when_to_use: "At a larger hotel, where you expect the answer to be a desk rather than a favour.",
        },
      ],
    },
    transcript: "네 프런트 옆에 보관함이 있으니까 거기에 두시면 됩니다 여섯시까지는 찾아가셔야 해요",
    analysis: {
      corrected_text:
        "네, 프런트 옆에 보관함이 있으니까 거기에 두시면 됩니다. 여섯 시까지는 찾아가셔야 해요.",
      romanization:
        "Ne, peureonteu yeope bogwanhami isseunikka geogie dusimyeon doemnida. Yeoseot si-kkajineun chajagasyeoya haeyo.",
      translation:
        "Yes — there's a locker next to the front desk, so you can just leave them there. You'll need to collect them by six.",
      gist: "Yes, and it is self-service: put the bags in the locker by reception and be back for them before six.",
      register:
        "Polite, opening formal (됩니다) and easing into the warmer 해요 form. Front-desk standard. Answer in 해요 — 네, 알겠습니다 / 감사합니다 — and do not attach 시 to your own verbs.",
      tokens: [
        {
          surface: "네",
          romanization: "ne",
          lemma: "네",
          pos: "interjection",
          meaning: "yes",
          note: "",
        },
        {
          surface: "프런트 옆에",
          romanization: "peureonteu yeope",
          lemma: "옆",
          pos: "noun + location particle",
          meaning: "next to the front desk",
          note: "에 marks a static location. 프런트 is the loanword Korean hotels use for reception.",
        },
        {
          surface: "보관함이",
          romanization: "bogwanhami",
          lemma: "보관함",
          pos: "noun + subject particle",
          meaning: "a storage locker",
          note: "이 is the subject particle after a consonant; 가 after a vowel. Same particle, chosen by sound.",
        },
        {
          surface: "있으니까",
          romanization: "isseunikka",
          lemma: "있다",
          pos: "verb + reason ending",
          meaning: "since there is",
          note: "-으니까 gives a reason and is allowed before an instruction or request, which is exactly what follows. -아서 would not be.",
        },
        {
          surface: "거기에",
          romanization: "geogie",
          lemma: "거기",
          pos: "pronoun + particle",
          meaning: "there",
          note: "",
        },
        {
          surface: "두시면",
          romanization: "dusimyeon",
          lemma: "두다",
          pos: "verb + honorific + conditional",
          meaning: "if you leave them",
          note: "두다 “to put”, plus the honorific 시 raising you, plus 면 “if”. The 시 is about the person doing the verb — you.",
        },
        {
          surface: "됩니다",
          romanization: "doemnida",
          lemma: "되다",
          pos: "verb, formal polite",
          meaning: "that will do",
          note: "-면 되다 together mean “it is enough to just…”. 합니다 endings are the crisp formal register staff open with.",
        },
        {
          surface: "여섯 시까지는",
          romanization: "yeoseot si-kkajineun",
          lemma: "여섯 시",
          pos: "time + 까지 + 는",
          meaning: "by six o'clock",
          note: "까지 is “by/until”; the extra 는 adds contrast — by six, whatever else happens.",
        },
        {
          surface: "찾아가셔야",
          romanization: "chajagasyeoya",
          lemma: "찾아가다",
          pos: "verb + honorific + obligation",
          meaning: "have to come and get them",
          note: "찾아가다 is “go and retrieve”, the normal verb for collecting something you left. -셔야 is 시 again, contracted, plus -어야 “must”.",
        },
        {
          surface: "해요",
          romanization: "haeyo",
          lemma: "하다",
          pos: "auxiliary, polite",
          meaning: "must",
          note: "-어야 해요 is the ordinary “have to”. Dropping from 합니다 to 해요 is not less polite, just warmer.",
        },
      ],
      grammar: [
        {
          title: "-(으)면 되다 — “just do that and you're fine”",
          explanation:
            "Attach -면 to a verb and follow it with 되다 and you get the friendliest instruction Korean has: doing this much is sufficient. Staff use it constantly to hand you the easy version of a procedure.",
          example_target: "여기에 이름만 쓰시면 됩니다.",
          example_translation: "You just need to write your name here.",
        },
        {
          title: "-아/어야 하다 — obligation",
          explanation:
            "The everyday “have to”. The main verb takes -아야/-어야 and 하다 carries the tense and the politeness. Slip 시 in before it when the obligation is someone else's, as this speaker did to you.",
          example_target: "내일 아침에 체크아웃하셔야 해요.",
          example_translation: "You have to check out tomorrow morning.",
        },
        {
          title: "시 honours whoever does the verb",
          explanation:
            "The infix 시 raises the subject of its own verb, not the person you are talking to. Here you are the one putting and collecting, so 두시면 and 찾아가셔야 carry it. Attaching it to your own actions is the classic beginner slip.",
          example_target: "사장님이 지금 오십니다.",
          example_translation: "The manager is on her way now.",
        },
      ],
      suggested_replies: [
        {
          target_text: "네, 알겠습니다. 감사합니다.",
          romanization: "Ne, algesseumnida. Gamsahamnida.",
          translation: "Yes, understood. Thank you.",
          intent: "accept and close",
        },
        {
          target_text: "여섯 시 넘으면 어떻게 해요?",
          romanization: "Yeoseot si neomeumyeon eotteoke haeyo?",
          translation: "What if I'm later than six?",
          intent: "check the edge case",
        },
        {
          target_text: "죄송한데 천천히 다시 말씀해 주시겠어요?",
          romanization: "Joesonghande cheoncheonhi dasi malsseumhae jusigesseoyo?",
          translation: "Sorry — could you say that again slowly?",
          intent: "ask them to repeat",
        },
      ],
    },
  },
];

/* ---- the machine ------------------------------------------------------- */

type Stage = "compose" | "speak" | "handover" | "listen" | "reply" | "breakdown";

const STAGES: { key: Stage; label: string; source: string }[] = [
  { key: "compose", label: "compose", source: "app/index.tsx" },
  { key: "speak", label: "speak", source: "app/phrase.tsx" },
  { key: "handover", label: "hand over", source: "app/listen.tsx" },
  { key: "listen", label: "listen", source: "app/listen.tsx" },
  { key: "reply", label: "reply", source: "POST /api/listen" },
  { key: "breakdown", label: "breakdown", source: "app/analysis.tsx" },
];

/** The two transitions that leave the device. Everything else is local. */
const NETWORK_AFTER: Stage[] = ["compose", "listen"];

type Session = {
  exchange: number;
  stage: Stage;
  /** Set only by "Say this next", which rebuilds a Phrase out of a reply. */
  promoted: Phrase | null;
  openTopic: string | null;
  /** An intent with no recorded response — the request that would have gone out. */
  blocked: string | null;
  showAlternatives: boolean;
  openToken: number | null;
  /** null when not recording. app/listen.tsx reads this off the recorder. */
  recordingMs: number | null;
};

const freshSession = (exchange: number): Session => ({
  exchange,
  stage: "compose",
  promoted: null,
  openTopic: EXCHANGES[exchange].topicId,
  blocked: null,
  showAlternatives: false,
  openToken: null,
  recordingMs: null,
});

const exchangeOf = (s: Session) => EXCHANGES[s.exchange];
const phraseOf = (s: Session) => s.promoted ?? exchangeOf(s).phrase;
const targetOf = (s: Session) => LANGUAGES[exchangeOf(s).targetCode];
const nativeOf = (s: Session) => LANGUAGES[exchangeOf(s).nativeCode];

/** Moving between routes clears the per-screen bits, as unmounting does. */
function go(s: Session, stage: Stage): Session {
  return {
    ...s,
    stage,
    blocked: null,
    openToken: stage === "breakdown" ? s.openToken : null,
    showAlternatives: stage === "speak" ? s.showAlternatives : false,
    recordingMs: stage === "listen" ? 0 : null,
  };
}

/**
 * index.tsx generate(): every prompt POSTs /api/phrase. Three intents have a
 * recorded response; the rest can only show the request they would send.
 */
function submitIntent(s: Session, intent: string): Session {
  const match = EXCHANGES.findIndex((e) => e.intent === intent);
  if (match === -1) return { ...s, blocked: intent };
  return go({ ...freshSession(match), openTopic: s.openTopic }, "speak");
}

/**
 * analysis.tsx, the "Say this next" button: a suggested reply becomes the next
 * Phrase with four fields the model never produced left empty — including the
 * handoff note, which is why the next hand-over screen has nothing to show the
 * other person. setPhrase() also drops the analysis, so the loop starts clean.
 */
function sayThisNext(s: Session, reply: SuggestedReply): Session {
  return go(
    {
      ...s,
      promoted: {
        target_text: reply.target_text,
        romanization: reply.romanization,
        translation: reply.translation,
        literal_gloss: "",
        register: "polite",
        pronunciation_tip: "",
        handoff_note: "",
        alternatives: [],
      },
    },
    "speak",
  );
}

/** listen.tsx: durationMillis → m:ss. */
function timerLabel(durationMillis: number): string {
  const seconds = Math.floor(durationMillis / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/* ---- component --------------------------------------------------------- */

export function GrammarBreakdown() {
  const [s, setS] = useState<Session>(() => freshSession(0));

  const recording = s.recordingMs !== null && s.stage === "listen" && s.recordingMs > 0;

  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(
      () => setS((prev) => (prev.recordingMs === null ? prev : { ...prev, recordingMs: prev.recordingMs + 100 })),
      100,
    );
    return () => window.clearInterval(id);
  }, [recording]);

  const exchange = exchangeOf(s);
  const target = targetOf(s);
  const native = nativeOf(s);
  const phrase = phraseOf(s);
  const stageIndex = STAGES.findIndex((st) => st.key === s.stage);

  return (
    <section className="mt-10 rounded border border-hair bg-raised">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hair px-4 py-3">
        <h2 className="font-prose text-base font-semibold text-bright">
          Hand it over — playable
        </h2>
        <p className="font-mono text-xs text-dim">ported from app/app/*.tsx + schemas.ts</p>
      </header>

      <div className="px-4 py-4">
        <p className="max-w-[62ch] text-sm text-muted">
          Speech recognition and the grammar analysis both need the network, so what
          runs here is everything else: the hand-over state machine, the render rules,
          and the shape the model&rsquo;s answer has to arrive in. Pick an intent, walk
          it round the loop, then tap the words in their reply.
        </p>

        {/* ---- exchange picker ---- */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-faint">recorded exchange</span>
          {EXCHANGES.map((e, i) => {
            const lang = LANGUAGES[e.targetCode];
            const on = i === s.exchange;
            return (
              <button
                key={e.id}
                type="button"
                aria-pressed={on}
                onClick={() => setS(freshSession(i))}
                className={`rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors ${
                  on
                    ? "border-accent text-accent"
                    : "border-hair text-dim hover:border-muted hover:text-body"
                }`}
              >
                {lang.flag} {lang.name}
              </button>
            );
          })}
        </div>

        {/* ---- the machine ---- */}
        <div className="mt-4 overflow-x-auto">
          <ol className="flex min-w-max items-stretch gap-1.5">
            {STAGES.map((st, i) => {
              const done = i < stageIndex;
              const here = i === stageIndex;
              return (
                <li key={st.key} className="flex items-stretch gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setS((prev) =>
                        // A promoted phrase has no recorded answer, so the strip
                        // stops at the hop that would have fetched one.
                        go(prev, st.key === "breakdown" && prev.promoted ? "reply" : st.key),
                      )
                    }
                    aria-current={here ? "step" : undefined}
                    className={`rounded-sm border px-2.5 py-1.5 text-left font-mono text-xs transition-colors ${
                      here
                        ? "border-accent text-accent"
                        : done
                          ? "border-hair-soft text-muted hover:border-muted"
                          : "border-hair-soft text-faint hover:border-hair hover:text-dim"
                    }`}
                  >
                    <span className="tabular-nums">{i + 1}</span> {st.label}
                    <span className="mt-0.5 block text-[10px] text-faint">{st.source}</span>
                  </button>
                  {i < STAGES.length - 1 && (
                    <span className="flex flex-col justify-center px-0.5 text-center font-mono text-[10px] leading-tight">
                      {NETWORK_AFTER.includes(st.key) ? (
                        <span className="text-warning" title="this transition leaves the device">
                          →<br />net
                        </span>
                      ) : (
                        <span className="text-faint">→</span>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>

        {/* ---- the current screen ---- */}
        <div className="mt-4 rounded border border-hair-soft bg-sunken p-4">
          {s.stage === "compose" && (
            <Compose
              session={s}
              onToggleTopic={(id) =>
                setS((prev) => ({ ...prev, openTopic: prev.openTopic === id ? null : id, blocked: null }))
              }
              onIntent={(intent) => setS((prev) => submitIntent(prev, intent))}
            />
          )}

          {s.stage === "speak" && (
            <Speak
              phrase={phrase}
              target={target}
              promoted={s.promoted !== null}
              showAlternatives={s.showAlternatives}
              onToggleAlternatives={() =>
                setS((prev) => ({ ...prev, showAlternatives: !prev.showAlternatives }))
              }
              onHandOver={() => setS((prev) => go(prev, "handover"))}
            />
          )}

          {s.stage === "handover" && (
            <HandOver
              phrase={phrase}
              target={target}
              onTapMic={() => setS((prev) => go(prev, "listen"))}
            />
          )}

          {s.stage === "listen" && (
            <Listen
              millis={s.recordingMs ?? 0}
              onStart={() => setS((prev) => ({ ...prev, recordingMs: 1 }))}
              onStop={() => setS((prev) => go(prev, "reply"))}
            />
          )}

          {s.stage === "reply" && (
            <ReplyHop
              exchange={exchange}
              target={target}
              native={native}
              promoted={s.promoted !== null}
              onReveal={() => setS((prev) => go(prev, "breakdown"))}
              onRestart={() => setS(freshSession(s.exchange))}
            />
          )}

          {s.stage === "breakdown" && (
            <Breakdown
              analysis={exchange.analysis}
              target={target}
              openToken={s.openToken}
              onToken={(i) =>
                setS((prev) => ({ ...prev, openToken: prev.openToken === i ? null : i }))
              }
              onStillTalking={() => setS((prev) => go(prev, "listen"))}
              onSayThisNext={(reply) => setS((prev) => sayThisNext(prev, reply))}
              onStartOver={() => setS(freshSession(s.exchange))}
            />
          )}
        </div>

        <p className="mt-4 max-w-[62ch] text-sm text-muted">
          The breakdown is the part of the product worth building, and it is the part
          that is not code. Every gloss, part of speech, lemma and note on this page is
          a field of <Mono>analysisSchema</Mono> in <Mono>server/src/schemas.ts</Mono>,
          filled at request time by{" "}
          <span className="text-body">{ANALYSIS_MODEL}</span> under a strict JSON Schema
          — so the app never parses prose, but it also never tokenises anything itself.
        </p>

        {/* The data on this page is not captured output, and saying so plainly
            matters more than the demo looking complete. */}
        <p className="mt-3 max-w-[62ch] border-l-2 border-warning pl-3 text-sm text-muted">
          <span className="font-mono text-xs uppercase tracking-[0.12em] text-warning">
            note
          </span>{" "}
          LingoBridge persists nothing, so no real response survived to be shipped
          here. These three exchanges were written by hand to the schema&rsquo;s exact
          shape — the state machine, the schema and the render rules are ported from
          the app, but the glosses themselves are illustrative rather than a record
          of what the model returned.
        </p>
      </div>
    </section>
  );
}

/* ---- screens ----------------------------------------------------------- */

function Compose({
  session,
  onToggleTopic,
  onIntent,
}: {
  session: Session;
  onToggleTopic: (id: string) => void;
  onIntent: (intent: string) => void;
}) {
  const recorded = new Set(EXCHANGES.map((e) => e.intent));
  const native = LANGUAGES[exchangeOf(session).nativeCode];
  const target = LANGUAGES[exchangeOf(session).targetCode];

  return (
    <div>
      <ScreenHead
        title="What do you need to say?"
        note="Topics are intents, not sentences — the model localizes them per language pair."
      />

      <div className="mt-3 flex items-center gap-3 rounded-sm border border-hair px-3 py-2">
        <div className="min-w-0">
          <p className="font-mono text-[10px] text-faint">I speak</p>
          <p className="truncate text-sm text-body">
            {native.flag} {native.name}
          </p>
        </div>
        <span className="font-mono text-xs text-faint">→</span>
        <div className="min-w-0 text-right">
          <p className="font-mono text-[10px] text-faint">They speak</p>
          <p className="truncate text-sm text-note">
            {target.nativeName} {target.flag}
          </p>
        </div>
      </div>

      <ul className="mt-3 flex flex-col gap-1.5">
        {TOPICS.map((topic) => {
          const open = session.openTopic === topic.id;
          const hasRecorded = topic.prompts.some((p) => recorded.has(p));
          return (
            <li key={topic.id} className="rounded-sm border border-hair-soft">
              <button
                type="button"
                onClick={() => onToggleTopic(topic.id)}
                aria-expanded={open}
                className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-raised"
              >
                <span aria-hidden className="text-lg">
                  {topic.emoji}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-body">{topic.title}</span>
                  <span className="block font-mono text-[10px] text-faint">{topic.blurb}</span>
                </span>
                {hasRecorded && (
                  <span className="font-mono text-[10px] text-accent">recorded</span>
                )}
                <span aria-hidden className="w-4 text-center font-mono text-sm text-dim">
                  {open ? "−" : "+"}
                </span>
              </button>

              {open && (
                <ul className="border-t border-hair-soft">
                  {topic.prompts.map((prompt) => {
                    const live = recorded.has(prompt);
                    return (
                      <li key={prompt}>
                        <button
                          type="button"
                          onClick={() => onIntent(prompt)}
                          className={`w-full border-t border-hair-soft px-3 py-2 text-left text-sm transition-colors first:border-t-0 ${
                            live
                              ? "text-accent hover:bg-raised"
                              : "text-dim hover:bg-raised hover:text-muted"
                          }`}
                        >
                          {prompt}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {session.blocked && (
        <div className="mt-3 rounded-sm border border-warning/40 p-3">
          <p className="font-mono text-[10px] text-warning">needs the model</p>
          <div className="mt-1.5 overflow-x-auto">
            <pre className="min-w-max font-mono text-xs text-body">
              {`POST /api/phrase\n${JSON.stringify(
                {
                  nativeCode: native.code,
                  targetCode: target.code,
                  intent: session.blocked,
                },
                null,
                2,
              )}`}
            </pre>
          </div>
          <p className="mt-2 text-sm text-muted">
            That request is exactly what the app would send. Three intents have a
            recorded answer and are lit in jade; the other twenty-five would have to be
            generated, in whichever of the twenty languages you had picked.
          </p>
        </div>
      )}
    </div>
  );
}

function Speak({
  phrase,
  target,
  promoted,
  showAlternatives,
  onToggleAlternatives,
  onHandOver,
}: {
  phrase: Phrase;
  target: Language;
  promoted: boolean;
  showAlternatives: boolean;
  onToggleAlternatives: () => void;
  onHandOver: () => void;
}) {
  return (
    <div>
      <ScreenHead
        title="You say"
        note={
          promoted
            ? "Built locally from a suggested reply — no model call, and no fields beyond the three it had."
            : "Returned by POST /api/phrase under phraseSchema."
        }
      />

      <p className="mt-3 text-2xl leading-snug text-bright" lang={target.code}>
        {phrase.target_text}
      </p>
      {phrase.romanization ? (
        <p className="mt-1 font-mono text-xs text-dim">{phrase.romanization}</p>
      ) : null}
      <p className="mt-2 text-sm text-muted">{phrase.translation}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Pill>{phrase.register}</Pill>
        <span className="font-mono text-[10px] text-faint">
          device TTS · rate {RATE_NORMAL.toFixed(2)}
        </span>
        <span className="font-mono text-[10px] text-faint">
          slow {RATE_SLOW.toFixed(2)}
        </span>
        <span className="font-mono text-[10px] text-accent">offline</span>
      </div>
      {phrase.pronunciation_tip ? (
        <p className="mt-2 text-sm text-muted">{phrase.pronunciation_tip}</p>
      ) : null}

      {target.script === "latin" && (
        <p className="mt-3 border-l-2 border-hair pl-3 font-mono text-[11px] text-faint">
          {target.name} is Latin script, so the prompt orders an empty string for every
          romanization field and the UI renders none. One rule, held at three layers:
          prompts.ts, schemas.ts, and the render.
        </p>
      )}

      <div className="mt-4 border-t border-hair-soft pt-3">
        <p className="font-mono text-[10px] text-faint">built from</p>
        {phrase.literal_gloss ? (
          <p className="mt-1 text-sm italic text-body">{phrase.literal_gloss}</p>
        ) : (
          <p className="mt-1 text-sm text-dim">
            empty — a promoted reply never had a gloss generated for it
          </p>
        )}
      </div>

      {phrase.alternatives.length > 0 ? (
        <div className="mt-4">
          <button
            type="button"
            onClick={onToggleAlternatives}
            aria-expanded={showAlternatives}
            className="font-mono text-xs text-dim underline underline-offset-4 transition-colors hover:text-body"
          >
            {showAlternatives ? "Hide" : "Show"} other ways to say it (
            {phrase.alternatives.length})
          </button>

          {showAlternatives && (
            <ul className="mt-2 flex flex-col gap-2">
              {phrase.alternatives.map((alt) => (
                <li key={alt.target_text} className="rounded-sm border border-hair-soft p-3">
                  <p className="text-base text-bright" lang={target.code}>
                    {alt.target_text}
                  </p>
                  {alt.romanization ? (
                    <p className="mt-0.5 font-mono text-xs text-dim">{alt.romanization}</p>
                  ) : null}
                  <p className="mt-1 text-sm text-muted">{alt.translation}</p>
                  <p className="mt-1 font-mono text-[11px] text-faint">{alt.when_to_use}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <Advance label="Hand them the phone" icon="👋" onClick={onHandOver} />
    </div>
  );
}

function HandOver({
  phrase,
  target,
  onTapMic,
}: {
  phrase: Phrase;
  target: Language;
  onTapMic: () => void;
}) {
  return (
    <div>
      <ScreenHead
        title="The phone is in their hands now"
        note="Everything on this screen is in their language, and there is one control."
      />

      <div className="mt-3 rounded-sm border border-note/30 p-4">
        <p className="text-2xl leading-snug text-bright" lang={target.code}>
          {phrase.target_text}
        </p>
        {phrase.handoff_note ? (
          <p className="mt-3 text-base text-note" lang={target.code}>
            {phrase.handoff_note}
          </p>
        ) : (
          <p className="mt-3 text-sm text-warning">
            No handoff note. This phrase was promoted from a suggested reply, and the
            reply schema has no such field — so the person holding the phone gets the
            sentence with no instructions. A real gap, visible only from this screen.
          </p>
        )}
      </div>

      <p className="mt-3 text-sm text-muted">
        The question stays large so they can read it again if the audio was hard to
        catch. Nothing else is on screen to tap by accident.
      </p>

      <Advance label="They reach for the mic" icon="🎙" onClick={onTapMic} />
    </div>
  );
}

function Listen({
  millis,
  onStart,
  onStop,
}: {
  millis: number;
  onStart: () => void;
  onStop: () => void;
}) {
  const live = millis > 0;
  return (
    <div>
      <ScreenHead
        title={live ? "Recording" : "Tap to record their answer"}
        note="expo-audio, HIGH_QUALITY preset. Audio never touches disk on the server either."
      />

      <div className="mt-4 flex flex-col items-center gap-3 py-2">
        <button
          type="button"
          onClick={live ? onStop : onStart}
          aria-label={live ? "Stop recording and translate" : "Start recording"}
          className={`flex h-28 w-28 items-center justify-center rounded-full border-2 text-3xl transition-colors ${
            live
              ? "border-error text-error motion-safe:animate-pulse"
              : "border-note text-note hover:border-accent hover:text-accent"
          }`}
        >
          <span aria-hidden>{live ? "■" : "🎙"}</span>
        </button>
        <p className="font-mono text-lg tabular-nums text-note">
          {live ? timerLabel(millis) : "0:00"}
        </p>
        <p className="font-mono text-[10px] text-faint">
          {live ? "hold the phone toward them" : "durationMillis → m:ss, listen.tsx"}
        </p>
      </div>

      {live && <Advance label="Done — translate it" icon="→" onClick={onStop} />}
    </div>
  );
}

function ReplyHop({
  exchange,
  target,
  native,
  promoted,
  onReveal,
  onRestart,
}: {
  exchange: Exchange;
  target: Language;
  native: Language;
  promoted: boolean;
  onReveal: () => void;
  onRestart: () => void;
}) {
  return (
    <div>
      <ScreenHead
        title="Working it out…"
        note="The only round trip in the whole loop, and it does two things."
      />

      <ol className="mt-3 flex flex-col gap-2">
        <Hop
          n={1}
          title={`multipart POST /api/listen → ${STT_MODEL}`}
          body={`The audio field keeps the extension it was recorded with — m4a on a phone, webm or mp4 in a browser — because Whisper picks its decoder from the filename. Only the primary subtag of the language tag is sent (${target.code.split("-")[0]}, not ${target.code}); without it a one-word reply is routinely detected as the wrong language. Buffered in memory, capped at ${AUDIO_CAP_MB} MB.`}
        />
        <Hop
          n={2}
          title={`analysisPrompt(${native.code} ← ${target.code}) → ${ANALYSIS_MODEL}`}
          body="The transcript and the phrase you had just said go into one prompt, and the answer comes back constrained by analysisSchema. The prompt is what asks for the split to keep particles and endings attached to the word they modify, and for two clear grammar points over five thin ones."
        />
      </ol>

      <div className="mt-3 rounded-sm border border-hair-soft p-3">
        <p className="font-mono text-[10px] text-faint">raw transcript, {STT_HOST}</p>
        <p className="mt-1 text-sm text-dim" lang={target.code}>
          {exchange.transcript}
        </p>
        <p className="mt-2 font-mono text-[10px] text-faint">
          repaired in the analysis step, not by a rule
        </p>
        <p className="mt-1 text-sm text-body" lang={target.code}>
          {exchange.analysis.corrected_text}
        </p>
      </div>

      {promoted ? (
        <div className="mt-3 rounded-sm border border-warning/40 p-3">
          <p className="font-mono text-[10px] text-warning">nothing recorded past here</p>
          <p className="mt-1.5 text-sm text-muted">
            You got here by promoting a suggested reply, so this is the second turn of
            the conversation — and a second turn means a second model call. One exchange
            per pair was recorded, so there is genuinely nothing to reveal. This is the
            edge of the offline demo, not a bug.
          </p>
          <button
            type="button"
            onClick={onRestart}
            className="mt-2.5 rounded-sm border border-hair px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:border-muted hover:text-body"
          >
            start over
          </button>
        </div>
      ) : (
        <Advance label="Show me what they said" icon="→" onClick={onReveal} />
      )}
    </div>
  );
}

function Breakdown({
  analysis,
  target,
  openToken,
  onToken,
  onStillTalking,
  onSayThisNext,
  onStartOver,
}: {
  analysis: Analysis;
  target: Language;
  openToken: number | null;
  onToken: (i: number) => void;
  onStillTalking: () => void;
  onSayThisNext: (reply: SuggestedReply) => void;
  onStartOver: () => void;
}) {
  return (
    <div>
      <ScreenHead
        title="They said"
        note="What it means for you comes before any of the linguistics."
      />

      <p className="mt-3 text-xl leading-snug text-bright" lang={target.code}>
        {analysis.corrected_text}
      </p>
      {analysis.romanization ? (
        <p className="mt-1 font-mono text-xs text-dim">{analysis.romanization}</p>
      ) : null}
      <div className="my-3 h-px bg-hair" />
      <p className="text-base text-body">{analysis.translation}</p>
      <p className="mt-1.5 text-sm text-muted">{analysis.gist}</p>

      {/* ---- word by word ---- */}
      <SubHead>Word by word</SubHead>
      <p className="font-mono text-[10px] text-faint">
        {analysis.tokens.length} tokens · split by the model, in speech order
      </p>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {analysis.tokens.map((token, i) => {
          const active = openToken === i;
          return (
            <button
              key={`${token.surface}-${i}`}
              type="button"
              onClick={() => onToken(i)}
              aria-pressed={active}
              className={`rounded-sm border px-2 py-1 text-left transition-colors ${
                active
                  ? "border-accent bg-raised"
                  : "border-hair-soft hover:border-muted"
              }`}
            >
              <span
                className={`block text-base leading-tight ${active ? "text-accent" : "text-body"}`}
                lang={target.code}
              >
                {token.surface}
              </span>
              {token.romanization ? (
                <span className="block font-mono text-[10px] text-faint">
                  {token.romanization}
                </span>
              ) : null}
              <span className="block font-mono text-[10px] text-dim">{token.meaning}</span>
            </button>
          );
        })}
      </div>

      <ol className="mt-3 flex flex-col">
        {analysis.tokens.map((token, i) => {
          const active = openToken === i;
          return (
            <li
              key={`row-${token.surface}-${i}`}
              className="flex gap-3 border-t border-hair-soft py-2 first:border-t-0"
            >
              <span className="w-8 shrink-0 pt-0.5 font-mono text-[10px] tabular-nums text-faint">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="w-[8.5rem] shrink-0">
                <span
                  className={`block leading-tight ${active ? "text-accent" : "text-body"}`}
                  lang={target.code}
                >
                  {token.surface}
                </span>
                {token.romanization ? (
                  <span className="block font-mono text-[10px] text-faint">
                    {token.romanization}
                  </span>
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-body">{token.meaning}</span>
                <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 font-mono text-[10px] text-dim">
                  <span className="text-note">{token.pos}</span>
                  {/* analysis.tsx only shows the lemma when it differs from the surface. */}
                  {token.lemma && token.lemma !== token.surface ? (
                    <span className="text-faint">
                      from {token.lemma}
                    </span>
                  ) : null}
                </span>
                {token.note ? (
                  <span
                    className={`mt-1 block text-sm ${active ? "text-body" : "text-muted"}`}
                  >
                    {token.note}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>

      {/* ---- grammar ---- */}
      {analysis.grammar.length > 0 && (
        <>
          <SubHead>Why it&rsquo;s built that way</SubHead>
          <ul className="mt-2 flex flex-col gap-2">
            {analysis.grammar.map((point) => (
              <li key={point.title} className="rounded-sm border border-hair-soft p-3">
                <p className="text-base text-bright" lang={target.code}>
                  {point.title}
                </p>
                <p className="mt-1 text-sm text-muted">{point.explanation}</p>
                <div className="mt-2 rounded-sm bg-raised p-2.5">
                  <p className="text-sm text-body" lang={target.code}>
                    {point.example_target}
                  </p>
                  <p className="mt-0.5 font-mono text-[11px] text-faint">
                    {point.example_translation}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <SubHead>How they addressed you</SubHead>
      <p className="mt-1 text-sm text-muted">{analysis.register}</p>

      <SubHead>You could answer</SubHead>
      <ul className="mt-2 flex flex-col gap-2">
        {analysis.suggested_replies.map((reply) => (
          <li key={reply.target_text} className="rounded-sm border border-hair-soft p-3">
            <p className="font-mono text-[10px] uppercase tracking-wide text-accent">
              {reply.intent}
            </p>
            <p className="mt-1 text-base text-bright" lang={target.code}>
              {reply.target_text}
            </p>
            {reply.romanization ? (
              <p className="mt-0.5 font-mono text-xs text-dim">{reply.romanization}</p>
            ) : null}
            <p className="mt-1 text-sm text-muted">{reply.translation}</p>
            <button
              type="button"
              onClick={() => onSayThisNext(reply)}
              className="mt-2 rounded-sm border border-hair px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:border-muted hover:text-body"
            >
              say this next →
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap gap-2 border-t border-hair-soft pt-3">
        <button
          type="button"
          onClick={onStillTalking}
          className="rounded-sm border border-note/40 px-3 py-1.5 font-mono text-xs text-note transition-colors hover:border-note"
        >
          🎙 they&rsquo;re still talking
        </button>
        <button
          type="button"
          onClick={onStartOver}
          className="rounded-sm border border-hair px-3 py-1.5 font-mono text-xs text-dim transition-colors hover:border-muted hover:text-body"
        >
          start over
        </button>
      </div>
    </div>
  );
}

/* ---- small parts ------------------------------------------------------- */

function ScreenHead({ title, note }: { title: string; note: string }) {
  return (
    <div>
      <h3 className="font-prose text-sm font-semibold uppercase tracking-wide text-dim">
        {title}
      </h3>
      <p className="mt-0.5 font-mono text-[10px] text-faint">{note}</p>
    </div>
  );
}

function SubHead({ children }: { children: ReactNode }) {
  return (
    <h4 className="mt-5 font-prose text-sm font-semibold uppercase tracking-wide text-dim">
      {children}
    </h4>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-sm border border-hair px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-note">
      {children}
    </span>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs text-body">{children}</span>;
}

function Hop({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 h-5 w-5 shrink-0 rounded-sm border border-warning/50 text-center font-mono text-[10px] leading-5 tabular-nums text-warning">
        {n}
      </span>
      <span className="min-w-0">
        <span className="block break-words font-mono text-xs text-body">{title}</span>
        <span className="mt-1 block text-sm text-muted">{body}</span>
      </span>
    </li>
  );
}

function Advance({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-4 flex w-full items-center justify-center gap-2 rounded-sm border border-accent px-3 py-2 font-mono text-xs text-accent transition-colors hover:bg-accent/10"
    >
      <span aria-hidden>{icon}</span>
      {label}
    </button>
  );
}
