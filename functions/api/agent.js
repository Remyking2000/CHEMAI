/**
 * ==============================================================================
 * ChemAI — Central Chemistry Agent Core (Phase 1 & Phase 2B)
 * ------------------------------------------------------------------------------
 * A controlled, tool-using agent loop. The AI model decides whether it can answer
 * directly or whether it needs one of the registered chemistry or editor tools.
 *
 * Tools have clear runtime separation:
 *   - "server": executed in-process on Cloudflare Workers (generate_structure,
 *               identify_structure, lookup_structure, analyze_compound, explain_structure).
 *   - "client": dispatched to the user's browser editor bridge via a controlled
 *               action-required handshake (read_editor_structure,
 *               load_structure_into_editor, fit_canvas_view, get_editor_capabilities).
 *
 * Two execution modes:
 *   - "native":     OpenRouter OpenAI-compatible function calling (`tools` param),
 *                   used only when the model's endpoints advertise tool support.
 *   - "structured": validated JSON-action fallback over the existing `callAI`
 *                   gateway, for models/providers without function calling.
 *
 * Safety: allowlisted tool names, schema-validated arguments, bounded iterations,
 * per-call and total time budgets, user approval boundaries for canvas overwrites,
 * truncated tool output, no arbitrary code execution, and no logging of keys.
 * ==============================================================================
 */

export const AGENT_LIMITS = Object.freeze({
  MAX_TOOL_ITERATIONS: 4, // model turns that may request tools
  MAX_CALLS_PER_ITERATION: 3, // parallel tool calls honoured per turn
  MAX_MESSAGE_CHARS: 8000,
  MAX_HISTORY_MESSAGES: 12,
  MAX_HISTORY_CHARS_PER_MESSAGE: 2000,
  MAX_TOOL_RESULT_CHARS: 6000,
  MAX_REPLY_CHARS: 20000,
  MODEL_TIMEOUT_MS: 12000,
  TOOL_TIMEOUT_MS: 20000,
  CAPABILITY_TIMEOUT_MS: 4000,
  TOTAL_BUDGET_MS: 60000, // hard wall-clock budget for the whole request
  FINAL_ANSWER_RESERVE_MS: 12000, // stop starting new tool rounds when less than this remains
  MIN_MODEL_CALL_MS: 3000, // do not start a model call with less time than this
});

const DEFAULT_OPENROUTER_MODEL = "liquid/lfm-2.5-2.6b:free";

/* -------------------------------------------------------------------------- */
/* Structured error taxonomy (Phase 2C)                                       */
/* -------------------------------------------------------------------------- */

/**
 * Failure categories surfaced to the API response (`code`), the agent trace
 * (`errorType`) and deterministic user-facing summaries. Editor categories are
 * produced by the client bridge; AI categories are produced by the agent loop.
 */
export const AGENT_ERROR_TYPES = Object.freeze({
  AI_PROVIDER_UNAVAILABLE: "ai_provider_unavailable",
  AI_TIMEOUT: "ai_timeout",
  AI_INVALID_RESPONSE: "ai_invalid_response",
  INVALID_STRUCTURE: "invalid_structure",
  EDITOR_UNAVAILABLE: "editor_unavailable",
  REPLACEMENT_REJECTED: "replacement_rejected",
  EDITOR_OPERATION_FAILED: "editor_operation_failed",
  INVALID_CONTINUATION: "invalid_continuation",
});

const CLIENT_ERROR_TYPES = new Set([
  AGENT_ERROR_TYPES.INVALID_STRUCTURE,
  AGENT_ERROR_TYPES.EDITOR_UNAVAILABLE,
  AGENT_ERROR_TYPES.REPLACEMENT_REJECTED,
  AGENT_ERROR_TYPES.EDITOR_OPERATION_FAILED,
]);

const AGENT_ERROR_MESSAGES = Object.freeze({
  [AGENT_ERROR_TYPES.AI_PROVIDER_UNAVAILABLE]:
    "The AI service is currently unavailable, so your request could not be processed. No editor actions were performed and your drawing was not changed. Please try again in a moment.",
  [AGENT_ERROR_TYPES.AI_TIMEOUT]:
    "The AI service did not respond within the time limit, so your request could not be processed. No editor actions were performed and your drawing was not changed. Please try again.",
  [AGENT_ERROR_TYPES.AI_INVALID_RESPONSE]:
    "The AI service returned an invalid response, so your request could not be processed. No editor actions were performed and your drawing was not changed. Please try again.",
  [AGENT_ERROR_TYPES.INVALID_CONTINUATION]:
    "The editor action could not be resumed. No further changes were made. Please resend your message.",
});

const AGENT_ERROR_STATUS = Object.freeze({
  [AGENT_ERROR_TYPES.AI_PROVIDER_UNAVAILABLE]: 502,
  [AGENT_ERROR_TYPES.AI_TIMEOUT]: 504,
  [AGENT_ERROR_TYPES.AI_INVALID_RESPONSE]: 502,
  [AGENT_ERROR_TYPES.INVALID_CONTINUATION]: 400,
});

/** Error thrown by runAgent when a request cannot be completed truthfully. */
export class AgentError extends Error {
  constructor(type, details) {
    super(AGENT_ERROR_MESSAGES[type] || "ChemAI agent could not complete the request.");
    this.name = "AgentError";
    this.type = type;
    this.status = AGENT_ERROR_STATUS[type] || 502;
    this.details = details ? sanitizeText(String(details)) : undefined;
  }
}

function isTimeoutError(err) {
  return Boolean(err && (err.code === "TIMEOUT" || err.name === "AbortError" || /timed out/i.test(err.message || "")));
}

