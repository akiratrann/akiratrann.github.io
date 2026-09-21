"use client";

import { useMemo, useState, type ReactNode } from "react";

/*
  A faithful browser port of the prompt assembly inside the Cloudflare code
  assistant — worker/src/index.ts, the `POST /api/chat` handler, plus the two
  lines of app/src/App.tsx (`handleSubmit`) that decide what the Worker is
  even given to work with.

  The product's distinctive move is here and nowhere else: when you open a
  project someone shared with you, your chat panel is empty, but the Worker
  looks up the ORIGINAL OWNER's transcript and splices it into the *system*
  prompt behind a fixed preamble. It never enters `messages`, so the UI stays
  empty while the model can still answer "why is this written this way?".

  Every string below — the system prompt, the injection preamble, the
  `Owner:` / `Assistant:` line format, the trim rule — is lifted verbatim from
  that file. The owner transcript is a real record pulled out of the project's
  local KV state (worker/.wrangler/state), not a written-for-the-demo script,
  which is why the last assistant turn stops mid-token: the model ran out.

  Assembly is a chain of pure functions over immutable inputs, so what you see
  rendered is the array that would go to `env.AI.run`. No model is called; the
  orchestration *is* the product.
*/

/* ---- constants, verbatim from worker/src/index.ts ---------------------- */

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_HISTORY_TURNS = 16;

/* Caps applied once, at share time, in `handleProjectSave` — the injected
   block is bounded by these and by nothing else at chat time. */
const MAX_SHARE_MESSAGES_PER_CHAT = 120;
const MAX_SHARE_MESSAGE_CHARS = 24_000;

const BASE_SYSTEM_PROMPT =
  "You are a coding assistant similar to Cursor, focused on helping with code, architecture, and debugging. You run on Cloudflare Workers AI, have limited context, and should be concise, explicit, and pragmatic. Prefer TypeScript and Cloudflare-native patterns when relevant.\n\n" +
  "ACTIVE FILE EDITS: The user message may include an active file path and full file contents. When the user asks to remove, delete, omit, strip, or stop including specific code (e.g. console.log lines), or to rewrite/refactor the file, you MUST include exactly ONE markdown code fence with the COMPLETE updated file — every line that should exist after the change, not a diff and not only the changed lines. A short fragment will overwrite their file and destroy code.\n\n" +
  "If you cannot return the entire file, do NOT use a code fence for a partial snippet; explain in prose and ask them to use Suggest edit or paste the full file.\n\n" +
  "For small additive suggestions at the end of the file (not removals), a short fenced snippet is OK.";

/* The whole mechanism in one string literal. */
const SHARED_HISTORY_PREAMBLE =
  "\n\nThe user is viewing a shared copy of this project. Their chat panel starts empty, but the following is read-only prior conversation history from the original owner. Use it to answer questions about what was discussed, decisions made, or code that was explained. Do not repeat the entire history; integrate it only as needed.\n\n---\n";

const SHARED_HISTORY_CLOSE = "\n---";

/* ---- real data ---------------------------------------------------------- */

type OwnerMessage = { role: "user" | "assistant"; content: string };
type ProjectFile = { path: string; content: string };

