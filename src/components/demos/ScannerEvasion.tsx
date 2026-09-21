"use client";

import { useMemo, useState } from "react";

/*
  Two scanners run over the same mock package, side by side.

  Every rule below is lifted out of the Socket take-home scanner —
  src/scanner.ts (checkInstallScripts, checkBindingGyp, scanPackageDir),
  src/rules/patterns.ts (CODE_PATTERNS), src/rules/typosquat.ts (levenshtein,
  the thresholds, FALLBACK_POPULAR, the known-malicious map) and
  src/rules/dependency-confusion.ts (INTERNAL_NAME_TOKENS, KNOWN_PUBLIC_SCOPES).
  The hook list, the regexes, the edit-distance cap and the exit code are the
  ones the CLI ships with, not paraphrases of them.

  The left column is the same code with its input restricted to the root
  package.json — a scanner that only reads scripts. The right column walks the
  whole package tree. The point of the demo is the delta: a compiled artefact
  is not a script, so the left column has nothing to read and says so with
  confidence.

  Nothing here executes and nothing touches the network. The file bodies are
  inert placeholder strings rendered as text; the regexes are run against those
  strings, which is exactly what the real scanner does to a file it has read.
*/

/* ---------------------------------------------------------------- rule data */

/** scanner.ts — INSTALL_SCRIPT_HOOKS, verbatim, in source order. */
const INSTALL_SCRIPT_HOOKS = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish", // deprecated but still runs on npm install / npm ci
  "preprepare",
  "prepare", // runs on local npm install and when installing from git
  "postprepare",
  "preuninstall",
  "postuninstall",
];

const BINDING_GYP = "binding.gyp";

/** scanner.ts — scanPackageDir only opens files with these extensions. */
const JS_EXTENSIONS = [".js", ".cjs", ".mjs"];

type Severity = "error" | "warn" | "info";
type Category =
  | "install-script"
  | "typosquat"
  | "network-access"
  | "dependency-confusion"
  | "other";

type PatternRule = {
  id: string;
  category: Category;
  severity: Severity;
  label: string;
  pattern: RegExp;
  message: string;
};