/** Picks the most specific category for a list of per-attempt AI failures. */
function summarizeAiFailures(failures) {
  if (!failures.length) return { type: AGENT_ERROR_TYPES.AI_PROVIDER_UNAVAILABLE, details: "No AI provider responded." };
  const types = new Set(failures.map((f) => f.type));
  const type = types.size === 1 ? failures[0].type : AGENT_ERROR_TYPES.AI_PROVIDER_UNAVAILABLE;
  return { type, details: failures.map((f) => f.detail).filter(Boolean).join("; ").slice(0, 500) };
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

export function sanitizeText(msg) {
  if (!msg || typeof msg !== "string") return "Unknown error";
  return msg
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, "[REDACTED_KEY]")
    .replace(/sk-or-v1-[0-9a-zA-Z]{20,}/g, "[REDACTED_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9\-_.]+/gi, "Bearer [REDACTED]");
}

function truncate(str, max) {
  if (typeof str !== "string") return str;
  return str.length > max ? `${str.slice(0, max)}… [truncated]` : str;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`${label} timed out after ${ms} ms`);
        err.code = "TIMEOUT";
        reject(err);
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function fetchWithTimeout(fetchImpl, url, options, ms) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), ms) : null;
  try {
    return await fetchImpl(url, controller ? { ...options, signal: controller.signal } : options);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Continuation Token (stateless handshake for client tool execution)         */
/* -------------------------------------------------------------------------- */

export function createContinuationToken(payload) {
  const jsonStr = JSON.stringify({
    ts: Date.now(),
    ...payload,
  });
  if (typeof Buffer !== "undefined") {
    return Buffer.from(jsonStr, "utf-8").toString("base64url");
  }
  const bytes = new TextEncoder().encode(jsonStr);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeContinuationToken(token) {
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Missing or empty continuation token.");
  }
  let jsonStr = "";
  try {
    let base64 = token.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) base64 += "=";
    if (typeof Buffer !== "undefined") {
      jsonStr = Buffer.from(base64, "base64").toString("utf-8");
    } else {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
      jsonStr = new TextDecoder().decode(bytes);
    }
  } catch {
    throw new Error("Malformed continuation token.");
  }

  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    throw new Error("Invalid continuation token payload.");
  }

  if (!data || typeof data !== "object") {
    throw new Error("Invalid continuation token structure.");
  }

  if (typeof data.ts === "number" && Date.now() - data.ts > 10 * 60 * 1000) {
    throw new Error("Continuation token has expired. Please resubmit your request.");
  }

  return data;
}

/* -------------------------------------------------------------------------- */
/* Argument validation (minimal JSON-Schema subset, no dependencies)          */
/* -------------------------------------------------------------------------- */

export function validateArgs(schema, args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "Arguments must be a JSON object." };
  }
  const props = schema.properties || {};
  const errors = [];
  const value = {};

  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) {
      errors.push(`Unexpected argument "${key}".`);
    }
  }
  for (const req of schema.required || []) {
    const v = args[req];
    if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
      errors.push(`Missing required argument "${req}".`);
    }
  }
  for (const [key, spec] of Object.entries(props)) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    if (spec.type === "string") {
      if (typeof v !== "string") {
        errors.push(`"${key}" must be a string.`);
        continue;
      }
      const t = v.trim();
      if (spec.minLength && t.length < spec.minLength) errors.push(`"${key}" is too short.`);
      if (spec.maxLength && t.length > spec.maxLength) {
        errors.push(`"${key}" exceeds ${spec.maxLength} characters.`);
      }
      if (spec.enum && !spec.enum.includes(t)) {
        errors.push(`"${key}" must be one of: ${spec.enum.join(", ")}.`);
      }
      if (spec.pattern && !new RegExp(spec.pattern).test(t)) {
        errors.push(`"${key}" contains unsupported characters.`);
      }
      value[key] = t;
    } else {
      errors.push(`Unsupported schema type for "${key}".`);
    }
  }
  return errors.length ? { ok: false, error: errors.join(" ") } : { ok: true, value };
}

/**
 * Lightweight SMILES syntax sanity check (NOT chemical validation).
 * Checks allowed characters, balanced branches/brackets, and paired ring closures.
 */
export function checkSmilesSyntax(smiles) {
  const issues = [];
  if (typeof smiles !== "string" || !smiles.trim()) {
    return { plausible: false, issues: ["Empty SMILES."], note: "Basic syntax check only." };
  }
  const s = smiles.trim();
  if (!/^[A-Za-z0-9@+\-[\]()=#$/\\%.:*]+$/.test(s)) issues.push("Contains characters not used in SMILES.");
  let depth = 0;
  let inBracket = false;
  const ringCounts = {};
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "[") {
      if (inBracket) issues.push("Nested '[' bracket.");
      inBracket = true;
    } else if (ch === "]") {
      if (!inBracket) issues.push("Unmatched ']' bracket.");
      inBracket = false;
    } else if (inBracket) {
      continue;
    } else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0) issues.push("Unmatched ')' branch.");
    } else if (ch === "%" && /\d\d/.test(s.slice(i + 1, i + 3))) {
      const label = s.slice(i + 1, i + 3);
      ringCounts[label] = (ringCounts[label] || 0) + 1;
      i += 2;
    } else if (/\d/.test(ch)) {
      ringCounts[ch] = (ringCounts[ch] || 0) + 1;
    }
  }
  if (inBracket) issues.push("Unclosed '[' bracket.");
  if (depth > 0) issues.push("Unclosed '(' branch.");
  for (const [label, count] of Object.entries(ringCounts)) {
    if (count % 2 !== 0) issues.push(`Ring-closure label ${label} is unpaired.`);
  }
  return {
    plausible: issues.length === 0,
    issues: [...new Set(issues)],
    note: "Basic syntax check only; does not verify valence or chemical identity.",
  };
}

/* -------------------------------------------------------------------------- */
/* Tool registry                                                              */
/* -------------------------------------------------------------------------- */

const SMILES_PATTERN = "^[A-Za-z0-9@+\\-\\[\\]()=#$/\\\\%.:*]+$";

/**
 * Builds the allowlisted tool registry.
 *
 * `handlers` must expose async functions that invoke the EXISTING route handlers
 * and resolve to `{ ok, status, data }`:
 *   generateStructure(body, env), identify(body, env), lookupStructure(body, env),
 *   analyze(body, env), explainStructure(body, env)
 *
 * Every tool declares `runtime`:
 *   - "server": executed in-process on Cloudflare Workers by invokeHandler.
 *   - "client": dispatched to the user's browser editor bridge via action-required
 *               continuation handshake (read_editor_structure, load_structure_into_editor,
 *               fit_canvas_view, get_editor_capabilities).
 */