/*
  Project "cool proj", ownerId `yourmom`, sharedWith `soggynugget` — read out
  of the KV blob the dev Worker wrote. Twelve messages, verbatim.
*/
const OWNER_CHAT: OwnerMessage[] = [
  { role: "user", content: "Suggest an edit for src/main.ts." },
  { role: "assistant", content: "```typescript\n// Example project file\n// Describe this file in chat to get suggestions.\n\nexport function add(a: number, b: number) {\n  return a + b\n}\n\nexport function subtract(a: number, b: number) {\n  return a - b\n}\n\nexport function multiply(a: number, b: number) {\n  return a * b\n}\n\nexport function main() {\n  console.log(\"Main function\")\n  const result = add(2, 3)\n  console.log(result)\n}\n```" },
  { role: "user", content: "this project is intended for my girlfriend" },
  { role: "assistant", content: "console.log(\"I love you!\")\nconst ourSpecialNumber = add(2, 3)\nconsole.log(`Our special number is: ${ourSpecialNumber}`)" },
  { role: "user", content: "no dont add those console log, just remember the information" },
  { role: "assistant", content: "const monthsTogether = multiply(12, 5)\nconst daysOfLove = multiply(ourSpecialNumber, monthsTogether)" },
  { role: "user", content: "no dont add those console log, just remember the information" },
  { role: "assistant", content: "const yearsTogether = monthsTogether / 12\nconst loveMessage = `You are my everything, ${yearsTogether} years and counting`" },
  { role: "user", content: "make a calculator program" },
  { role: "assistant", content: "```typescript\n// Calculator Program\n\ninterface Calculation {\n  num1: number\n  num2: number\n  operation: string\n}\n\nfunction add(a: number, b: number): number {\n  return a + b\n}\n\nfunction subtract(a: number, b: number): number {\n  return a - b\n}\n\nfunction multiply(a: number, b: number): number {\n  return a * b\n}\n\nfunction divide(a: number, b: number): number | string {\n  if (b === 0) {\n    return \"Error: Division by zero\"\n  }\n  return a / b\n}\n\nfunction calculate(calc: Calculation): number | string {\n  switch (calc.operation) {\n    case 'add':\n      return add(calc.num1, calc.num2)\n    case 'subtract':\n      return subtract(calc.num1, calc.num2)\n    case 'multiply':\n      return multiply(calc.num1, calc.num2)\n    case 'divide':\n      return divide(calc.num1, calc.num2)\n    default:\n      return \"Invalid operation\"\n  }\n}\n\nfunction main() {\n  const num1 = 10\n  const num2 = 2\n  const operations = ['add', 'subtract', 'multiply', 'divide']\n\n " },
  { role: "user", content: "do not insert any code for this, but just remember that this is intended for my friend" },
  { role: "assistant", content: "I've noted that this calculator program is intended for your friend." },
];

/* The files stored alongside that chat, verbatim. `src/main.ts` really does
   end with a sentence of English: the client appends any fenced snippet the
   model returns straight into the open file, and once it appended prose. */
const OWNER_FILES: ProjectFile[] = [
  { path: "src/main.ts", content: "// Calculator Program\n\ninterface Calculation {\n  num1: number\n  num2: number\n  operation: string\n}\n\nfunction add(a: number, b: number): number {\n  return a + b\n}\n\nfunction subtract(a: number, b: number): number {\n  return a - b\n}\n\nfunction multiply(a: number, b: number): number {\n  return a * b\n}\n\nfunction divide(a: number, b: number): number | string {\n  if (b === 0) {\n    return \"Error: Division by zero\"\n  }\n  return a / b\n}\n\nfunction calculate(calc: Calculation): number | string {\n  switch (calc.operation) {\n    case 'add':\n      return add(calc.num1, calc.num2)\n    case 'subtract':\n      return subtract(calc.num1, calc.num2)\n    case 'multiply':\n      return multiply(calc.num1, calc.num2)\n    case 'divide':\n      return divide(calc.num1, calc.num2)\n    default:\n      return \"Invalid operation\"\n  }\n}\n\nfunction main() {\n  const num1 = 10\n  const num2 = 2\n  const operations = ['add', 'subtract', 'multiply', 'divide']\nconst calculations = operations.map(op => ({ num1, num2, operation: op }))\ncalculations.forEach(calc => console.log(`${calc.num1} ${calc.operation} ${calc.num2} = ${calculate(calc)}`))\nmain()\nconsole.log(\"Calculator program executed successfully\")\n}\nI've noted that this calculator program is intended for your friend.\n" },
  { path: "README.md", content: "# New Project\n\nDescribe your project here. The assistant can see the contents of open files when you ask questions.\n" },
];

/* ---- the port ----------------------------------------------------------- */

type Role = "system" | "user" | "assistant";
type SessionMessage = { role: Role; content: string };

/** `loadPartnerHistorySummary` — flattens the owner's chat to labelled lines. */
function loadPartnerHistorySummary(chat: OwnerMessage[]): string | null {
  const lines: string[] = [];
  for (const m of chat) {
    if (m.role === "user" || m.role === "assistant") {
      const label = m.role === "user" ? "Owner" : "Assistant";
      lines.push(`${label}: ${m.content}`);
    }
  }
  return lines.length ? lines.join("\n\n") : null;
}

/** `trimHistory` — a no-op until the session passes 2 × MAX_HISTORY_TURNS. */
function trimHistory(messages: SessionMessage[], maxTurns: number): SessionMessage[] {
  if (messages.length <= maxTurns * 2) return messages;
  const startIndex = Math.max(0, messages.length - maxTurns * 2);
  return messages.slice(startIndex);
}

/** `handleSubmit` in App.tsx — the open editor tab rides along on every turn. */
function buildUserContent(question: string, file: ProjectFile | null): string {
  const trimmed = question.trim();
  const openFileSummary = file ? `\n\nActive file: ${file.path}\n\n${file.content}` : "";
  return trimmed + openFileSummary;
}

