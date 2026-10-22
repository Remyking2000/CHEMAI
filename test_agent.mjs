/**
 * ChemAI Agent Core tests (Phase 1).
 * All AI and external services are mocked — no network or paid API calls.
 * Run: node test_agent.mjs
 */
import {
  runAgent,
  createToolRegistry,
  validateArgs,
  checkSmilesSyntax,
  parseStructuredAction,
  buildAgentSystemPrompt,
  AGENT_LIMITS,
  _resetCapabilityCache,
} from "./functions/api/agent.js";
import { onRequest } from "./functions/api/[[route]].js";

console.info = () => {};
console.warn = () => {};

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`PASS: ${msg}`);
  } else {
    failed++;
    console.log(`FAIL: ${msg}`);
  }
}

/* ----------------------------- Mock helpers ------------------------------ */

function mockHandlers(overrides = {}) {
  const calls = [];
  const wrap = (name, impl) => async (body) => {
    calls.push({ name, body });
    return impl(body);
  };
  const handlers = {
    generateStructure: wrap("generateStructure", overrides.generateStructure || (async ({ query }) => ({
      ok: true,
      status: 200,
      data: {
        source: "ai-generated",
        candidate: {
          input: query,
          proposedName: "Aspirin",
          smiles: "CC(=O)OC1=CC=CC=C1C(=O)O",
          molecularFormula: "C9H8O4",
          reasoningSummary: "Acetylated salicylic acid.",
          uncertaintyNote: "AI hypothesis.",
        },
      },
    }))),
    identify: wrap("identify", overrides.identify || (async () => ({
      ok: true,
      status: 200,
      data: { cid: 2244, name: "Aspirin", molecularFormula: "C9H8O4", molecularWeight: 180.16, canonicalSmiles: "CC(=O)OC1=CC=CC=C1C(=O)O", source: "pubchem" },
    }))),
    lookupStructure: wrap("lookupStructure", overrides.lookupStructure || (async ({ query }) => ({
      ok: true,
      status: 200,
      data: { query, queryType: "name", candidates: [{ cid: 1, name: query, smiles: "C" }], source: "pubchem" },
    }))),
    analyze: wrap("analyze", overrides.analyze || (async ({ compound }) => ({
      ok: true,
      status: 200,
      data: { compound, molecularFormula: "C9H8O4", molecularWeight: "180.16", cid: 2244, source: "pubchem" },
    }))),
    explainStructure: wrap("explainStructure", overrides.explainStructure || (async () => ({
      ok: true,
      status: 200,
      data: { compound: { cid: 2244, name: "Aspirin" }, explanation: { whatItIs: "An NSAID." } },
    }))),
  };
  return { handlers, calls };
}

/** Mock OpenRouter: capability endpoint + scripted chat completions. */
function mockOpenRouter(script, { toolsSupported = true } = {}) {
  const requests = [];
  let i = 0;
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes("/endpoints")) {
      return new Response(JSON.stringify({ data: { endpoints: [{ supported_parameters: toolsSupported ? ["tools", "temperature"] : ["temperature"] }] } }), { status: 200 });
    }
    if (String(url).includes("/chat/completions")) {
      const body = JSON.parse(opts.body);
      requests.push(body);
      const step = typeof script === "function" ? script(body, i) : script[Math.min(i, script.length - 1)];
      i++;
      return new Response(JSON.stringify({ choices: [{ message: step }] }), { status: 200 });
    }
    return new Response("not mocked", { status: 500 });
  };
  return { fetchImpl, requests };
}

const toolCall = (id, name, args) => ({
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }],
});

const ENV = { OPENROUTER_API_KEY: "sk-test-not-real", OPENROUTER_MODEL: "test/model" };
const noCallAI = async () => {
  throw new Error("callAI should not be used in native mode");
};

console.log("--- Starting ChemAI Agent Core Tests ---");

/* 1. General question answered directly without tools */
{
  _resetCapabilityCache();
  const { handlers, calls } = mockHandlers();
  const { fetchImpl, requests } = mockOpenRouter([{ content: "Aromaticity arises from a cyclic, planar, conjugated system with 4n+2 π electrons." }]);
  const res = await runAgent({ message: "Explain aromaticity.", env: ENV, registry: createToolRegistry(handlers), callAI: noCallAI, fetchImpl });
  assert(res.reply.includes("4n+2"), "General question: direct answer returned");
  assert(calls.length === 0 && res.agent.toolCalls.length === 0, "General question: no external tool/lookup invoked");
  assert(res.agent.mode === "native" && res.agent.stopReason === "final_answer", "General question: native mode, final_answer stop reason");
  assert(Array.isArray(requests[0].tools) && requests[0].tools.length === 5 && requests[0].tool_choice === "auto", "Model is offered the 5 allowlisted tools with tool_choice=auto");
}