export function createToolRegistry(handlers) {
  const fail = (r, fallback) => ({
    ok: false,
    status: r?.status,
    code: r?.data?.code,
    error: sanitizeText(r?.data?.error || fallback || `Request failed with status ${r?.status}`),
  });

  const tools = [
    {
      name: "generate_structure",
      runtime: "server",
      provenance: "ai_generated_hypothesis",
      description:
        "Propose a molecular structure (SMILES) for a compound name, formula, or specific chemical description using the AI structure generator. The result is an UNVERIFIED hypothesis; confirm with identify_structure when identity matters.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: 150,
            description: "Compound name, molecular formula, or specific description (max 150 chars).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute({ query }, ctx) {
        const r = await handlers.generateStructure({ query }, ctx.env);
        if (!r.ok || !r.data?.candidate) return fail(r, "Structure generation failed.");
        const c = r.data.candidate;
        return {
          ok: true,
          data: {
            proposedName: c.proposedName,
            smiles: c.smiles,
            molecularFormula: c.molecularFormula,
            reasoningSummary: truncate(c.reasoningSummary || "", 800),
            uncertaintyNote: truncate(c.uncertaintyNote || "", 500),
            smilesSyntaxCheck: checkSmilesSyntax(c.smiles),
            verificationStatus: "unverified_ai_hypothesis",
          },
        };
      },
    },
    {
      name: "identify_structure",
      runtime: "server",
      provenance: "external_reference_pubchem",
      description:
        "Identify a structure given as SMILES against PubChem and return reference identity data (CID, name, formula, molecular weight, canonical SMILES, IUPAC name). Use when a reliable identity or reference check is needed.",
      parameters: {
        type: "object",
        properties: {
          smiles: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            pattern: SMILES_PATTERN,
            description: "SMILES string of the molecule.",
          },
        },
        required: ["smiles"],
        additionalProperties: false,
      },
      async execute({ smiles }, ctx) {
        const r = await handlers.identify({ smiles }, ctx.env);
        if (!r.ok) return fail(r, "Identification failed.");
        const d = r.data || {};
        return {
          ok: true,
          data: {
            cid: d.cid,
            name: d.name,
            molecularFormula: d.molecularFormula,
            molecularWeight: d.molecularWeight,
            canonicalSmiles: d.canonicalSmiles,
            iupacName: d.iupacName,
            summary: d.wikipedia?.extract ? truncate(d.wikipedia.extract, 600) : undefined,
            source: d.source,
            verificationStatus: "matched_in_reference_database",
          },
        };
      },
    },
    {
      name: "lookup_structure",
      runtime: "server",
      provenance: "external_reference_pubchem",
      description:
        "Search PubChem by compound name or molecular formula and return candidate structures with SMILES, formula, and molecular weight. Use for candidate structures or external confirmation.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: 150,
            description: "Compound name or molecular formula.",
          },
          type: {
            type: "string",
            enum: ["auto", "name", "formula"],
            description: "Query type (default auto).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute({ query, type }, ctx) {
        const r = await handlers.lookupStructure({ query, type: type || "auto" }, ctx.env);
        if (!r.ok) return fail(r, "Lookup failed.");
        const d = r.data || {};
        return {
          ok: true,
          data: {
            query: d.query,
            queryType: d.queryType,
            candidates: (d.candidates || []).slice(0, 5),
            source: d.source,
          },
        };
      },
    },
    {
      name: "analyze_compound",
      runtime: "server",
      provenance: "external_reference_pubchem",
      description:
        "Retrieve deterministic reference properties (molecular formula, molecular weight, CID, SMILES) for a named compound from PubChem.",
      parameters: {
        type: "object",
        properties: {
          compound: {
            type: "string",
            minLength: 1,
            maxLength: 150,
            description: "Compound name.",
          },
        },
        required: ["compound"],
        additionalProperties: false,
      },
      async execute({ compound }, ctx) {
        const r = await handlers.analyze({ compound }, ctx.env);
        if (!r.ok) return fail(r, "Analysis failed.");
        return { ok: true, data: r.data };
      },
    },
    {
      name: "explain_structure",
      runtime: "server",
      provenance: "ai_interpretation_grounded_in_pubchem_identity",
      description:
        "Produce a structured educational explanation (classification, functional groups, bonding, significance) of a molecule given as SMILES. The identity is confirmed via PubChem; the explanation itself is AI interpretation. Only use when a structured explanation of a specific molecule is needed.",
      parameters: {
        type: "object",
        properties: {
          smiles: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            pattern: SMILES_PATTERN,
            description: "SMILES string of the molecule.",
          },
        },
        required: ["smiles"],
        additionalProperties: false,
      },
      async execute({ smiles }, ctx) {
        const r = await handlers.explainStructure({ smiles }, ctx.env);
        if (!r.ok) return fail(r, "Explanation failed.");
        const d = r.data || {};
        return {
          ok: true,
          data: {
            compound: d.compound
              ? {
                  cid: d.compound.cid,
                  name: d.compound.name,
                  molecularFormula: d.compound.molecularFormula,
                  molecularWeight: d.compound.molecularWeight,
                  canonicalSmiles: d.compound.canonicalSmiles,
                }
              : undefined,
            explanation: d.explanation,
          },
        };
      },
    },
    {
      name: "read_editor_structure",
      runtime: "client",
      provenance: "client_editor_bridge",
      description:
        "Read the current molecular structure drawn on the user's active molecular editor canvas. Returns the current SMILES, formula, atom/bond counts, and whether the canvas contains a molecule. Use this whenever the user asks about what they drew, their canvas, or 'this structure'.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "load_structure_into_editor",
      runtime: "client",
      provenance: "client_editor_bridge",
      description:
        "Load a validated molecular structure (SMILES) into the user's active molecular editor canvas. If the canvas already contains a structure, the user will be prompted for approval before replacing it. Center and fit will automatically be applied. Use this when the user asks to draw, build, or load a molecule into the editor.",
      parameters: {
        type: "object",
        properties: {
          smiles: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            pattern: SMILES_PATTERN,
            description: "Validated SMILES string of the molecule to load into the editor.",
          },
        },
        required: ["smiles"],
        additionalProperties: false,
      },
    },
    {
      name: "fit_canvas_view",
      runtime: "client",
      provenance: "client_editor_bridge",
      description:
        "Center and zoom-to-fit the visible canvas view around the molecule in the active editor. Does not modify the molecular structure. Use when the user asks to center, frame, or zoom their drawing.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "get_editor_capabilities",
      runtime: "client",
      provenance: "client_editor_bridge",
      description:
        "Inspect the capabilities, readiness status, and active view mode (desktop or mobile) of the user's molecular editor.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ];

  return new Map(tools.map((t) => [t.name, t]));
}

function toOpenAITools(registry) {
  return [...registry.values()]
    .map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}

/* -------------------------------------------------------------------------- */
/* Prompts                                                                    */
/* -------------------------------------------------------------------------- */