/*
  The system prompt is built by string concatenation, so to colour the parts
  we assemble the same string as labelled segments. Joining `text` in order
  reproduces `systemContent` byte for byte.
*/
type SegmentKind = "base" | "frame" | "owner" | "question" | "file";
type Segment = { kind: SegmentKind; text: string };

function buildSystemSegments(summary: string | null): Segment[] {
  const segments: Segment[] = [{ kind: "base", text: BASE_SYSTEM_PROMPT }];
  // `if (body.projectId && body.chatId)` — and the client only sends those two
  // when the open project came in via a share link.
  if (summary) {
    segments.push({ kind: "frame", text: SHARED_HISTORY_PREAMBLE });
    segments.push({ kind: "owner", text: summary });
    segments.push({ kind: "frame", text: SHARED_HISTORY_CLOSE });
  }
  return segments;
}

type Assembled = { role: Role; label: string; segments: Segment[] };

const segmentsLength = (segments: Segment[]) =>
  segments.reduce((n, s) => n + s.text.length, 0);

/* Both sizes of the system prompt, for the side-by-side in the footnotes. */
const OWN_SYSTEM_CHARS = BASE_SYSTEM_PROMPT.length;
const SHARED_SYSTEM_CHARS = segmentsLength(
  buildSystemSegments(loadPartnerHistorySummary(OWNER_CHAT)),
);

/* ---- placeholder session history ---------------------------------------- */

/*
  The one thing not lifted from the repo. Only the *count* matters for
  `trimHistory`, so rather than invent plausible chat we label the filler as
  filler and let the dial do its job.
*/
function placeholderSession(turns: number): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (let i = 1; i <= turns; i += 1) {
    out.push({ role: "user", content: `[placeholder — your question, turn ${i}]` });
    out.push({ role: "assistant", content: `[placeholder — the reply, turn ${i}]` });
  }
  return out;
}

const fmt = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/* ---- component ---------------------------------------------------------- */

const DEFAULT_QUESTION = "why are there no console.logs in this file?";