/* 2 + 3. Structure generation invokes tool; result is used in the final answer */
{
  _resetCapabilityCache();
  const { handlers, calls } = mockHandlers();
  const { fetchImpl, requests } = mockOpenRouter((body, i) => {
    if (i === 0) return toolCall("c1", "generate_structure", { query: "aspirin" });
    const toolMsg = body.messages.find((m) => m.role === "tool");
    const data = JSON.parse(toolMsg.content);
    return { content: `Proposed SMILES: ${data.data.smiles} (${data.data.verificationStatus}).` };
  });
  const res = await runAgent({ message: "Generate aspirin's structure.", env: ENV, registry: createToolRegistry(handlers), callAI: noCallAI, fetchImpl });
  assert(calls.length === 1 && calls[0].name === "generateStructure" && calls[0].body.query === "aspirin", "Structure request invokes generate_structure with validated args");
  assert(res.reply.includes("CC(=O)OC1=CC=CC=C1C(=O)O"), "Final answer uses the tool result (SMILES)");
  assert(res.reply.includes("unverified_ai_hypothesis"), "Generated structure is marked as an unverified AI hypothesis");
  const second = requests[1].messages;
  assert(second.some((m) => m.role === "assistant" && m.tool_calls?.[0]?.id === "c1") && second.some((m) => m.role === "tool" && m.tool_call_id === "c1"), "Tool result is passed back to the model with matching tool_call_id");
  assert(res.agent.iterations === 1 && res.agent.toolCalls[0].ok === true, "Agent trace records one successful tool iteration");
}

/* 4. Tool error handled without crashing; identical failed call not repeated */
{
  _resetCapabilityCache();
  const { handlers, calls } = mockHandlers({
    identify: async () => ({ ok: false, status: 404, data: { error: "No matching compound was found in PubChem for this structure." } }),
  });
  const { fetchImpl, requests } = mockOpenRouter((body, i) => {
    if (i < 2) return toolCall(`c${i}`, "identify_structure", { smiles: "CCCCCCCCCCO" });
    return { content: "PubChem had no match, so I can only describe the structure qualitatively." };
  });
  const res = await runAgent({ message: "Identify CCCCCCCCCCO", env: ENV, registry: createToolRegistry(handlers), callAI: noCallAI, fetchImpl });
  assert(res.reply.includes("no match"), "Tool error: request completes with a model-written explanation");
  assert(calls.length === 1, "Identical failed call is not executed a second time");
  assert(res.agent.toolCalls[0].ok === false && /PubChem/.test(res.agent.toolCalls[0].error), "Tool error message is surfaced in the trace");
  assert(res.agent.toolCalls[1].rejected === true, "Repeated failed call is rejected");
  const toolMsg = requests[1].messages.find((m) => m.role === "tool");
  assert(JSON.parse(toolMsg.content).ok === false, "Error result is returned to the model as ok:false");
}
{
  _resetCapabilityCache();
  const { handlers } = mockHandlers({ analyze: async () => { throw new Error("network down sk-or-v1-abcdefghijklmnopqrstuvwxyz123"); } });
  const { fetchImpl } = mockOpenRouter((b, i) => (i === 0 ? toolCall("x", "analyze_compound", { compound: "aspirin" }) : { content: "Reference lookup is unavailable right now." }));
  const res = await runAgent({ message: "MW of aspirin?", env: ENV, registry: createToolRegistry(handlers), callAI: noCallAI, fetchImpl });
  assert(res.agent.toolCalls[0].ok === false && !res.agent.toolCalls[0].error.includes("sk-or-v1-abc"), "Thrown tool exception is caught and secrets are redacted");
}
{
  _resetCapabilityCache();
  const { handlers } = mockHandlers({ lookupStructure: () => new Promise(() => {}) });
  const { fetchImpl } = mockOpenRouter((b, i) => (i === 0 ? toolCall("t", "lookup_structure", { query: "caffeine" }) : { content: "The lookup timed out." }));
  const res = await runAgent({ message: "Find caffeine", env: ENV, registry: createToolRegistry(handlers), callAI: noCallAI, fetchImpl, limits: { ...AGENT_LIMITS, TOOL_TIMEOUT_MS: 50 } });
  assert(res.agent.toolCalls[0].ok === false && /timed out/.test(res.agent.toolCalls[0].error), "Hung tool is cut off by the per-tool timeout");
}