export function buildAgentSystemPrompt(compound, registry, mode) {
  // Base persona preserved from the original /api/chat handler.
  let prompt = `You are ChemAI, an expert chemistry learning assistant for university and research chemistry.
Your role: Explain chemical principles clearly, accurately, and conceptually.
Answer general chemistry inquiries (thermodynamics, mechanisms, stereochemistry, orbitals) thoroughly.`;

  // Compound block kept first and in its original format (the deterministic
  // fallback responder in callAI parses these exact labels).
  if (compound) {
    prompt += `\n\nATTACHED VERIFIED COMPOUND CONTEXT:
Name: ${compound.name || "N/A"}
Formula: ${compound.formula || "N/A"}
Molecular Weight: ${compound.weight || "N/A"}
PubChem CID: ${compound.cid || "N/A"}
Canonical SMILES: ${compound.smiles || "N/A"}
IUPAC: ${compound.iupac || "N/A"}
Description: ${compound.description || "N/A"}

Anchor your explanations to this molecule when relevant. Distinguish verified facts from general reasoning. If the user refers to "this molecule" or "the drawn structure", use the SMILES above as the primary input.`;
  }

  prompt += `

TOOL USE POLICY (you decide):
- Answer directly, without tools, whenever you can do so reliably from chemistry knowledge (concepts, mechanisms, trends, general explanations).
- Call a tool only when it supplies evidence or performs actions you actually need:
  * Server tools: generate_structure, identify_structure, lookup_structure, analyze_compound, explain_structure.
  * Client editor tools: read_editor_structure, load_structure_into_editor, fit_canvas_view, get_editor_capabilities.
- To inspect or answer questions about what the user has drawn on the canvas, call read_editor_structure. Inspect its result (smiles, atomCount, isEmpty). If the user asks for identity or explanation, take the returned SMILES and call identify_structure or explain_structure.
- To draw or load a molecule into the user's editor, first obtain or verify its SMILES (using lookup_structure or generate_structure if needed), then call load_structure_into_editor with the SMILES.
- To center, frame, or fit the canvas view, call fit_canvas_view.
- Gather only what the user's goal requires. Inspect each tool result before deciding the next step. You may call several tools in sequence (at most ${AGENT_LIMITS.MAX_TOOL_ITERATIONS} tool rounds).
- Never describe an AI-generated structure as verified unless a reference tool (identify_structure, lookup_structure, analyze_compound) confirmed it.
- In the final answer, clearly separate reference data retrieved from external sources (e.g. PubChem) from your own interpretation, and state uncertainty where appropriate.
- If a client editor tool reports that the editor is unavailable (e.g. user is in standalone chat without an active editor), clearly explain that no editor is currently open on this page and answer conceptually or suggest opening the Molecular Editor at /editor.
- If a client editor tool reports that structure replacement was declined or cancelled by the user, respect their decision and explain what was kept.
- If read_editor_structure reports an empty canvas (0 atoms), inform the user that the canvas is currently blank.
- If a tool fails, try one reasonable alternative or explain the limitation. Never repeat an identical failed call.
- Never state or imply that an editor action (loading, reading, centering) was performed unless a client editor tool result in this conversation reports ok: true for it. If an editor tool failed, say so plainly, give the reported reason (errorType/error), and do not retry an editor action that changes the drawing.`;

  if (mode === "structured") {
    const toolLines = [...registry.values()]
      .map((t) => {
        const props = t.parameters?.properties || {};
        const args = Object.entries(props)
          .map(([k, v]) => `${k}${t.parameters.required?.includes(k) ? "" : "?"}: ${v.type}${v.enum ? ` (${v.enum.join("|")})` : ""}`)
          .join(", ");
        const tag = t.runtime === "client" ? " [client editor tool]" : " [server tool]";
        return `- ${t.name}(${args})${tag} — ${t.description}`;
      })
      .join("\n");
    prompt += `

AVAILABLE TOOLS:
${toolLines}

RESPONSE PROTOCOL:
- To call a tool, reply with ONLY this JSON object and nothing else:
  {"action":"call_tool","tool":"<tool_name>","arguments":{...}}
- To answer the user, reply with your final answer in plain Markdown (no JSON wrapper).`;
  }

  return prompt;
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const h of history) {
    const raw = h?.content ?? h?.text;
    const content = typeof raw === "string" ? raw.trim() : "";
    if (!content) continue;
    out.push({
      role: h.role === "assistant" || h.sender === "assistant" ? "assistant" : "user",
      content: truncate(content, AGENT_LIMITS.MAX_HISTORY_CHARS_PER_MESSAGE),
    });
  }
  return out.slice(-AGENT_LIMITS.MAX_HISTORY_MESSAGES);
}

function serializeToolResult(step) {
  const payload = {
    tool: step.name,
    ok: step.result.ok,
    provenance: step.result.provenance,
    ...(step.result.ok ? { data: step.result.data } : { error: step.result.error }),
    ...(step.result.errorType ? { errorType: step.result.errorType } : {}),
    ...(step.result.note ? { note: step.result.note } : {}),
  };
  return truncate(JSON.stringify(payload), AGENT_LIMITS.MAX_TOOL_RESULT_CHARS);
}

/* -------------------------------------------------------------------------- */
/* Structured-action parsing (fallback mode)                                  */
/* -------------------------------------------------------------------------- */

export function parseStructuredAction(text) {
  if (typeof text !== "string") return { type: "final", text: "" };
  const trimmed = text.trim();
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  // Only treat as an action if the reply is essentially a single JSON object.
  if (start === -1 || end <= start || start > 20 || cleaned.length - end > 20) {
    return { type: "final", text: trimmed };
  }
  let obj;
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return { type: "final", text: trimmed };
  }
  if (obj && obj.action === "call_tool" && typeof obj.tool === "string") {
    return {
      type: "tool_calls",
      calls: [{ name: obj.tool, arguments: obj.arguments ?? {} }],
      content: "",
    };
  }
  if (obj && obj.action === "final" && typeof obj.answer === "string") {
    return { type: "final", text: obj.answer };
  }
  return { type: "final", text: trimmed };
}

/* -------------------------------------------------------------------------- */
/* OpenRouter native tool-calling adapter                                     */
/* -------------------------------------------------------------------------- */

// Per-isolate cache of model tool-calling capability: model -> { supported, at }
const capabilityCache = new Map();
const CAPABILITY_TTL_MS = 60 * 60 * 1000;

export function _resetCapabilityCache() {
  capabilityCache.clear();
}

function openRouterKey(env) {
  const k = typeof env?.OPENROUTER_API_KEY === "string" ? env.OPENROUTER_API_KEY.trim() : "";
  return k && !k.startsWith("your_") ? k : "";
}

function openRouterModels(env) {
  const primary = env?.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
  return [
    primary,
    DEFAULT_OPENROUTER_MODEL,
    "nvidia/nemotron-3.5-lightning:free",
    "openrouter/free",
  ].filter((v, i, a) => a.indexOf(v) === i);
}

/** Inspects OpenRouter model endpoints for `tools` support. Returns true/false/null (unknown). */
export async function getToolSupport(model, env, fetchImpl, now = Date.now) {
  const cached = capabilityCache.get(model);
  if (cached && now() - cached.at < CAPABILITY_TTL_MS) return cached.supported;
  let supported = null;
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `https://openrouter.ai/api/v1/models/${model}/endpoints`,
      { headers: { Authorization: `Bearer ${openRouterKey(env)}` } },
      AGENT_LIMITS.CAPABILITY_TIMEOUT_MS
    );
    if (res.ok) {
      const json = await res.json();
      const endpoints = json?.data?.endpoints;
      if (Array.isArray(endpoints) && endpoints.length) {
        supported = endpoints.some(
          (ep) =>
            Array.isArray(ep.supported_parameters) &&
            ep.supported_parameters.includes("tools") &&
            (typeof ep.status !== "number" || ep.status >= 0)
        );
      }
    }
  } catch {
    supported = null;
  }
  capabilityCache.set(model, { supported, at: now() });
  return supported;
}

