export const person = {
  name: "Akira Tran",
  email: "patran@stanford.edu",
  github: "https://github.com/akiratrann",
  githubHandle: "github.com/akiratrann",
  linkedin: "https://www.linkedin.com/in/akira-pa-tran",
  /* Written out in full, the way the résumé header prints it. */
  linkedinHandle: "https://www.linkedin.com/in/akira-pa-tran",
  site: "akiratran.com",
  tagline: "Compilers, renderers, scanners, games, and comics.",
  /*
    One predicate, then domains chosen to be as far apart as possible. The
    range has to be visible in the first line or the reader files him under
    whichever discipline he names first.
  */
  predicate:
    "I build the machinery behind things other people look at.",
  blurb:
    "Stanford BS/MS Computer Science '27, minors in Fine Arts and Music. I build compilers and malware scanners, real-time renderers and games, and local tooling for drawing comics — and I research objects for the Cantor Arts Center.",
  availability:
    "Seeking summer 2027 research or internship — programming languages, security, or graphics.",
  /* Bump both when the content changes; a stale freshness line is worse
     than none, so this is deliberately manual rather than build-time. */
  lastUpdated: "2026-08-26",
  lastUpdatedLabel: "August 2026",
};

export const education = {
  school: "Stanford University",
  degree: "BS/MS, Computer Science",
  minors: "Minors in Fine Arts and Music",
  graduation: "June 2027",
  gpa: "3.8",
  coursework: [
    "PintOS",
    "Parallel Computing",
    "Compilers",
    "Computer and Network Security",
    "Algorithms",
    "Applied Zero Knowledge Proofs",
    "Cryptocurrencies and Blockchain Technologies",
  ],
};

export type Role = {
  title: string;
  org: string;
  place: string;
  dates: string;
  current?: boolean;
  points: string[];
};

export const roles: Role[] = [
  {
    title: "Security Research Intern",
    org: "Socket.dev",
    place: "Stanford, CA",
    dates: "March - June 2026",
    current: true,
    points: [
      "Developing techniques to expose false negatives and positives in scanning for malicious AI skills.",
      "Improving the skill scanner's accuracy on malicious script dependencies using binaries, surpassing Snyk's and GenTrustHub's scanners.",
      "Expanding the scanning scope into URL and cross-skill dependencies.",
    ],
  },
  {
    title: "Compilers Research Assistant",
    org: "Alex Aiken's Programming Languages Research Group, Stanford",
    place: "Stanford, CA",
    dates: "June 2025 - present",
    current: true,
    points: [
      "Enabled debugging output for development use by modifying the 25 abstract syntax tree structures of Morphic, a pure functional language.",
      "Fixed targeting, entry point naming, runtime linking and symbol table issues for WebAssembly compilation.",
      "Developing an FFI protocol to bridge any imperative or functional language, drawn from the C ABI and Rust-C FFI.",
    ],
  },
  {
    title: "Museum Guide",
    org: "Cantor Arts Center",
    place: "Stanford, CA",
    dates: "September 2024 - present",
    current: true,
    points: [
      "Conducted year-long research on 3 objects from the Cantor's permanent collection.",
      "Trained on the theory and practice of tour guiding; attend events and contribute reflections to discussions, minimum 8 hours a week.",
      "Guiding tours concentrating on the researched objects, on a two-year minimum commitment.",
    ],
  },
  {
    title: "Research Assistant",
    org: "Sharing Conversation: A Core Human Experience Across Life",
    place: "Stanford, CA",
    dates: "June - December 2024",
    points: [
      "Transcribed recordings for 4 of 20 studies in the Haiku Project — two to three hour-long haiku-making sessions between older adults with dementia and younger participants, plus four 30-minute post-study interviews.",
      "Analysed and synthesised participants' behavioural patterns of conversational coherence and dissonance.",
      "Reported and discussed findings in weekly meetings with the professor and three other research assistants.",
    ],
  },
  {
    title: "Television Script Writing Intern",
    org: "Baboon Animation",
    place: "Brooklyn, NY",
    dates: "June - September 2024",
    points: [
      "Coordinated, took notes for, and distributed follow-ups across 30 meetings between the director, clients, partner studios and internal writers.",
      "Assisted two lead writers with 5 script explodes and incorporated client notes into 4 television scripts.",
      "Edited 2 full episodes, sound-checked 4, and led a group of interns cue-counting across 50 episodes of Bellyfoo and Reggie Rex.",
    ],
  },
];

export const skills = {
  languages: ["C++", "C", "Rust", "Python", "JavaScript", "Go", "SQL", "Haskell", "Morphic"],
  areas: [
    "Embedded Systems",
    "Optimization",
    "Cryptography",
    "Security",
    "Blockchain",
    "Algorithm Design",
    "Zero Knowledge Proofs",
  ],
  tools: ["Unix", "Terminal", "Vim", "Git", "Docker", "Wireshark"],
};

export const honors = [
  { award: "Silver Medal", event: "Nordic-Baltic Physics Olympiad", year: "2022" },
  { award: "Bronze Medal", event: "International Science and Invention Fair", year: "2022" },
  { award: "Bronze Medal", event: "World Mathematics Team Championship", year: "2019" },
];