/** rules/patterns.ts — CODE_PATTERNS. All 18, regexes unchanged. */
const CODE_PATTERNS: PatternRule[] = [
  {
    id: "net-module",
    category: "network-access",
    severity: "warn",
    label: "net module",
    pattern: /require\s*\(\s*['"]net['"]\s*\)|from\s+['"]net['"]/,
    message: "This module accesses the network (net). Packages should remove unnecessary network access.",
  },
  {
    id: "net-connect",
    category: "network-access",
    severity: "warn",
    label: "net.connect / createConnection",
    pattern: /\.connect\s*\(|createConnection\s*\(/,
    message: "This module accesses the network. Audit network access to ensure legitimate use.",
  },
  {
    id: "http-module",
    category: "network-access",
    severity: "warn",
    label: "http module",
    pattern: /require\s*\(\s*['"]http['"]\s*\)|from\s+['"]http['"]/,
    message: "This module accesses the network (http). Packages should remove unnecessary network access.",
  },
  {
    id: "https-module",
    category: "network-access",
    severity: "warn",
    label: "https module",
    pattern: /require\s*\(\s*['"]https['"]\s*\)|from\s+['"]https['"]/,
    message: "This module accesses the network (https). Packages should remove unnecessary network access.",
  },
  {
    id: "http-request",
    category: "network-access",
    severity: "warn",
    label: "http(s).request / get",
    pattern: /\.request\s*\(|\.get\s*\(/,
    message: "This module accesses the network. Audit network access to ensure legitimate use.",
  },
  {
    id: "dns-module",
    category: "network-access",
    severity: "warn",
    label: "dns module",
    pattern: /require\s*\(\s*['"]dns['"]\s*\)|from\s+['"]dns['"]/,
    message: "This module accesses the network (dns). Packages should remove unnecessary network access.",
  },
  {
    id: "http2-module",
    category: "network-access",
    severity: "warn",
    label: "http2 module",
    pattern:
      /require\s*\(\s*['"]node:http2['"]\s*\)|require\s*\(\s*['"]http2['"]\s*\)|from\s+['"]node:http2['"]|from\s+['"]http2['"]/,
    message: "This module accesses the network (http2). Packages should remove unnecessary network access.",
  },
  {
    id: "fetch",
    category: "network-access",
    severity: "warn",
    label: "fetch()",
    pattern: /\bfetch\s*\(/,
    message: "This module accesses the network (fetch). Packages should remove unnecessary network access.",
  },
  {
    id: "tls-module",
    category: "network-access",
    severity: "warn",
    label: "tls module",
    pattern: /require\s*\(\s*['"]tls['"]\s*\)|from\s+['"]tls['"]/,
    message: "This module accesses the network (tls). Packages should remove unnecessary network access.",
  },
  {
    id: "dgram-module",
    category: "network-access",
    severity: "warn",
    label: "dgram module",
    pattern: /require\s*\(\s*['"]dgram['"]\s*\)|from\s+['"]dgram['"]/,
    message: "This module accesses the network (dgram). Packages should remove unnecessary network access.",
  },
  {
    id: "ws-module",
    category: "network-access",
    severity: "warn",
    label: "ws module",
    pattern: /require\s*\(\s*['"]ws['"]\s*\)|from\s+['"]ws['"]/,
    message:
      "This module accesses the network (WebSocket via ws). Packages should remove unnecessary network access.",
  },
  {
    id: "websocket-constructor",
    category: "network-access",
    severity: "warn",
    label: "WebSocket constructor",
    pattern: /new\s+WebSocket\s*\(/,
    message: "This module accesses the network (WebSocket). Packages should remove unnecessary network access.",
  },
  {
    id: "undici-module",
    category: "network-access",
    severity: "warn",
    label: "undici module",
    pattern: /require\s*\(\s*['"]undici['"]\s*\)|from\s+['"]undici['"]/,
    message: "This module accesses the network (undici). Packages should remove unnecessary network access.",
  },
  {
    id: "xmlhttprequest",
    category: "network-access",
    severity: "warn",
    label: "XMLHttpRequest",
    pattern: /new\s+XMLHttpRequest\s*\(/,
    message:
      "This module accesses the network (XMLHttpRequest). Packages should remove unnecessary network access.",
  },
  {
    id: "eventsource",
    category: "network-access",
    severity: "warn",
    label: "EventSource",
    pattern: /new\s+EventSource\s*\(/,
    message:
      "This module accesses the network (EventSource/SSE). Packages should remove unnecessary network access.",
  },
  {
    id: "sendbeacon",
    category: "network-access",
    severity: "warn",
    label: "sendBeacon",
    pattern: /sendBeacon\s*\(/,
    message: "This module accesses the network (sendBeacon). Packages should remove unnecessary network access.",
  },
  {
    id: "webrtc-peer",
    category: "network-access",
    severity: "warn",
    label: "RTCPeerConnection",
    pattern: /RTCPeerConnection\s*\(|new\s+RTCPeerConnection\s*\(/,
    message: "This module accesses the network (WebRTC). Packages should remove unnecessary network access.",
  },
  {
    id: "webrtc-datachannel",
    category: "network-access",
    severity: "warn",
    label: "RTCDataChannel",
    pattern: /RTCDataChannel\s*\(|new\s+RTCDataChannel\s*\(|\.createDataChannel\s*\(/,
    message:
      "This module accesses the network (WebRTC DataChannel). Packages should remove unnecessary network access.",
  },
];

/*
  typosquat.ts ships a generated list of 1863 popular npm names plus a
  FALLBACK_POPULAR array used when that JSON is missing. The demo runs against
  the fallback — same code path, a list small enough to ship in a component.
*/
const FALLBACK_POPULAR = [
  "lodash", "react", "chalk", "browserslist", "express", "moment", "date-fns",
  "axios", "webpack", "typescript", "jest", "eslint", "prettier", "rimraf",
  "cross-env", "dotenv", "uuid", "yargs", "commander", "glob", "minimist",
  "node-fetch", "request", "async", "underscore", "jquery", "vue", "angular",
  "next", "gulp", "grunt", "babel-core", "react-dom", "prop-types",
];

/** rules/malicious-typosquats.json, in full — 33 curated npm names. */
const MALICIOUS_TYPOSQUATS: Record<string, string> = {
  "crossenv": "cross-env",
  "typescriptjs": "typescript",
  "nodemonjs": "nodemon",
  "react-router-dom.js": "react-router-dom",
  "zustand.js": "zustand",
  "babelcl": "babel-cli",
  "npmrunnall": "npm-run-all",
  "streamserch": "streamsearch",
  "chokader": "chokidar",
  "deezcord.js": "discord.js",
  "dezcord.js": "discord.js",
  "dizcordjs": "discord.js",
  "ethesjs": "ethers",
  "ethetsjs": "ethers",
  "etherdjs": "ethers",
  "node-mongoose-orm": "mongoose",
  "eslint-config-airbnb-compat": "eslint-config-airbnb",
  "loadsh": "lodash",
  "reequest": "request",
  "comander": "commander",
  "require-port": "requires-port",
  "axois": "axios",
  "import-mysql": "mysql-import",
  "signqle": "signale",
  "1odash": "lodash",
  "uglify.js": "uglify-js",
  "underscore.string-2": "underscore.string",
  "asimplemde": "simplemde",
  "zs-sha3": "js-sha3",
  "ns-sha3": "js-sha3",
  "jsmsha3": "js-sha3",
  "js-shas": "js-sha3",
  "js-sha7": "js-sha3",
};

const TYPOSQUAT_MAX_DISTANCE = 2;
const TYPOSQUAT_MAX_LENGTH_DIFF = 2;
const MIN_SUGGESTION_NORMALIZED_LENGTH = 3;

/** dependency-confusion.ts — INTERNAL_NAME_TOKENS. */
const INTERNAL_NAME_TOKENS = [
  "internal", "private", "corp", "company", "enterprise",
  "proprietary", "custom", "local", "staging", "intranet",
];

/** dependency-confusion.ts — scopes that are known public orgs. */
const KNOWN_PUBLIC_SCOPES = new Set([
  "angular", "babel", "microsoft", "google", "facebook", "vue", "svelte",
  "nestjs", "remix", "vercel", "netlify", "eslint", "prettier", "typescript",
  "socket", "lodash", "jquery", "moment", "express", "next", "nuxt",
  "redux", "react", "emotion", "chakra", "mui", "tailwind", "vite", "rollup",
  "webpack", "parcel", "jest", "cypress", "playwright", "testing-library",
  "aws", "azure", "google-cloud", "twilio", "stripe", "sendgrid",
]);

/* ------------------------------------------------------------------- rules */

type Finding = {
  category: Category;
  severity: Severity;
  message: string;
  package: string;
  file?: string;
  line?: number;
  detail: string;
  /** Where in the take-home this rule lives, so a claim can be checked. */
  rule: string;
  /** True when the demo, not scanner.ts, is responsible for this reaching the node. */
  extended?: boolean;
};

type Manifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

/** scanner.ts — checkInstallScripts. One finding per declared hook. */
function checkInstallScripts(manifest: Manifest): Finding[] {
  const findings: Finding[] = [];
  if (!manifest.scripts) return findings;
  for (const script of INSTALL_SCRIPT_HOOKS) {
    if (manifest.scripts[script]) {
      findings.push({
        category: "install-script",
        severity: "warn",
        message: `Install script "${script}" runs when the package is installed. Non-essential scripts should not run during install.`,
        package: manifest.name,
        detail: script,
        rule: "scanner.ts · checkInstallScripts",
      });
    }
  }
  return findings;
}

/*
  scanner.ts — checkBindingGyp. The subtle half of this rule is the guard: if
  the manifest already declares install or preinstall, it returns null, because
  the explicit hook is reported instead. A postinstall does NOT suppress it.
*/
function checkBindingGyp(manifest: Manifest, files: PkgFile[]): Finding | null {
  const hasCustomInstall =
    manifest.scripts?.install != null || manifest.scripts?.preinstall != null;
  if (hasCustomInstall) return null;
  const gyp = files.find((f) => f.path.endsWith(BINDING_GYP));
  if (!gyp) return null;
  return {
    category: "install-script",
    severity: "warn",
    message:
      "Package has binding.gyp; npm may run node-gyp rebuild on install (native addon build). This is not visible in package.json scripts.",
    package: manifest.name,
    file: gyp.path,
    detail: BINDING_GYP,
    rule: "scanner.ts · checkBindingGyp",
  };
}

/** rules/patterns.ts — matchPatterns. One finding per rule per file. */
function matchPatterns(content: string, filePath: string, packageName: string): Finding[] {
  const findings: Finding[] = [];
  const lines = content.split("\n");
  for (const rule of CODE_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if (rule.pattern.test(lines[i])) {
        findings.push({
          category: rule.category,
          severity: rule.severity,
          message: rule.message,
          package: packageName,
          file: filePath,
          line: i + 1,
          detail: rule.label,
          rule: `rules/patterns.ts · ${rule.id}`,
        });
        break; // one finding per rule per file
      }
    }
  }
  return findings;
}

/** typosquat.ts — normalizePackageName. Punctuation stripped, as npm does. */
function normalizePackageName(name: string): string {
  return name.replace(/[.\-_]/g, "").toLowerCase();
}

/** typosquat.ts — levenshtein, including the length-difference early-out. */
function levenshtein(a: string, b: string, maxDistance?: number): number {
  const m = a.length;
  const n = b.length;
  if (maxDistance !== undefined && Math.abs(m - n) > maxDistance) return maxDistance + 1;
  const d: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let j = 1; j <= n; j++) {
    for (let i = 1; i <= m; i++) {
      d[i][j] =
        a[i - 1] === b[j - 1]
          ? d[i - 1][j - 1]
          : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
    }
  }
  return d[m][n];
}

/*
  typosquat.ts — checkTyposquat, minus the package-confusion pass. Blocklist
  first, exact match exits clean, then the nearest popular name within two
  edits of the normalized name.
*/
function checkTyposquat(packageName: string): Finding | null {
  const trimmed = packageName.trim();
  if (trimmed.length === 0) return null;
  const name = trimmed.toLowerCase();
  const normalized = normalizePackageName(trimmed);
  if (normalized.length < MIN_SUGGESTION_NORMALIZED_LENGTH) return null;

  const known = MALICIOUS_TYPOSQUATS[name];
  if (known) {
    return {
      category: "typosquat",
      severity: "error",
      message: `Known malicious typosquat. Did you mean "${known}"?`,
      package: packageName,
      detail: `known-malicious:${known}`,
      rule: "rules/typosquat.ts · blocklist",
    };
  }

  if (FALLBACK_POPULAR.includes(name)) return null; // exact match is legitimate

  let bestMatch: string | null = null;
  let bestDistance = TYPOSQUAT_MAX_DISTANCE + 1;
  for (const popular of FALLBACK_POPULAR) {
    const popNorm = normalizePackageName(popular);
    if (popNorm.length < MIN_SUGGESTION_NORMALIZED_LENGTH) continue;
    if (Math.abs(normalized.length - popNorm.length) > TYPOSQUAT_MAX_LENGTH_DIFF) continue;
    const dist = levenshtein(normalized, popNorm, TYPOSQUAT_MAX_DISTANCE);
    if (dist <= TYPOSQUAT_MAX_DISTANCE && dist < bestDistance) {
      bestDistance = dist;
      bestMatch = popular;
    }
  }
  if (!bestMatch) return null;
  return {
    category: "typosquat",
    severity: "error",
    message: `Possible typosquat attack. Package name is similar to popular package. Did you mean "${bestMatch}"?`,
    package: packageName,
    detail: `did-you-mean:${bestMatch}`,
    rule: "rules/typosquat.ts · levenshtein",
  };
}

/** dependency-confusion.ts — checkDependencyConfusion. */
function checkDependencyConfusion(packageName: string): Finding | null {
  const trimmed = packageName.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.startsWith("@") && trimmed.includes("/")) {
    const scope = trimmed.slice(1, trimmed.indexOf("/")).toLowerCase();
    if (KNOWN_PUBLIC_SCOPES.has(scope)) return null;
    if (!INTERNAL_NAME_TOKENS.some((t) => scope.includes(t))) return null;
    return {
      category: "dependency-confusion",
      severity: "warn",
      message:
        "Scoped package name looks internal. Ensure this scope is configured to use your private registry (e.g. in .npmrc) to prevent dependency confusion attacks.",
      package: packageName,
      detail: `scope:${scope}`,
      rule: "rules/dependency-confusion.ts",
    };
  }

  const lower = trimmed.toLowerCase();
  const tokens = lower.split(/[-._]/).filter((s) => s.length > 0);
  const internal = INTERNAL_NAME_TOKENS.some((t) => lower.includes(t) || tokens.includes(t));
  if (!internal) return null;
  return {
    category: "dependency-confusion",
    severity: "error",
    message:
      "Possible dependency confusion risk: this package name looks like an internal/private package. An attacker could publish a package with this name on the public npm registry. Use a scoped name (e.g. @yourorg/name) and a private registry, or reserve this name on npm.",
    package: packageName,
    detail: "internal-looking-name",
    rule: "rules/dependency-confusion.ts",
  };
}

/* ------------------------------------------------------- the mock package */

/*
  Inert placeholder bodies. They exist to be pattern-matched, not run. The one
  URL points at .invalid, a TLD reserved by RFC 2606 precisely so it can never
  resolve, and no code in this component ever issues a request.
*/

const POSTINSTALL_JS = `// inert placeholder — this demo ships no payload
console.log("acme-telemetry: postinstall hook ran");
`;

const AXOIS_INDEX_JS = `// inert placeholder
module.exports = { create: () => ({}) };
`;

const COLLECT_JS = `// inert placeholder — no request is ever issued from this demo
const https = require("https");

const ENDPOINT = "https://example.invalid/v1/collect";

function send(body) {
  if (typeof fetch === "function") return fetch(ENDPOINT, { method: "POST", body });
  return https.request(ENDPOINT, { method: "POST" });
}

module.exports = { send };
`;

const NATIVE_INDEX_JS = `// inert placeholder — the real work is behind the addon
module.exports = require("./prebuilds/linux-x64/metrics.node");
`;

const BINDING_GYP_TEXT = `{
  "targets": [
    { "target_name": "metrics", "sources": [ "src/metrics.cc" ] }
  ]
}
`;

const NESTED_INDEX_JS = `// inert placeholder
module.exports = function report() { return null; };
`;

type FileKind = "manifest" | "js" | "config" | "binary";

type PkgFile = { path: string; text: string | null; kind: FileKind };

type PkgNode = {
  id: string;
  name: string;
  version: string;
  dir: string;
  depth: number;
  manifest: Manifest;
  files: PkgFile[];
};

type Toggles = {
  inlineScript: boolean;
  dependency: boolean;
  binaryDep: boolean;
  urlFetch: boolean;
  nestedDep: boolean;
};

const EMPTY: Toggles = {
  inlineScript: false,
  dependency: false,
  binaryDep: false,
  urlFetch: false,
  nestedDep: false,
};

function manifestFile(node: Omit<PkgNode, "files">): PkgFile {
  return {
    path: `${node.dir ? `${node.dir}/` : ""}package.json`,
    text: `${JSON.stringify(node.manifest, null, 2)}\n`,
    kind: "manifest",
  };
}

/** Assemble the package in depth-first order — the order a walk would visit. */
function buildGraph(t: Toggles): PkgNode[] {
  const rootDeps: Record<string, string> = {};
  const rootManifest: Manifest = {
    name: "acme-telemetry",
    version: "2.3.1",
    dependencies: rootDeps,
  };
  if (t.inlineScript) {
    rootManifest.scripts = { postinstall: "node ./scripts/postinstall.js" };
  }

  const root: PkgNode = {
    id: "root",
    name: rootManifest.name,
    version: rootManifest.version,
    dir: "",
    depth: 0,
    manifest: rootManifest,
    files: [],
  };

  let dep: PkgNode | null = null;
  if (t.dependency) {
    rootDeps["axois"] = "^0.21.4";
    const depManifest: Manifest = { name: "axois", version: "0.21.4", dependencies: {} };
    dep = {
      id: "dep",
      name: "axois",
      version: "0.21.4",
      dir: "node_modules/axois",
      depth: 1,
      manifest: depManifest,
      files: [],
    };
  }

  let nested: PkgNode | null = null;
  if (t.nestedDep && dep) {
    dep.manifest.dependencies = { "acme-internal-telemetry": "^1.0.0" };
    nested = {
      id: "nested",
      name: "acme-internal-telemetry",
      version: "1.0.0",
      dir: "node_modules/axois/node_modules/acme-internal-telemetry",
      depth: 2,
      manifest: { name: "acme-internal-telemetry", version: "1.0.0" },
      files: [],
    };
  }

  let bin: PkgNode | null = null;
  if (t.binaryDep) {
    rootDeps["native-metrics"] = "^0.9.0";
    bin = {
      id: "bin",
      name: "native-metrics",
      version: "0.9.0",
      dir: "node_modules/native-metrics",
      depth: 1,
      // No scripts at all. npm still runs node-gyp rebuild because of binding.gyp.
      manifest: { name: "native-metrics", version: "0.9.0" },
      files: [],
    };
  }

  root.files = [manifestFile(root)];
  if (t.inlineScript) {
    root.files.push({ path: "scripts/postinstall.js", text: POSTINSTALL_JS, kind: "js" });
  }
  if (dep) {
    dep.files = [
      manifestFile(dep),
      { path: `${dep.dir}/index.js`, text: AXOIS_INDEX_JS, kind: "js" },
    ];
  }
  if (nested) {
    nested.files = [
      manifestFile(nested),
      { path: `${nested.dir}/index.js`, text: NESTED_INDEX_JS, kind: "js" },
    ];
  }
  if (bin) {
    bin.files = [
      manifestFile(bin),
      { path: `${bin.dir}/${BINDING_GYP}`, text: BINDING_GYP_TEXT, kind: "config" },
      { path: `${bin.dir}/index.js`, text: NATIVE_INDEX_JS, kind: "js" },
      {
        path: `${bin.dir}/prebuilds/linux-x64/metrics.node`,
        text: null, // compiled addon — readFile(…, "utf-8") gives nothing usable
        kind: "binary",
      },
    ];
  }

  // The runtime fetch lands in the deepest package present, so you can watch
  // depth alone decide whether anyone reads it.
  if (t.urlFetch) {
    const host = nested ?? bin ?? dep ?? root;
    host.files.push({
      path: `${host.dir ? `${host.dir}/` : ""}lib/collect.js`,
      text: COLLECT_JS,
      kind: "js",
    });
  }

  const nodes: PkgNode[] = [root];
  if (dep) nodes.push(dep);
  if (nested) nodes.push(nested);
  if (bin) nodes.push(bin);
  return nodes;
}

/** Where the payload is staged: the most opaque node currently assembled. */
function payloadPath(nodes: PkgNode[], t: Toggles): string | null {
  const find = (id: string, suffix: string) =>
    nodes.find((n) => n.id === id)?.files.find((f) => f.path.endsWith(suffix))?.path ?? null;
  if (t.binaryDep) return find("bin", "metrics.node");
  if (t.nestedDep) return find("nested", "index.js");
  if (t.urlFetch) return nodes.flatMap((n) => n.files).find((f) => f.path.endsWith("lib/collect.js"))?.path ?? null;
  if (t.dependency) return find("dep", "index.js");
  if (t.inlineScript) return find("root", "postinstall.js");
  return null;
}

/* ---------------------------------------------------------------- scanners */

type Run = {
  findings: Finding[];
  filesRead: string[];
  nodesVisited: number;
  rulesEvaluated: number;
};

/**
 * The script-only scanner: checkInstallScripts over the root manifest, and
 * nothing else. One file opened, nine hooks checked.
 */
function scanScriptsOnly(nodes: PkgNode[]): Run {
  const root = nodes[0];
  return {
    findings: checkInstallScripts(root.manifest),
    filesRead: ["package.json"],
    nodesVisited: 1,
    rulesEvaluated: INSTALL_SCRIPT_HOOKS.length,
  };
}

const DEEP_RULE_COUNT = INSTALL_SCRIPT_HOOKS.length + 1 + CODE_PATTERNS.length + 2;

/**
 * The full scanner: manifests, binding.gyp, the content patterns over every
 * readable JS file, and the name rules over every package in the tree.
 */
function scanDeep(nodes: PkgNode[]): Run {
  const findings: Finding[] = [];
  const filesRead: string[] = [];

  for (const node of nodes) {
    const beyond = node.depth >= 2;

    for (const f of node.files) {
      if (f.kind === "manifest") filesRead.push(f.path);
    }

    findings.push(...checkInstallScripts(node.manifest).map((f) => ({ ...f, extended: beyond })));

    const gyp = checkBindingGyp(node.manifest, node.files);
    if (gyp) findings.push({ ...gyp, extended: beyond });

    if (node.depth > 0) {
      const typo = checkTyposquat(node.name);
      if (typo) findings.push({ ...typo, extended: beyond });
      const confusion = checkDependencyConfusion(node.name);
      if (confusion) findings.push({ ...confusion, extended: beyond });
    }

    for (const f of node.files) {
      if (f.kind === "manifest") continue;
      const readable = f.text !== null && JS_EXTENSIONS.some((ext) => f.path.endsWith(ext));
      if (readable && f.text !== null) {
        filesRead.push(f.path);
        findings.push(
          ...matchPatterns(f.text, f.path, node.name).map((m) => ({ ...m, extended: beyond })),
        );
        continue;
      }
      if (f.kind === "binary") {
        // Not a rule in scanner.ts. It is the consequence of one: scanPackageDir
        // only opens .js/.cjs/.mjs, so this file's bytes are never examined.
        findings.push({
          category: "other",
          severity: "info",
          message:
            "Compiled artefact. Outside the .js/.cjs/.mjs set scanPackageDir opens, so its bytes are never read by any content rule. What is detectable here is the install path that builds and loads it, not the payload itself.",
          package: node.name,
          file: f.path,
          detail: "opaque-artefact",
          rule: "demo-derived",
          extended: beyond,
        });
      }
    }
  }

  return {
    findings,
    filesRead,
    nodesVisited: nodes.length,
    rulesEvaluated: DEEP_RULE_COUNT,
  };
}

/** cli.ts — process.exit(hasError ? 1 : 0). Warnings alone still exit 0. */
function exitCode(run: Run): number {
  return run.findings.some((f) => f.severity === "error") ? 1 : 0;
}

/* -------------------------------------------------------------------- view */

const CONTROLS: { key: keyof Toggles; label: string; note: string }[] = [
  { key: "inlineScript", label: "inline install script", note: "postinstall in the root package.json" },
  { key: "dependency", label: "a dependency", note: "node_modules/axois — a name on the blocklist" },
  { key: "binaryDep", label: "a binary dependency", note: "binding.gyp + a prebuilt .node addon" },
  { key: "urlFetch", label: "runtime URL fetch", note: "lands in the deepest package present" },
  { key: "nestedDep", label: "nested dependency", note: "a transitive dep, two levels down" },
];

const SEVERITY_CLASS: Record<Severity, string> = {
  error: "text-error",
  warn: "text-warning",
  info: "text-note",
};

export function ScannerEvasion() {
  // Opens on the case the essay is about: A prints "No issues found."
  const [toggles, setToggles] = useState<Toggles>({
    ...EMPTY,
    dependency: true,
    binaryDep: true,
  });
  const [selected, setSelected] = useState<string | null>(null);

  const nodes = useMemo(() => buildGraph(toggles), [toggles]);
  const shallow = useMemo(() => scanScriptsOnly(nodes), [nodes]);
  const deep = useMemo(() => scanDeep(nodes), [nodes]);
  const payload = useMemo(() => payloadPath(nodes, toggles), [nodes, toggles]);

  const shallowRead = new Set(shallow.filesRead);
  const deepRead = new Set(deep.filesRead);

  const flip = (key: keyof Toggles) =>
    setToggles((t) => {
      const next = { ...t, [key]: !t[key] };
      // A nested dependency needs something to nest inside.
      if (key === "nestedDep" && next.nestedDep) next.dependency = true;
      if (key === "dependency" && !next.dependency) next.nestedDep = false;
      return next;
    });

  const selectedFile = nodes.flatMap((n) => n.files).find((f) => f.path === selected) ?? null;
  const selectedFindings = selected ? deep.findings.filter((f) => f.file === selected) : [];

  return (
    <section className="mt-10 rounded border border-hair bg-raised">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hair px-4 py-3">
        <h2 className="font-prose text-base font-semibold text-bright">
          Two scanners, one package
        </h2>
        <p className="font-mono text-xs text-dim">ported from scanner.ts + rules/*.ts</p>
      </header>

      <div className="px-4 py-4">
        <p className="max-w-[62ch] text-sm text-muted">
          Assemble a package on the left. Both columns run the same rule code from the
          take-home; the difference is what they are allowed to open. The left one reads
          the root <span className="font-mono text-xs text-body">package.json</span> and
          stops. The right one walks every package in the tree and opens every file whose
          extension is in{" "}
          <span className="font-mono text-xs text-body">[&quot;.js&quot;, &quot;.cjs&quot;, &quot;.mjs&quot;]</span>.
          A compiled addon is in neither set — so what catches it is the install path that
          builds it, not its contents.
        </p>

        {/* ------------------------------------------------------ controls */}
        <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Package contents">
          {CONTROLS.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => flip(c.key)}
              aria-pressed={toggles[c.key]}
              title={c.note}
              className={`rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors ${
                toggles[c.key]
                  ? "border-accent text-accent"
                  : "border-hair text-dim hover:border-muted hover:text-body"
              }`}
            >
              {toggles[c.key] ? "+ " : "  "}
              {c.label}
            </button>
          ))}
        </div>

        {/* --------------------------------------------------------- tree */}
        <div className="mt-5">
          <div className="flex items-baseline justify-between gap-3">
            <p className="font-mono text-xs text-faint">package tree · click a file</p>
            <p className="font-mono text-xs text-faint">
              <span className="text-dim">A</span> / <span className="text-accent">B</span> opened
            </p>
          </div>

          <div className="mt-2 overflow-x-auto rounded-sm bg-sunken">
            <ul className="min-w-max py-2">
              {nodes.map((node) => (
                <li key={node.id}>
                  <div
                    className="px-3 py-0.5 font-mono text-xs text-body"
                    style={{ paddingLeft: `${0.75 + node.depth * 1.25}rem` }}
                  >
                    <span className="text-bright">{node.name}</span>
                    <span className="text-faint">@{node.version}</span>
                    {node.depth >= 2 && (
                      <span className="ml-2 text-note">† below the shipped walk</span>
                    )}
                  </div>
                  {node.files.map((f) => {
                    const isPayload = f.path === payload;
                    const isSelected = f.path === selected;
                    const short = f.path.startsWith(node.dir) && node.dir
                      ? f.path.slice(node.dir.length + 1)
                      : f.path;
                    return (
                      <button
                        key={f.path}
                        type="button"
                        onClick={() => setSelected(isSelected ? null : f.path)}
                        aria-pressed={isSelected}
                        className={`flex w-full items-baseline gap-2 py-0.5 pr-3 text-left font-mono text-xs transition-colors ${
                          isSelected ? "bg-raised text-bright" : "text-dim hover:text-body"
                        }`}
                        style={{ paddingLeft: `${1.75 + node.depth * 1.25}rem` }}
                      >
                        <span className="w-8 shrink-0 tabular-nums">
                          <span className={shallowRead.has(f.path) ? "text-body" : "text-faint"}>
                            {shallowRead.has(f.path) ? "●" : "·"}
                          </span>
                          <span className="text-faint"> </span>
                          <span className={deepRead.has(f.path) ? "text-accent" : "text-faint"}>
                            {deepRead.has(f.path) ? "●" : "·"}
                          </span>
                        </span>
                        <span className={isPayload ? "text-warning" : undefined}>{short}</span>
                        {f.kind === "binary" && (
                          <span className="text-faint">binary · not utf-8</span>
                        )}
                        {isPayload && <span className="text-warning">← payload</span>}
                      </button>
                    );
                  })}
                </li>
              ))}
            </ul>
          </div>

          <p className="mt-2 font-mono text-xs text-faint">
            {payload ? (
              <>
                payload staged in <span className="text-warning">{payload}</span> ·{" "}
                {shallowRead.has(payload) ? (
                  <span className="text-body">opened by both</span>
                ) : deepRead.has(payload) ? (
                  <span className="text-accent">opened by B only</span>
                ) : (
                  <span className="text-error">opened by neither</span>
                )}
              </>
            ) : (
              "nothing staged — an empty package"
            )}
          </p>
        </div>

        {/* ------------------------------------------------------ verdicts */}
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Verdict
            title="A · scripts only"
            subtitle="checkInstallScripts on the root manifest"
            run={shallow}
          />
          <Verdict
            title="B · binaries + graph"
            subtitle="every package, every readable file"
            run={deep}
            accent
          />
        </div>

        {/* --------------------------------------------------- file detail */}
        {selectedFile && (
          <div className="mt-5 rounded-sm border border-hair-soft">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hair-soft px-3 py-2">
              <p className="font-mono text-xs text-body">{selectedFile.path}</p>
              <p className="font-mono text-xs text-faint">
                {selectedFindings.length} finding{selectedFindings.length === 1 ? "" : "s"}
              </p>
            </div>
            <div className="overflow-x-auto px-3 py-2">
              {selectedFile.text === null ? (
                <p className="max-w-[62ch] font-mono text-xs text-faint">
                  Compiled addon. There is no text to match — and its extension is not in{" "}
                  <span className="text-body">JS_EXTENSIONS</span>, so scanPackageDir never
                  calls readFile on it in the first place.
                </p>
              ) : (
                <pre className="min-w-max font-mono text-xs leading-relaxed text-muted">
                  {selectedFile.text.split("\n").map((line, i) => (
                    <div key={i}>
                      <span className="mr-3 inline-block w-5 text-right text-faint tabular-nums">
                        {i + 1}
                      </span>
                      {line}
                    </div>
                  ))}
                </pre>
              )}
            </div>
            {selectedFindings.length > 0 && (
              <ul className="border-t border-hair-soft px-3 py-2">
                {selectedFindings.map((f, i) => (
                  <li key={i} className="font-mono text-xs">
                    <span className={SEVERITY_CLASS[f.severity]}>
                      {f.severity === "error" ? "[ERROR]" : f.severity === "warn" ? "[WARN] " : "[INFO] "}
                    </span>{" "}
                    <span className="text-body">{f.detail}</span>
                    {f.line != null && <span className="text-faint">:{f.line}</span>}
                    <span className="text-faint"> · {f.rule}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ------------------------------------------------------- honesty */}
        <p className="mt-5 max-w-[62ch] text-sm text-muted">
          Column B goes past the shipped scanner in two places, both marked above with{" "}
          <span className="text-note">†</span>. The real{" "}
          <span className="font-mono text-xs text-body">scanNpmProject</span> reads only the
          top level of <span className="font-mono text-xs text-body">node_modules</span>, and
          its file walk returns early on any directory named{" "}
          <span className="font-mono text-xs text-body">node_modules</span>; the name rules
          run over the root manifest&rsquo;s declared dependencies only. So a package two
          levels down is invisible to it as well. That is the same gap as the binary one,
          seen from the other side: reach, rather than readability.
        </p>
        <p className="mt-3 max-w-[62ch] text-sm text-muted">
          One more thing the columns make visible: the binding.gyp rule is severity{" "}
          <span className="font-mono text-xs text-warning">warn</span>, and{" "}
          <span className="font-mono text-xs text-body">cli.ts</span> exits non-zero only on
          an <span className="font-mono text-xs text-error">error</span>. A package whose
          only finding is &ldquo;this compiles a native addon at install time&rdquo; reports
          the fact and still exits 0.
        </p>
        <p className="mt-3 max-w-[62ch] text-xs text-faint">
          The file bodies are inert placeholders written for this demo — the only URL points
          at a reserved <span className="font-mono">.invalid</span> domain, nothing is
          executed, and the component makes no network calls. Package-confusion strategies
          (Neupane et al.) and the PyPI and Rust scanners are in the take-home but not in
          this port.
        </p>
      </div>
    </section>
  );
}

function Verdict({
  title,
  subtitle,
  run,
  accent,
}: {
  title: string;
  subtitle: string;
  run: Run;
  accent?: boolean;
}) {
  const code = exitCode(run);
  const errors = run.findings.filter((f) => f.severity === "error").length;
  const warns = run.findings.filter((f) => f.severity === "warn").length;

  return (
    <div className={`rounded-sm border ${accent ? "border-accent" : "border-hair"}`}>
      <div className="border-b border-hair-soft px-3 py-2">
        <p className={`font-mono text-xs ${accent ? "text-accent" : "text-dim"}`}>{title}</p>
        <p className="mt-0.5 font-mono text-xs text-faint">{subtitle}</p>
      </div>

      <div className="px-3 py-2">
        <p className="font-mono text-xs">
          <span className={code === 0 ? "text-body" : "text-error"}>
            exit {code}
          </span>
          <span className="text-faint">
            {" "}
            · {code === 0 ? "install proceeds" : "install blocked"}
          </span>
        </p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 font-mono text-xs">
          <dt className="text-faint">packages</dt>
          <dd className="tabular-nums text-dim">{run.nodesVisited}</dd>
          <dt className="text-faint">files opened</dt>
          <dd className="tabular-nums text-dim">{run.filesRead.length}</dd>
          <dt className="text-faint">rules run</dt>
          <dd className="tabular-nums text-dim">{run.rulesEvaluated}</dd>
          <dt className="text-faint">findings</dt>
          <dd className="tabular-nums text-dim">
            {run.findings.length}
            {run.findings.length > 0 && (
              <span className="text-faint">
                {" "}
                ({errors} error, {warns} warn)
              </span>
            )}
          </dd>
        </dl>
      </div>

      <ul className="border-t border-hair-soft px-3 py-2">
        {run.findings.length === 0 && (
          <li className="font-mono text-xs text-faint">No issues found.</li>
        )}
        {run.findings.map((f, i) => (
          <li key={i} className="mb-1.5 font-mono text-xs last:mb-0">
            <span className={SEVERITY_CLASS[f.severity]}>
              {f.severity === "error" ? "[ERROR]" : f.severity === "warn" ? "[WARN] " : "[INFO] "}
            </span>{" "}
            <span className="text-body">{f.detail}</span>
            <span className="text-faint">
              {" "}
              · {f.package}
              {f.line != null ? `:${f.line}` : ""}
            </span>
            <span className="block text-faint">
              {f.rule}
              {f.extended && <span className="text-note"> †</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