/* 5. Invalid tool names and arguments rejected */
{
  _resetCapabilityCache();
  const { handlers, calls } = mockHandlers();
  const bad = {
    content: null,
    tool_calls: [
      { id: "a", type: "function", function: { name: "run_shell", arguments: "{\"cmd\":\"rm -rf /\"}" } },
      { id: "b", type: "function", function: { name: "generate_structure", arguments: "{}" } },
      { id: "c", type: "function", function: { name: "identify_structure", arguments: "{\"smiles\":\"C C; DROP TABLE\"}" } },
    ],
  };
  const { fetchImpl, requests } = mockOpenRouter([bad, { content: "Done." }]);
  const res = await runAgent({ message: "test", env: ENV, registry: createToolRegistry(handlers), callAI: noCallAI, fetchImpl });
  assert(calls.length === 0, "No handler executed for invalid tool name or arguments");
  assert(res.agent.toolCalls.every((t) => t.rejected), "All three invalid calls are rejected");
  assert(/Unknown tool/.test(res.agent.toolCalls[0].error), "Unknown tool name rejected against allowlist");
  assert(/Missing required argument "query"/.test(res.agent.toolCalls[1].error), "Missing required argument rejected");
  assert(/unsupported characters/.test(res.agent.toolCalls[2].error), "Malformed SMILES argument rejected by schema pattern");
  assert(requests[1].messages.filter((m) => m.role === "tool").length === 3, "Every tool_call id still receives a (rejection) tool message");
}
{
  const reg = createToolRegistry(mockHandlers().handlers);
  const schema = reg.get("lookup_structure").parameters;
  assert(validateArgs(schema, { query: "benzene", extra: 1 }).ok === false, "Unexpected extra argument rejected");
  assert(validateArgs(schema, { query: "benzene", type: "bogus" }).ok === false, "Enum violation rejected");
  assert(validateArgs(schema, { query: "x".repeat(151) }).ok === false, "Over-length argument rejected");
  assert(validateArgs(schema, "notanobject").ok === false, "Non-object arguments rejected");
  assert(validateArgs(schema, { query: "  benzene  " }).value.query === "benzene", "Valid arguments are trimmed and accepted");
}

/* 6. Iteration limit enforced */
{
  _resetCapabilityCache();
  const { handlers, calls } = mockHandlers();
  const { fetchImpl, requests } = mockOpenRouter((body, i) => toolCall(`loop${i}`, "lookup_structure", { query: `compound ${i}` }));
  const res = await runAgent({ message: "Keep looking things up forever", env: ENV, registry: createToolRegistry(handlers), callAI: noCallAI, fetchImpl });
  assert(res.agent.iterations === AGENT_LIMITS.MAX_TOOL_ITERATIONS && AGENT_LIMITS.MAX_TOOL_ITERATIONS === 4, "Agent stops after 4 tool iterations");
  assert(calls.length === 4, "Exactly 4 tool executions performed");
  assert(requests.length === 5 && requests[4].tool_choice === "none", "Final forced turn disables tools (tool_choice=none)");
  assert(res.agent.stopReason === "iteration_limit" && /tool-use limit/.test(res.reply) && /Unresolved/.test(res.reply), "Reply explains what was completed and what is unresolved");
}

