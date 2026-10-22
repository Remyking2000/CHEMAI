/**
 * ==============================================================================
 * ChemAI — Central Chemistry Agent Core (Phase 1)
 * ------------------------------------------------------------------------------
 * A controlled, tool-using agent loop. The AI model decides whether it can answer
 * directly or whether it needs one of the registered chemistry tools. Tools are
 * thin adapters over the EXISTING API handlers (identify, lookup, analyze,
 * generate-structure, explain-structure) — no chemistry logic is duplicated here.
 *
 * Two execution modes:
 *   - "native":     OpenRouter OpenAI-compatible function calling (`tools` param),
 *                   used only when the model's endpoints advertise tool support.
 *   - "structured": validated JSON-action fallback over the existing `callAI`
 *                   gateway, for models/providers without function calling.
 *
 * Safety: allowlisted tool names, schema-validated arguments, bounded iterations,
 * per-call and total time budgets, truncated tool output, no arbitrary code
 * execution, and no logging of keys or headers.
 *
 * This module is dependency-injected (callAI, fetch, registry) so it can be unit
 * tested without network access or paid API calls.
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
  MODEL_TIMEOUT_MS: 25000,
  TOOL_TIMEOUT_MS: 20000,
  CAPABILITY_TIMEOUT_MS: 4000,
  TOTAL_BUDGET_MS: 60000, // hard wall-clock budget for the whole request
  FINAL_ANSWER_RESERVE_MS: 15000, // stop starting new tool rounds when less than this remains
  MIN_MODEL_CALL_MS: 3000, // do not start a model call with less time than this
});

const DEFAULT_OPENROUTER_MODEL = "liquid/lfm-2.5-2.6b:free";

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
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
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
 * Every tool declares `runtime`. Only `"server"` tools execute in this backend.
 * Phase 2 will add `"client"` tools (read/load editor structure, add atoms/bonds,
 * select regions, zoom/fit, confirm operations) that are executed by the browser
 * editor through a controlled frontend-to-agent interface — they are intentionally
 * NOT registered here, and the loop refuses to run any non-server tool.
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
  ];

  return new Map(tools.map((t) => [t.name, t]));
}

function toOpenAITools(registry) {
  return [...registry.values()]
    .filter((t) => t.runtime === "server")
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
- Call a tool only when it supplies evidence you actually need: a specific structure, a reference identity, candidate structures, exact reference properties, or a structured explanation of a specific molecule.
- Gather only what the user's goal requires. Inspect each tool result before deciding the next step. You may call several tools in sequence (at most ${AGENT_LIMITS.MAX_TOOL_ITERATIONS} tool rounds).
- Never describe an AI-generated structure as verified unless a reference tool (identify_structure, lookup_structure, analyze_compound) confirmed it.
- In the final answer, clearly separate reference data retrieved from external sources (e.g. PubChem) from your own interpretation, and state uncertainty where appropriate.
- If a tool fails, try one reasonable alternative or explain the limitation. Never repeat an identical failed call.
- You cannot control or modify the user's molecular editor; do not claim to have drawn or loaded anything into it.`;

  if (mode === "structured") {
    const toolLines = [...registry.values()]
      .filter((t) => t.runtime === "server")
      .map((t) => {
        const args = Object.entries(t.parameters.properties)
          .map(([k, v]) => `${k}${t.parameters.required?.includes(k) ? "" : "?"}: ${v.type}${v.enum ? ` (${v.enum.join("|")})` : ""}`)
          .join(", ");
        return `- ${t.name}(${args}) — ${t.description}`;
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
          (ep) => Array.isArray(ep.supported_parameters) && ep.supported_parameters.includes("tools")
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

async function nativeNext({ env, fetchImpl, registry, systemPrompt, history, message, steps, forceFinal, now, deadline, limits }) {
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
    try {
      const res = await fetchWithTimeout(
        fetchImpl,
        "https://openrouter.ai/api/v1/chat/completions",
        {
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
        },
        callTimeout
      );
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        if ((res.status === 400 || res.status === 404) && /tool/i.test(errText)) {
          capabilityCache.set(model, { supported: false, at: now() });
        }
        continue;
      }
      const data = await res.json();
      const msg = data?.choices?.[0]?.message;
      if (!msg) continue;
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
    } catch (err) {
      console.warn(`[ChemAI Agent] native call (${model}) failed:`, sanitizeText(err?.message));
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Structured fallback adapter (uses the existing callAI gateway)             */
/* -------------------------------------------------------------------------- */

async function structuredNext({ env, callAI, systemPrompt, history, message, steps, forceFinal, now, deadline, limits }) {
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

  const ai = await withTimeout(
    callAI({ prompt, history: convo, systemPrompt, env }),
    remaining,
    "AI provider"
  );
  // The deterministic last-resort responder cannot reason over tool results.
  if (ai?.provider === "chemai-assistant" && steps.length) {
    return { type: "final", text: summarizeSteps(steps, "ai_unavailable"), provider: ai.provider, model: ai.model };
  }
  const parsed = forceFinal ? { type: "final", text: (ai?.text || "").trim() } : parseStructuredAction(ai?.text || "");
  return { ...parsed, provider: ai?.provider, model: ai?.model };
}

/* -------------------------------------------------------------------------- */
/* Fallback summary when the loop cannot reach a model-written final answer   */
/* -------------------------------------------------------------------------- */

function summarizeSteps(steps, reason) {
  const header =
    reason === "ai_unavailable"
      ? "I gathered the following information, but the AI model became unavailable before I could write a full answer:"
      : reason === "time_budget"
      ? "I ran out of time for this request. Here is what I completed:"
      : "I reached the tool-use limit for this request before completing the analysis. Here is what I completed:";
  const lines = steps.map((s) => {
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
  env = {},
  registry,
  callAI,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  limits = AGENT_LIMITS,
}) {
  if (!registry || !callAI) throw new Error("Agent misconfigured: registry and callAI are required.");
  const started = now();
  const deadline = started + limits.TOTAL_BUDGET_MS;
  const convHistory = normalizeHistory(history);
  const userMessage = truncate(String(message || "").trim(), limits.MAX_MESSAGE_CHARS);

  let mode = openRouterKey(env) ? "native" : "structured";
  const ctx = { env, compound };
  const steps = [];
  const trace = [];
  const failedSignatures = new Set();
  const resultCache = new Map();
  let iterations = 0;
  let provider = null;
  let model = null;
  let reply = null;
  let stopReason = null;

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
    const shared = { env, fetchImpl, registry, history: convHistory, message: userMessage, steps, forceFinal, now, callAI, deadline, limits };

    let decision = null;
    if (mode === "native") {
      decision = await nativeNext({ ...shared, systemPrompt: buildAgentSystemPrompt(compound, registry, "native") });
      if (!decision) mode = "structured";
    }
    if (mode === "structured") {
      try {
        decision = await structuredNext({ ...shared, systemPrompt: buildAgentSystemPrompt(compound, registry, "structured") });
      } catch (err) {
        if (!steps.length) throw err;
        decision = { type: "final", text: summarizeSteps(steps, "ai_unavailable") };
      }
    }

    if (decision.type === "budget_exhausted") {
      if (!steps.length) throw new Error("The AI model did not respond within the time limit. Please try again.");
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
      let parsedArguments;
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

  if (!reply || !reply.trim()) {
    throw new Error("The AI model returned an empty response.");
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