function buildNativeMessages({ systemPrompt, history, message, steps, forceFinal }) {
  const messages = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: message }];
  const turns = new Map();
  for (const s of steps) {
    if (!turns.has(s.turn)) turns.set(s.turn, []);
    turns.get(s.turn).push(s);
  }
  for (const group of turns.values()) {
    messages.push({
      role: "assistant",
      content: group[0].assistantContent || null,
      tool_calls: group.map((s) => ({
        id: s.id,
        type: "function",
        function: { name: s.name, arguments: s.rawArguments },
      })),
    });
    for (const s of group) {
      messages.push({ role: "tool", tool_call_id: s.id, content: serializeToolResult(s) });
    }
  }
  if (forceFinal) {
    messages.push({
      role: "user",
      content:
        "[ChemAI system note] The tool budget for this request is exhausted. Do not call any more tools. Give your final answer now, stating clearly what was completed and what remains unresolved.",
    });
  }
  return messages;
}

async function nativeNext({ env, fetchImpl, registry, systemPrompt, history, message, steps, forceFinal, now, deadline, limits, failures }) {
  const key = openRouterKey(env);
  if (!key) return null;
  const tools = toOpenAITools(registry);
  const messages = buildNativeMessages({ systemPrompt, history, message, steps, forceFinal });

  for (const model of openRouterModels(env)) {
    if (deadline - now() < limits.MIN_MODEL_CALL_MS) return { type: "budget_exhausted" };
    const supported = await getToolSupport(model, env, fetchImpl, now);
    if (supported === false) continue;
    const callTimeout = Math.min(limits.MODEL_TIMEOUT_MS, deadline - now());
    if (callTimeout < limits.MIN_MODEL_CALL_MS) return { type: "budget_exhausted" };
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), callTimeout) : null;
    try {
      const res = await withTimeout(
        fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
            "HTTP-Referer": "https://chemai.ycremy2000.workers.dev",
            "X-Title": "ChemAI Lab Suite",
          },
          body: JSON.stringify({
            model,
            messages,
            tools,
            tool_choice: forceFinal ? "none" : "auto",
            temperature: 0.2,
            max_tokens: 1800,
          }),
          ...(controller ? { signal: controller.signal } : {}),
        }),
        callTimeout,
        `OpenRouter (${model})`
      );
      if (!res.ok) {
        const errText = await withTimeout(res.text(), 3000, "error body").catch(() => "");
        if ((res.status === 400 || res.status === 404) && /tool/i.test(errText)) {
          capabilityCache.set(model, { supported: false, at: now() });
        } else {
          failures?.push({
            type: res.status === 408 || res.status === 504 ? AGENT_ERROR_TYPES.AI_TIMEOUT : AGENT_ERROR_TYPES.AI_PROVIDER_UNAVAILABLE,
            detail: `OpenRouter (${model}) HTTP ${res.status}`,
          });
        }
        continue;
      }
      let data;
      try {
        data = await withTimeout(res.json(), Math.max(2000, deadline - now()), `OpenRouter body (${model})`);
      } catch (bodyErr) {
        failures?.push({
          type: isTimeoutError(bodyErr) ? AGENT_ERROR_TYPES.AI_TIMEOUT : AGENT_ERROR_TYPES.AI_INVALID_RESPONSE,
          detail: `OpenRouter (${model}) response body: ${sanitizeText(bodyErr?.message)}`,
        });
        continue;
      }
      const msg = data?.choices?.[0]?.message;
      if (!msg || typeof msg !== "object") {
        failures?.push({
          type: AGENT_ERROR_TYPES.AI_INVALID_RESPONSE,
          detail: `OpenRouter (${model}) returned no choices[0].message.`,
        });
        continue;
      }
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        return {
          type: "tool_calls",
          provider: "openrouter",
          model,
          content: typeof msg.content === "string" ? msg.content : "",
          calls: msg.tool_calls.map((tc) => ({
            id: tc.id,
            name: tc.function?.name,
            rawArguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
          })),
        };
      }
      if (typeof msg.content === "string" && msg.content.trim()) {
        return { type: "final", text: msg.content.trim(), provider: "openrouter", model };
      }
      failures?.push({
        type: AGENT_ERROR_TYPES.AI_INVALID_RESPONSE,
        detail: `OpenRouter (${model}) returned an empty completion.`,
      });
    } catch (err) {
      if (isTimeoutError(err)) {
        failures?.push({
          type: AGENT_ERROR_TYPES.AI_TIMEOUT,
          detail: `OpenRouter (${model}) timed out.`,
        });
      } else {
        capabilityCache.set(model, { supported: false, at: now() });
        failures?.push({
          type: AGENT_ERROR_TYPES.AI_PROVIDER_UNAVAILABLE,
          detail: `OpenRouter (${model}): ${sanitizeText(err?.message)}`,
        });
      }
      console.warn(`[ChemAI Agent] native call (${model}) failed:`, sanitizeText(err?.message));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Structured fallback adapter (uses the existing callAI gateway)             */
/* -------------------------------------------------------------------------- */

async function structuredNext({ env, callAI, systemPrompt, history, message, steps, forceFinal, now, deadline, limits, failures }) {
  const remaining = deadline - now();
  if (remaining < limits.MIN_MODEL_CALL_MS) return { type: "budget_exhausted" };
  const convo = [...history];
  let prompt = message;
  if (steps.length) {
    convo.push({ role: "user", content: message });
    steps.forEach((s, idx) => {
      convo.push({
        role: "assistant",
        content: JSON.stringify({ action: "call_tool", tool: s.name, arguments: s.parsedArguments ?? {} }),
      });
      const resultTurn = `[TOOL RESULT] ${serializeToolResult(s)}`;
      if (idx < steps.length - 1) convo.push({ role: "user", content: resultTurn });
      else prompt = resultTurn;
    });
    prompt += forceFinal
      ? "\n\nThe tool budget is exhausted. Reply now with your final answer in plain Markdown, stating what was completed and what remains unresolved."
      : "\n\nUsing this result, either call another tool (JSON only) or reply with your final answer in plain Markdown.";
  }

  let ai;
  try {
    ai = await withTimeout(
      callAI({ prompt, history: convo, systemPrompt, env }),
      remaining,
      "AI provider"
    );
  } catch (err) {
    const type = isTimeoutError(err) ? AGENT_ERROR_TYPES.AI_TIMEOUT : AGENT_ERROR_TYPES.AI_PROVIDER_UNAVAILABLE;
    failures?.push({ type, detail: sanitizeText(err?.message) });
    const summary = summarizeAiFailures(failures || [{ type, detail: err?.message }]);
    throw new AgentError(summary.type, summary.details);
  }

  if (Array.isArray(ai?.diagnostics)) {
    for (const d of ai.diagnostics) {
      if (d && d.type) failures?.push(d);
    }
  }

  // The deterministic last-resort responder cannot call tools or reason over tool results.
  if (ai?.provider === "chemai-assistant") {
    if (steps.length) {
      return { type: "final", text: summarizeSteps(steps, "ai_unavailable"), provider: ai.provider, model: ai.model };
    }
    const summary = summarizeAiFailures(failures || []);
    throw new AgentError(summary.type, summary.details);
  }

  const rawText = typeof ai?.text === "string" ? ai.text.trim() : "";
  if (!rawText) {
    failures?.push({ type: AGENT_ERROR_TYPES.AI_INVALID_RESPONSE, detail: "AI provider returned an empty response." });
    const summary = summarizeAiFailures(failures || []);
    throw new AgentError(summary.type, summary.details);
  }

  const parsed = forceFinal ? { type: "final", text: rawText } : parseStructuredAction(rawText);
  return { ...parsed, provider: ai?.provider, model: ai?.model };
}

/* -------------------------------------------------------------------------- */
/* Fallback summary when the loop cannot reach a model-written final answer   */
/* -------------------------------------------------------------------------- */

function classifyClientFailure(resPayload) {
  if (!resPayload || resPayload.ok) return undefined;
  if (typeof resPayload.errorType === "string" && CLIENT_ERROR_TYPES.has(resPayload.errorType)) {
    return resPayload.errorType;
  }
  if (resPayload.unavailable) return AGENT_ERROR_TYPES.EDITOR_UNAVAILABLE;
  if (resPayload.cancelled || resPayload.needsApproval) return AGENT_ERROR_TYPES.REPLACEMENT_REJECTED;
  if (typeof resPayload.error === "string" && /invalid smiles|empty structure|non-empty smiles|unsupported characters/i.test(resPayload.error)) {
    return AGENT_ERROR_TYPES.INVALID_STRUCTURE;
  }
  return AGENT_ERROR_TYPES.EDITOR_OPERATION_FAILED;
}

function describeClientStep(step) {
  const r = step.result || {};
  const d = r.data || {};
  if (r.ok) {
    if (step.name === "read_editor_structure") {
      if (d.isEmpty || d.atomCount === 0) {
        return "- **read_editor_structure**: read the editor canvas — the canvas is currently blank (0 atoms).";
      }
      const parts = [
        d.smiles && `SMILES \`${d.smiles}\``,
        d.formula && `formula ${d.formula}`,
        typeof d.atomCount === "number" && `${d.atomCount} atom(s)`,
      ].filter(Boolean);
      return `- **read_editor_structure**: read structure from the editor canvas (${parts.join(", ") || "non-empty"}).`;
    }
    if (step.name === "load_structure_into_editor") {
      const parts = [
        d.smiles && `SMILES \`${d.smiles}\``,
        d.formula && `formula ${d.formula}`,
        typeof d.atomCount === "number" && `${d.atomCount} atom(s)`,
      ].filter(Boolean);
      return `- **load_structure_into_editor**: loaded structure into the molecular editor (${parts.join(", ") || "confirmed"}).`;
    }
    if (step.name === "fit_canvas_view") {
      return "- **fit_canvas_view**: centered and framed the canvas view.";
    }
    if (step.name === "get_editor_capabilities") {
      return `- **get_editor_capabilities**: editor mode \`${d.viewMode || "unknown"}\`, ready: ${Boolean(d.isReady)}.`;
    }
  }
  const errType = r.errorType;
  if (errType === AGENT_ERROR_TYPES.EDITOR_UNAVAILABLE || r.unavailable) {
    return `- **${step.name}**: could not be completed because the molecular editor is not open on this page. Please open the **Molecular Editor** at \`/editor\` to perform canvas operations.`;
  }
  if (errType === AGENT_ERROR_TYPES.REPLACEMENT_REJECTED || r.cancelled) {
    return `- **${step.name}**: structure replacement was declined by the user. Your current drawing was kept unchanged.`;
  }
  if (errType === AGENT_ERROR_TYPES.INVALID_STRUCTURE) {
    return `- **${step.name}**: rejected invalid chemical structure (${r.error || "invalid SMILES"}). Your current drawing was not changed.`;
  }
  return `- **${step.name}**: editor operation could not be completed — ${r.error || "unexpected editor error"} Your current drawing was not changed.`;
}

function summarizeSteps(steps, reason) {
  const header =
    reason === "ai_unavailable"
      ? "I gathered the following information, but the AI model became unavailable before I could write a full answer:"
      : reason === "time_budget"
      ? "I ran out of time for this request. Here is what I completed:"
      : "I reached the tool-use limit for this request before completing the analysis. Here is what I completed:";
  const lines = steps.map((s) => {
    if (s.result?.provenance === "client_editor_bridge") {
      return describeClientStep(s);
    }
    const args = s.parsedArguments ? JSON.stringify(s.parsedArguments) : "";
    if (!s.result.ok) return `- **${s.name}** ${args}: failed — ${s.result.error}`;
    const d = s.result.data || {};
    const facts = [
      d.name || d.proposedName || d.compound,
      d.molecularFormula && `formula ${d.molecularFormula}`,
      d.molecularWeight && `MW ${d.molecularWeight}`,
      (d.canonicalSmiles || d.smiles || d.isomericSmiles) && `SMILES \`${d.canonicalSmiles || d.smiles || d.isomericSmiles}\``,
      d.verificationStatus === "unverified_ai_hypothesis" && "_(AI hypothesis, not verified)_",
      Array.isArray(d.candidates) && `${d.candidates.length} candidate(s)`,
    ]
      .filter(Boolean)
      .join(", ");
    return `- **${s.name}** ${args}: ${facts || "completed"} (source: ${s.result.provenance || "tool"})`;
  });
  return `${header}\n\n${lines.join("\n") || "- No tool steps completed."}\n\n**Unresolved:** the final interpretation of these results. Please try again or narrow the question.`;
}

/* -------------------------------------------------------------------------- */
/* Main agent loop                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Runs the controlled agent loop.
 * @returns {Promise<{reply:string, provider:string, model:string, agent:object}>}
 */
export async function runAgent({
  message,
  history = [],
  compound = null,
  sessionId = null,
  continuationToken = null,
  clientActionResult = null,
  env = {},
  registry,
  callAI,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  limits = AGENT_LIMITS,
}) {
  if (!registry || !callAI) throw new Error("Agent misconfigured: registry and callAI are required.");
  let started = now();
  let convHistory = normalizeHistory(history);
  let userMessage = truncate(String(message || "").trim(), limits.MAX_MESSAGE_CHARS);
  let activeCompound = compound;
  let activeSessionId = sessionId;
  let mode = openRouterKey(env) ? "native" : "structured";
  let steps = [];
  let trace = [];
  let iterations = 0;

  if (continuationToken) {
    let tokenData;
    try {
      tokenData = decodeContinuationToken(continuationToken);
    } catch (err) {
      throw new AgentError(AGENT_ERROR_TYPES.INVALID_CONTINUATION, err?.message);
    }
    userMessage = tokenData.message || userMessage;
    convHistory = Array.isArray(tokenData.history) ? tokenData.history : convHistory;
    activeCompound = tokenData.compound !== undefined ? tokenData.compound : activeCompound;
    activeSessionId = tokenData.sessionId || activeSessionId;
    steps = Array.isArray(tokenData.steps) ? tokenData.steps : [];
    trace = Array.isArray(tokenData.trace) ? tokenData.trace : [];
    iterations = typeof tokenData.iterations === "number" ? tokenData.iterations : iterations;
    mode = tokenData.mode || mode;
    if (typeof tokenData.started === "number") started = tokenData.started;

    if (!tokenData.pendingCall || !clientActionResult || typeof clientActionResult !== "object") {
      throw new AgentError(
        AGENT_ERROR_TYPES.INVALID_CONTINUATION,
        "Continuation is missing the client action result for the pending tool call."
      );
    }
    const pending = tokenData.pendingCall;
    if (
      (clientActionResult.id && clientActionResult.id !== pending.id) ||
      (clientActionResult.tool && clientActionResult.tool !== pending.name)
    ) {
      throw new AgentError(
        AGENT_ERROR_TYPES.INVALID_CONTINUATION,
        "Client action result does not match the pending tool call."
      );
    }
    const resPayload = clientActionResult.result || {};
    const isOk = Boolean(resPayload.ok);
    const errorType = isOk ? undefined : classifyClientFailure(resPayload);
    const errorMsg = isOk ? undefined : sanitizeText(resPayload.error || "Client tool execution failed.");
    const toolResult = {
      ok: isOk,
      provenance: "client_editor_bridge",
      ...(isOk ? { data: resPayload.data || {} } : { error: errorMsg }),
      ...(errorType ? { errorType } : {}),
      ...(resPayload.cancelled ? { cancelled: true } : {}),
      ...(resPayload.unavailable ? { unavailable: true } : {}),
      ...(resPayload.needsApproval ? { needsApproval: true } : {}),
    };

    steps.push({
      turn: iterations,
      id: pending.id,
      name: pending.name,
      rawArguments: pending.rawArguments,
      parsedArguments: pending.parsedArguments,
      assistantContent: pending.assistantContent || "",
      result: toolResult,
    });

    trace.push({
      name: pending.name,
      arguments: pending.parsedArguments,
      ok: isOk,
      rejected: Boolean(resPayload.rejected || errorType === AGENT_ERROR_TYPES.REPLACEMENT_REJECTED),
      ...(errorType ? { errorType } : {}),
      error: errorMsg,
      provenance: "client_editor_bridge",
      durationMs: 0,
    });

    console.info(`[ChemAI Agent] client_tool=${pending.name} ok=${isOk}${errorType ? ` errorType=${errorType}` : ""}`);
  }

  const deadline = started + limits.TOTAL_BUDGET_MS;
  const ctx = { env, compound: activeCompound };
  const failedSignatures = new Set();
  const resultCache = new Map();
  let provider = null;
  let model = null;
  let reply = null;
  let stopReason = null;

  // Populate failedSignatures from earlier steps (e.g. restored via continuationToken)
  for (const s of steps) {
    if (!s.result?.ok && s.parsedArguments && typeof s.parsedArguments === "object") {
      failedSignatures.add(`${s.name}:${stableStringify(s.parsedArguments)}`);
    }
  }

  const executeCall = async (call) => {
    const t0 = now();
    const tool = registry.get(call.name);
    let parsedArguments = call.arguments;
    let result;

    if (parsedArguments === undefined && typeof call.rawArguments === "string") {
      try {
        parsedArguments = call.rawArguments.trim() ? JSON.parse(call.rawArguments) : {};
      } catch {
        parsedArguments = undefined;
      }
    }

    if (!tool) {
      result = {
        ok: false,
        rejected: true,
        error: `Unknown tool "${String(call.name).slice(0, 60)}". Allowed tools: ${[...registry.keys()].join(", ")}.`,
      };
    } else if (tool.runtime !== "server") {
      result = { ok: false, rejected: true, error: `Tool "${tool.name}" cannot be executed by the server.` };
    } else if (parsedArguments === undefined) {
      result = { ok: false, rejected: true, error: "Tool arguments were not valid JSON." };
    } else {
      const v = validateArgs(tool.parameters, parsedArguments);
      if (!v.ok) {
        result = { ok: false, rejected: true, error: `Invalid arguments: ${v.error}` };
      } else {
        parsedArguments = v.value;
        const sig = `${tool.name}:${stableStringify(v.value)}`;
        if (failedSignatures.has(sig)) {
          result = {
            ok: false,
            rejected: true,
            error: "This identical call already failed in this request. Do not repeat it; try a different approach or explain the limitation.",
          };
        } else if (resultCache.has(sig)) {
          result = { ...resultCache.get(sig), note: "Duplicate call; returning the earlier result." };
        } else {
          try {
            const remaining = Math.max(1000, Math.min(limits.TOOL_TIMEOUT_MS, deadline - now()));
            result = await withTimeout(tool.execute(v.value, ctx), remaining, `Tool ${tool.name}`);
          } catch (err) {
            result = { ok: false, error: sanitizeText(err?.message || "Tool execution failed.") };
          }
          if (!result || typeof result !== "object") result = { ok: false, error: "Tool returned no result." };
          if (result.ok) resultCache.set(sig, result);
          else failedSignatures.add(sig);
        }
      }
    }
    result.provenance = result.provenance || tool?.provenance;
    const durationMs = now() - t0;
    trace.push({
      name: String(call.name || "").slice(0, 60),
      arguments: parsedArguments ?? truncate(String(call.rawArguments ?? ""), 200),
      ok: Boolean(result.ok),
      rejected: Boolean(result.rejected),
      error: result.ok ? undefined : result.error,
      provenance: result.provenance,
      durationMs,
    });
    console.info(`[ChemAI Agent] tool=${call.name} ok=${Boolean(result.ok)} ms=${durationMs}`);
    return { parsedArguments, result };
  };

  while (reply === null) {
    // Stop opening new tool rounds once only the final-answer reserve remains.
    const outOfTime = steps.length > 0 && deadline - now() < limits.FINAL_ANSWER_RESERVE_MS;
    const forceFinal = iterations >= limits.MAX_TOOL_ITERATIONS || outOfTime;
    const failures = [];
    const shared = { env, fetchImpl, registry, history: convHistory, message: userMessage, steps, forceFinal, now, callAI, deadline, limits, failures };

    let decision = null;
    if (mode === "native") {
      decision = await nativeNext({ ...shared, systemPrompt: buildAgentSystemPrompt(activeCompound, registry, "native") });
      if (!decision) mode = "structured";
    }
    if (mode === "structured") {
      try {
        decision = await structuredNext({ ...shared, systemPrompt: buildAgentSystemPrompt(activeCompound, registry, "structured") });
      } catch (err) {
        if (!steps.length) {
          if (err instanceof AgentError) throw err;
          const summary = summarizeAiFailures(
            failures.length
              ? failures
              : [{ type: isTimeoutError(err) ? AGENT_ERROR_TYPES.AI_TIMEOUT : AGENT_ERROR_TYPES.AI_PROVIDER_UNAVAILABLE, detail: err?.message }]
          );
          throw new AgentError(summary.type, summary.details);
        }
        decision = { type: "final", text: summarizeSteps(steps, "ai_unavailable") };
      }
    }

    if (decision.type === "budget_exhausted") {
      if (!steps.length) {
        throw new AgentError(AGENT_ERROR_TYPES.AI_TIMEOUT, "The AI model did not respond within the time limit.");
      }
      reply = summarizeSteps(steps, "time_budget");
      stopReason = "time_budget";
      break;
    }

    provider = decision.provider || provider;
    model = decision.model || model;

    if (decision.type === "final") {
      reply = decision.text || (steps.length ? summarizeSteps(steps, "ai_unavailable") : "");
      stopReason = forceFinal ? (outOfTime ? "time_budget" : "iteration_limit") : "final_answer";
      break;
    }

    if (forceFinal) {
      // Model still asked for tools after the budget was exhausted.
      reply = summarizeSteps(steps, outOfTime ? "time_budget" : "iteration_limit");
      stopReason = outOfTime ? "time_budget" : "iteration_limit";
      break;
    }

    iterations += 1;
    const calls = Array.isArray(decision.calls) ? decision.calls : [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const id = call.id || `call_${iterations}_${i}`;
      let parsedArguments = call.arguments;

      if (parsedArguments === undefined && typeof call.rawArguments === "string") {
        try {
          parsedArguments = call.rawArguments.trim() ? JSON.parse(call.rawArguments) : {};
        } catch {
          parsedArguments = undefined;
        }
      }

      const tool = registry.get(call.name);

      // Check if this is a client-side tool
      if (tool && tool.runtime === "client") {
        if (parsedArguments === undefined) {
          const result = {
            ok: false,
            rejected: true,
            errorType: AGENT_ERROR_TYPES.AI_INVALID_RESPONSE,
            error: "Tool arguments were not valid JSON.",
          };
          steps.push({
            turn: iterations,
            id,
            name: call.name,
            rawArguments: typeof call.rawArguments === "string" ? call.rawArguments : "{}",
            parsedArguments,
            assistantContent: decision.content || "",
            result,
          });
          trace.push({
            name: String(call.name || "").slice(0, 60),
            arguments: parsedArguments ?? "{}",
            ok: false,
            rejected: true,
            errorType: result.errorType,
            error: result.error,
            provenance: "client_editor_bridge",
            durationMs: 0,
          });
        } else {
          const v = validateArgs(tool.parameters, parsedArguments);
          const syntaxCheck = v.ok && tool.name === "load_structure_into_editor" ? checkSmilesSyntax(v.value.smiles) : { plausible: true };
          if (!v.ok || !syntaxCheck.plausible) {
            const errDetail = !v.ok ? v.error : `Invalid SMILES syntax: ${syntaxCheck.issues.join(" ")}`;
            const errType = tool.name === "load_structure_into_editor" ? AGENT_ERROR_TYPES.INVALID_STRUCTURE : AGENT_ERROR_TYPES.AI_INVALID_RESPONSE;
            const result = {
              ok: false,
              rejected: true,
              errorType: errType,
              error: `Invalid arguments: ${errDetail}`,
            };
            steps.push({
              turn: iterations,
              id,
              name: call.name,
              rawArguments: typeof call.rawArguments === "string" ? call.rawArguments : JSON.stringify(parsedArguments),
              parsedArguments,
              assistantContent: decision.content || "",
              result,
            });
            trace.push({
              name: String(call.name || "").slice(0, 60),
              arguments: parsedArguments,
              ok: false,
              rejected: true,
              errorType: errType,
              error: result.error,
              provenance: "client_editor_bridge",
              durationMs: 0,
            });
          } else {
            const sig = `${tool.name}:${stableStringify(v.value)}`;
            if (failedSignatures.has(sig)) {
              const result = {
                ok: false,
                rejected: true,
                error: "This identical editor action already failed or was declined in this request. Do not repeat it; explain the outcome to the user.",
              };
              steps.push({
                turn: iterations,
                id,
                name: call.name,
                rawArguments: typeof call.rawArguments === "string" ? call.rawArguments : JSON.stringify(v.value),
                parsedArguments: v.value,
                assistantContent: decision.content || "",
                result,
              });
              trace.push({
                name: String(call.name || "").slice(0, 60),
                arguments: v.value,
                ok: false,
                rejected: true,
                error: result.error,
                provenance: "client_editor_bridge",
                durationMs: 0,
              });
            } else {
              // Client tool validated! Pause execution and request action from client
              return {
                status: "action_required",
                actionRequest: {
                  id,
                  tool: tool.name,
                  arguments: v.value,
                },
                continuationToken: createContinuationToken({
                  sessionId: activeSessionId,
                  message: userMessage,
                  compound: activeCompound,
                  history: convHistory,
                  steps,
                  trace,
                  pendingCall: {
                    id,
                    name: tool.name,
                    rawArguments: typeof call.rawArguments === "string" ? call.rawArguments : JSON.stringify(v.value),
                    parsedArguments: v.value,
                    assistantContent: decision.content || "",
                  },
                  iterations,
                  mode,
                  started,
                }),
              };
            }
          }
        }
      } else {
        let result;
        if (i >= limits.MAX_CALLS_PER_ITERATION) {
          result = { ok: false, rejected: true, error: `Too many tool calls in one turn (max ${limits.MAX_CALLS_PER_ITERATION}).` };
        } else {
          ({ parsedArguments, result } = await executeCall(call));
        }
        steps.push({
          turn: iterations,
          id,
          name: call.name,
          rawArguments: typeof call.rawArguments === "string" ? call.rawArguments : JSON.stringify(call.arguments ?? {}),
          parsedArguments,
          assistantContent: decision.content || "",
          result,
        });
      }
    }
  }

  if (!reply || !reply.trim()) {
    throw new AgentError(AGENT_ERROR_TYPES.AI_INVALID_RESPONSE, "The AI model returned an empty response.");
  }

  return {
    reply: truncate(reply.trim(), limits.MAX_REPLY_CHARS),
    provider: provider || "chemai-assistant",
    model: model || env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
    agent: {
      mode,
      iterations,
      maxIterations: limits.MAX_TOOL_ITERATIONS,
      stopReason,
      toolCalls: trace,
      elapsedMs: now() - started,
    },
  };
}