/* 6b. Wall-clock budget enforced (fake clock: each model call costs 10 s) */
{
  _resetCapabilityCache();
  let clock = 0;
  const now = () => clock;
  const { handlers } = mockHandlers();
  const base = mockOpenRouter((body) => (body.tool_choice === "none" ? { content: "Partial answer within budget." } : toolCall(`t${clock}`, "lookup_structure", { query: `q${clock}` })));
  const fetchImpl = async (url, opts) => {
    if (String(url).includes("/chat/completions")) clock += 10000;
    return base.fetchImpl(url, opts);
  };
  const limits = { ...AGENT_LIMITS, TOTAL_BUDGET_MS: 30000, FINAL_ANSWER_RESERVE_MS: 15000 };
  const res = await runAgent({ message: "slow", env: ENV, registry: createToolRegistry(handlers), callAI: noCallAI, fetchImpl, now, limits });
  assert(res.agent.iterations === 2 && res.agent.stopReason === "time_budget", "Time budget stops new tool rounds and forces a final answer");
  assert(base.requests.at(-1).tool_choice === "none" && res.reply === "Partial answer within budget.", "Forced final turn still lets the model answer within the reserve");

  let threw = false;
  try {
    await runAgent({ message: "x", env: ENV, registry: createToolRegistry(handlers), callAI: noCallAI, fetchImpl: base.fetchImpl, now: () => 0, limits: { ...AGENT_LIMITS, TOTAL_BUDGET_MS: 1000 } });
  } catch (e) {
    threw = /time limit/.test(e.message);
  }
  assert(threw, "No model call is started without enough remaining budget; a clear error is raised");
}

/* 7. Compound context and conversation history preserved */
{
  _resetCapabilityCache();
  const { handlers } = mockHandlers();
  const { fetchImpl, requests } = mockOpenRouter([{ content: "It has an ester and a carboxylic acid." }]);
  const history = [
    { role: "user", content: "Hi, I attached aspirin." },
    { role: "assistant", content: "Great, aspirin is loaded." },
  ];
  const compound = { name: "Aspirin", formula: "C9H8O4", smiles: "CC(=O)OC1=CC=CC=C1C(=O)O", cid: 2244 };
  await runAgent({ message: "Which functional groups does it have?", history, compound, env: ENV, registry: createToolRegistry(handlers), callAI: noCallAI, fetchImpl });
  const msgs = requests[0].messages;
  assert(msgs[0].role === "system" && msgs[0].content.includes("ATTACHED VERIFIED COMPOUND CONTEXT") && msgs[0].content.includes("CC(=O)OC1=CC=CC=C1C(=O)O"), "Attached compound (with SMILES) is in the system prompt");
  assert(msgs[1].content === history[0].content && msgs[2].role === "assistant" && msgs[3].content === "Which functional groups does it have?", "Conversation history precedes the new user message in order");
}
{
  const longHistory = Array.from({ length: 30 }, (_, k) => ({ role: k % 2 ? "assistant" : "user", content: `m${k}` }));
  _resetCapabilityCache();
  const { fetchImpl, requests } = mockOpenRouter([{ content: "ok" }]);
  await runAgent({ message: "q", history: longHistory, env: ENV, registry: createToolRegistry(mockHandlers().handlers), callAI: noCallAI, fetchImpl });
  assert(requests[0].messages.length === 1 + AGENT_LIMITS.MAX_HISTORY_MESSAGES + 1 && requests[0].messages[1].content === "m18", "History is bounded to the most recent messages");
}

/* Structured-action fallback (model without native tool calling) */
{
  _resetCapabilityCache();
  const { handlers, calls } = mockHandlers();
  const aiCalls = [];
  const callAI = async (args) => {
    aiCalls.push(args);
    if (aiCalls.length === 1) return { text: '```json\n{"action":"call_tool","tool":"analyze_compound","arguments":{"compound":"aspirin"}}\n```', provider: "openrouter", model: "small/model" };
    return { text: "Aspirin is C9H8O4 with MW 180.16 g/mol (PubChem).", provider: "openrouter", model: "small/model" };
  };
  const compound = { name: "Aspirin", smiles: "CC(=O)OC1=CC=CC=C1C(=O)O" };
  const res = await runAgent({ message: "Formula and MW of aspirin?", compound, history: [{ role: "user", content: "earlier" }], env: {}, registry: createToolRegistry(handlers), callAI });
  assert(res.agent.mode === "structured" && calls.length === 1 && calls[0].name === "analyze", "Structured fallback: JSON action executes the validated tool");
  assert(res.reply.includes("180.16") && res.provider === "openrouter", "Structured fallback: final answer uses tool result");
  assert(aiCalls[0].systemPrompt.includes("RESPONSE PROTOCOL") && aiCalls[0].systemPrompt.includes("Canonical SMILES: CC(=O)OC1=CC=CC=C1C(=O)O"), "Structured fallback: protocol + compound context in system prompt");
  assert(aiCalls[1].history[0].content === "earlier" && aiCalls[1].prompt.startsWith("[TOOL RESULT]"), "Structured fallback: history preserved and tool result fed back");
}
{
  _resetCapabilityCache();
  const { fetchImpl } = mockOpenRouter([{ content: "unused" }], { toolsSupported: false });
  const callAI = async () => ({ text: "Direct answer from a model without tool support.", provider: "openrouter", model: "x" });
  const res = await runAgent({ message: "Explain SN2.", env: ENV, registry: createToolRegistry(mockHandlers().handlers), callAI, fetchImpl });
  assert(res.agent.mode === "structured" && res.reply.startsWith("Direct answer"), "Models advertising no tool support fall back to structured mode");
}
{
  assert(parseStructuredAction("Plain markdown answer {not json}").type === "final", "Plain text is treated as a final answer");
  assert(parseStructuredAction('{"action":"call_tool","tool":"identify_structure","arguments":{"smiles":"CCO"}}').calls[0].name === "identify_structure", "JSON action is parsed into a tool call");
  assert(checkSmilesSyntax("CC(=O)OC1=CC=CC=C1C(=O)O").plausible === true, "SMILES syntax check accepts aspirin");
  assert(checkSmilesSyntax("C1CC(C").plausible === false, "SMILES syntax check flags unbalanced/unpaired SMILES");
  assert(!buildAgentSystemPrompt(null, createToolRegistry(mockHandlers().handlers), "native").includes("ATTACHED VERIFIED"), "No compound block when no compound is attached");
}