export function PromptAssembly() {
  const [shared, setShared] = useState(true);
  const [question, setQuestion] = useState(DEFAULT_QUESTION);
  const [filePath, setFilePath] = useState<string>(OWNER_FILES[0].path);
  const [fileContent, setFileContent] = useState<string>(OWNER_FILES[0].content);
  const [turns, setTurns] = useState(2);

  const activeFile: ProjectFile | null =
    filePath === "" ? null : { path: filePath, content: fileContent };

  const session = useMemo(() => placeholderSession(turns), [turns]);
  const trimmed = useMemo(() => trimHistory(session, MAX_HISTORY_TURNS), [session]);
  const dropped = session.length - trimmed.length;

  const summary = useMemo(
    () => (shared ? loadPartnerHistorySummary(OWNER_CHAT) : null),
    [shared],
  );

  const systemSegments = useMemo(() => buildSystemSegments(summary), [summary]);
  const userContent = buildUserContent(question, activeFile);

  const assembled: Assembled[] = [
    { role: "system", label: "systemMessage", segments: systemSegments },
    ...trimmed.map((m) => ({
      role: m.role,
      label: "history",
      segments: [{ kind: "base" as SegmentKind, text: m.content }],
    })),
    {
      role: "user",
      label: "userMessage.content",
      segments: activeFile
        ? [
            { kind: "question", text: question.trim() },
            { kind: "file", text: `\n\nActive file: ${activeFile.path}\n\n${activeFile.content}` },
          ]
        : [{ kind: "question", text: question.trim() }],
    },
  ];

  const systemChars = segmentsLength(systemSegments);
  const injectedChars = systemChars - OWN_SYSTEM_CHARS;
  const totalChars = assembled.reduce((n, m) => n + segmentsLength(m.segments), 0);

  return (
    <section className="mt-10 rounded border border-hair bg-raised">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hair px-4 py-3">
        <h2 className="font-prose text-base font-semibold text-bright">
          Prompt assembly — own project vs shared copy
        </h2>
        <p className="font-mono text-xs text-dim">ported from worker/src/index.ts</p>
      </header>

      <div className="px-4 py-4">
        <p className="max-w-[62ch] text-sm text-muted">
          Open a project someone shared with you and your chat panel is empty. The Worker
          still knows what was said: it reads the owner&rsquo;s transcript out of KV,
          flattens it to <span className="font-mono text-xs text-body">Owner:</span> /{" "}
          <span className="font-mono text-xs text-body">Assistant:</span> lines, and
          appends it to the <em>system</em> prompt behind a fixed preamble — never to{" "}
          <span className="font-mono text-xs text-body">messages</span>, which is why the
          panel stays empty. Below is the exact array that would reach{" "}
          <span className="font-mono text-xs text-body">env.AI.run</span>.
        </p>

        {/* ---- controls ---- */}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="font-mono text-xs text-faint">project source</span>
          <div className="flex gap-1" role="group" aria-label="Project source">
            {[
              { on: false, label: "own project" },
              { on: true, label: "shared copy" },
            ].map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => setShared(opt.on)}
                aria-pressed={shared === opt.on}
                className={`rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors ${
                  shared === opt.on
                    ? "border-accent text-accent"
                    : "border-hair text-dim hover:border-muted hover:text-body"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <span className="font-mono text-xs text-faint">
            {shared
              ? "body: { sessionId, message, projectId, chatId }"
              : "body: { sessionId, message }"}
          </span>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="font-mono text-xs text-faint">your question</span>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
              spellCheck={false}
              className="mt-1.5 block w-full resize-y rounded-sm border border-hair bg-sunken px-2 py-1.5 font-mono text-xs text-body"
            />
          </label>

          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-xs text-faint">active editor tab</span>
              <select
                value={filePath}
                onChange={(e) => {
                  const next = e.target.value;
                  setFilePath(next);
                  const found = OWNER_FILES.find((f) => f.path === next);
                  if (found) setFileContent(found.content);
                }}
                aria-label="Active file"
                className="rounded-sm border border-hair bg-sunken px-1.5 py-0.5 font-mono text-xs text-body"
              >
                {OWNER_FILES.map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.path}
                  </option>
                ))}
                <option value="">no file open</option>
              </select>
            </div>
            <textarea
              value={filePath === "" ? "" : fileContent}
              onChange={(e) => setFileContent(e.target.value)}
              disabled={filePath === ""}
              rows={3}
              spellCheck={false}
              className="mt-1.5 block w-full resize-y rounded-sm border border-hair bg-sunken px-2 py-1.5 font-mono text-xs text-body disabled:text-faint"
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-xs text-faint">your own prior turns</span>
            <input
              type="range"
              min={0}
              max={24}
              step={1}
              value={turns}
              onChange={(e) => setTurns(Number(e.target.value))}
              className="h-1 w-40 accent-accent"
            />
          </label>
          <span className="font-mono text-xs tabular-nums text-dim">
            {turns} turns → {turns * 2} messages
          </span>
          {dropped > 0 && (
            <span className="font-mono text-xs tabular-nums text-warning">
              trimHistory drops {dropped}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              setShared(true);
              setQuestion(DEFAULT_QUESTION);
              setFilePath(OWNER_FILES[0].path);
              setFileContent(OWNER_FILES[0].content);
              setTurns(2);
            }}
            className="ml-auto rounded-sm border border-hair px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:border-muted hover:text-body"
          >
            reset
          </button>
        </div>

        {/* ---- assembled array ---- */}

        <div className="mt-6 border-t border-hair pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="font-mono text-xs text-faint">
              messagesForModel — {MODEL}
            </p>
            <p className="font-mono text-xs tabular-nums text-dim">
              {assembled.length} messages · {fmt(totalChars)} chars · ≈
              {fmt(Math.ceil(totalChars / 4))} tok
            </p>
          </div>

          <ol className="mt-3 flex flex-col gap-2">
            <MessageCard
              index={0}
              role="system"
              label={assembled[0].label}
              chars={systemChars}
            >
              {systemSegments.map((s, i) => (
                <SegmentBody key={i} segment={s} />
              ))}
              {shared ? (
                <p className="mt-2 font-mono text-xs text-note">
                  + {injectedChars > 0 ? fmt(injectedChars) : 0} chars injected —{" "}
                  {OWNER_CHAT.length} owner messages, flattened. This block is{" "}
                  <span className="text-warning">not</span> subject to MAX_HISTORY_TURNS;
                  it is capped only at share time.
                </p>
              ) : (
                <p className="mt-2 border border-dashed border-hair px-2 py-1.5 font-mono text-xs text-faint">
                  nothing injected. The client omits projectId and chatId unless the
                  project arrived through a share link, and the Worker guards on{" "}
                  <span className="text-dim">if (body.projectId &amp;&amp; body.chatId)</span>
                  , so an own project can never reach another user&rsquo;s transcript.
                </p>
              )}
            </MessageCard>

            {trimmed.length > 0 && (
              <li className="rounded-sm border border-hair-soft bg-sunken px-3 py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-xs text-faint">
                    trimHistory(history, {MAX_HISTORY_TURNS}) — your session, from KV
                  </span>
                  <span className="font-mono text-xs tabular-nums text-dim">
                    {trimmed.length} kept
                    {dropped > 0 && (
                      <span className="text-warning"> · {dropped} dropped</span>
                    )}
                  </span>
                </div>
                <div className="mt-2 max-h-36 overflow-y-auto">
                  <ul className="flex flex-col gap-0.5">
                    {trimmed.map((m, i) => (
                      <li key={i} className="truncate font-mono text-xs text-faint">
                        <span className="text-dim">{m.role}</span> {m.content}
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            )}

            <MessageCard
              index={assembled.length - 1}
              role="user"
              label={assembled[assembled.length - 1].label}
              chars={userContent.length}
            >
              {assembled[assembled.length - 1].segments.map((s, i) => (
                <SegmentBody key={i} segment={s} />
              ))}
            </MessageCard>
          </ol>
        </div>

        {/* ---- footnotes ---- */}

        <div className="mt-5 border-t border-hair-soft pt-3">
          <dl className="grid gap-x-6 gap-y-1 font-mono text-xs sm:grid-cols-2">
            <Fact k="system prompt, own" v={`${fmt(OWN_SYSTEM_CHARS)} chars`} />
            <Fact k="system prompt, shared" v={`${fmt(SHARED_SYSTEM_CHARS)} chars`} />
            <Fact k="MAX_HISTORY_TURNS" v={`${MAX_HISTORY_TURNS} (keeps last ${MAX_HISTORY_TURNS * 2} messages)`} />
            <Fact
              k="share-time caps"
              v={`${MAX_SHARE_MESSAGES_PER_CHAT} msgs/chat · ${fmt(MAX_SHARE_MESSAGE_CHARS)} chars/msg`}
            />
          </dl>
          <p className="mt-3 max-w-[62ch] font-mono text-xs text-faint">
            The Worker counts no tokens anywhere — it only ever measures characters,
            against the share-time caps and a 24 MiB KV soft limit. The ≈tok figures
            here are chars ÷ 4, added by this demo, not by the source.
          </p>
          <p className="mt-2 max-w-[62ch] font-mono text-xs text-warning">
            Worth naming: loadPartnerHistorySummary fetches project:&#123;id&#125; with no
            authorisation check, so anyone holding a project id gets the owner&rsquo;s
            transcript in their system prompt. The sharedWith list gates discovery, not
            access.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ---- presentation ------------------------------------------------------- */

const ROLE_COLOR: Record<Role, string> = {
  system: "text-note",
  user: "text-accent",
  assistant: "text-muted",
};

function MessageCard({
  index,
  role,
  label,
  chars,
  children,
}: {
  index: number;
  role: Role;
  label: string;
  chars: number;
  children: ReactNode;
}) {
  return (
    <li className="rounded-sm border border-hair bg-sunken px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-xs">
          <span className="text-faint tabular-nums">[{index}]</span>{" "}
          <span className={ROLE_COLOR[role]}>{role}</span>{" "}
          <span className="text-faint">{label}</span>
        </span>
        <span className="font-mono text-xs tabular-nums text-dim">
          {fmt(chars)} chars · ≈{fmt(Math.ceil(chars / 4))} tok
        </span>
      </div>
      <div className="mt-2">{children}</div>
    </li>
  );
}

/*
  One `<pre>` per segment; concatenating them in order reproduces the exact
  string the Worker builds. Long segments get their own scroll box so a 1 kB
  file pasted into the editor cannot push the rest of the array off screen.
*/
function SegmentBody({ segment }: { segment: Segment }) {
  if (segment.kind === "owner") {
    return (
      <div className="my-1 max-h-64 overflow-y-auto border-l-2 border-accent pl-3">
        <pre className="whitespace-pre-wrap break-words font-mono text-xs text-body">
          {segment.text}
        </pre>
      </div>
    );
  }

  const tone =
    segment.kind === "frame"
      ? "text-note"
      : segment.kind === "question"
        ? "text-bright"
        : segment.kind === "file"
          ? "text-dim"
          : "text-muted";

  const body = (
    <pre className={`whitespace-pre-wrap break-words font-mono text-xs ${tone}`}>
      {segment.text}
    </pre>
  );

  if (segment.text.length > 400) {
    return <div className="max-h-44 overflow-y-auto">{body}</div>;
  }
  return body;
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hair-soft py-0.5">
      <dt className="text-faint">{k}</dt>
      <dd className="tabular-nums text-dim">{v}</dd>
    </div>
  );
}