/* 8. /api/chat end-to-end through the real router: response contract compatible with Chat.jsx */
{
  _resetCapabilityCache();
  const realFetch = globalThis.fetch;
  let chatTurn = 0;
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/endpoints")) {
      return new Response(JSON.stringify({ data: { endpoints: [{ supported_parameters: ["tools"] }] } }), { status: 200 });
    }
    if (u.includes("openrouter.ai/api/v1/chat/completions")) {
      const body = JSON.parse(opts.body);
      seen.push(body);
      if (!body.tools) {
        // Inner callAI used by the existing generate-structure handler
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ proposedName: "Ethanol", smiles: "CCO", molecularFormula: "C2H6O", reasoningSummary: "Two-carbon alcohol.", uncertaintyNote: "Hypothesis." }) } }] }), { status: 200 });
      }
      chatTurn++;
      const msg = chatTurn === 1 ? toolCall("e1", "generate_structure", { query: "ethanol" }) : { content: "Ethanol: CCO (AI-generated hypothesis, not verified)." };
      return new Response(JSON.stringify({ choices: [{ message: msg }] }), { status: 200 });
    }
    return new Response("blocked in tests", { status: 503 });
  };
  try {
    const req = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Generate ethanol's structure", history: [], compound: null }),
    });
    const res = await onRequest({ request: req, env: { ...ENV } });
    const data = await res.json();
    assert(res.status === 200, "/api/chat returns 200");
    assert(typeof data.reply === "string" && data.reply.includes("CCO"), "/api/chat returns `reply` string (Chat.jsx contract)");
    assert(data.provider === "openrouter" && data.model === "test/model", "/api/chat returns `provider` and `model` (Chat.jsx contract)");
    assert(data.agent && data.agent.toolCalls[0].name === "generate_structure" && data.agent.toolCalls[0].ok, "Real generate-structure handler reused in-process by the agent tool");
    assert(!JSON.stringify(data).includes("sk-test-not-real"), "API key never appears in the response");

    const empty = await onRequest({ request: new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ message: "  " }) }), env: ENV });
    assert(empty.status === 400 && (await empty.json()).error === "Message is required.", "Empty message still rejected with the existing 400 error");

    const tooLong = await onRequest({ request: new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ message: "x".repeat(AGENT_LIMITS.MAX_MESSAGE_CHARS + 1) }) }), env: ENV });
    assert(tooLong.status === 400, "Over-length message rejected");

    chatTurn = 99; // legacy path: plain completion
    const legacy = await onRequest({
      request: new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ message: "hello" }) }),
      env: { ...ENV, CHAT_AGENT_ENABLED: "false" },
    });
    const legacyData = await legacy.json();
    assert(legacy.status === 200 && typeof legacyData.reply === "string" && !legacyData.agent, "CHAT_AGENT_ENABLED=false keeps the legacy direct chat path");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`--- Agent tests: ${passed} passed, ${failed} failed ---`);
if (failed > 0) process.exit(1);
console.log("--- All ChemAI Agent Core Tests Passed! ---");
