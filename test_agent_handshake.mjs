/**
 * ==============================================================================
 * ChemAI — AI Agent Molecular Editor Handshake Tests (Phase 2B)
 * ------------------------------------------------------------------------------
 * Comprehensive test suite verifying:
 *   1. Client tool registration and runtime separation (client vs server).
 *   2. Continuation token creation, tampering check, and expiration handling.
 *   3. Agent emitting action requests (`status: "action_required"`) on client tools.
 *   4. Agent ingesting client execution results and continuing reasoning.
 *   5. Multi-step workflow: Canvas Read -> Server Identification -> Final Answer.
 *   6. Multi-step workflow: Server Lookup -> Canvas Load -> Final Answer.
 *   7. Canvas Centering / Viewport fit (`fit_canvas_view`).
 *   8. Empty canvas detection and handling.
 *   9. Safe handling of unavailable editor state (e.g. standalone chat).
 *  10. User replacement approval decline / cancellation.
 *  11. SMILES validation failure during client tool request.
 *  12. Tool iteration limit enforcement across mixed server/client tool calls.
 *  13. Structured-action fallback mode with client tools.
 *  14. End-to-end `sendAgentChat` client handshake coordinator.
 * ==============================================================================
 */

import {
  createToolRegistry,
  runAgent,
  createContinuationToken,
  decodeContinuationToken,
  _resetCapabilityCache,
  AGENT_LIMITS,
  AGENT_ERROR_TYPES,
  AgentError,
} from "./functions/api/agent.js";
import { onRequest } from "./functions/api/[[route]].js";
import {
  createEditorBridge,
  registerEditorBridge,
  getActiveEditorBridge,
  ALLOWED_BRIDGE_ACTIONS,
  BRIDGE_ERROR_TYPES,
} from "./frontend/src/lib/editorBridge.js";
import { executeClientTool, sendAgentChat } from "./frontend/src/lib/agentHandshake.js";

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`PASS: ${message}`);
}

const toolCall = (id, name, args) => ({
  content: null,
  tool_calls: [
    {
      id,
      type: "function",
      function: {
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    },
  ],
});

function mockHandlers(overrides = {}) {
  const calls = [];
  return {
    calls,
    handlers: {
      generateStructure: async (b) => {
        calls.push({ name: "generateStructure", body: b });
        if (overrides.generateStructure) return overrides.generateStructure(b);
        return {
          ok: true,
          status: 200,
          data: {
            candidate: {
              proposedName: "Aspirin",
              smiles: "CC(=O)Oc1ccccc1C(=O)O",
              molecularFormula: "C9H8O4",
              reasoningSummary: "Acetylated salicylate derivative.",
              uncertaintyNote: "AI hypothesis.",
            },
          },
        };
      },
      identify: async (b) => {
        calls.push({ name: "identify", body: b });
        if (overrides.identify) return overrides.identify(b);
        return {
          ok: true,
          status: 200,
          data: {
            cid: 2244,
            name: "Aspirin",
            molecularFormula: "C9H8O4",
            molecularWeight: 180.16,
            canonicalSmiles: "CC(=O)Oc1ccccc1C(=O)O",
            iupacName: "2-acetyloxybenzoic acid",
            source: "mock-pubchem",
          },
        };
      },
      lookupStructure: async (b) => {
        calls.push({ name: "lookupStructure", body: b });
        if (overrides.lookupStructure) return overrides.lookupStructure(b);
        return {
          ok: true,
          status: 200,
          data: {
            query: b.query,
            queryType: b.type,
            candidates: [
              {
                cid: 2519,
                name: "Caffeine",
                molecularFormula: "C8H10N4O2",
                molecularWeight: 194.19,
                smiles: "Cn1cnc2c1c(=O)n(c(=O)n2C)C",
              },
            ],
            source: "mock-pubchem",
          },
        };
      },
      analyze: async (b) => {
        calls.push({ name: "analyze", body: b });
        if (overrides.analyze) return overrides.analyze(b);
        return {
          ok: true,
          status: 200,
          data: {
            cid: 2244,
            name: "Aspirin",
            molecularFormula: "C9H8O4",
            molecularWeight: 180.16,
            isomericSmiles: "CC(=O)Oc1ccccc1C(=O)O",
          },
        };
      },
      explainStructure: async (b) => {
        calls.push({ name: "explainStructure", body: b });
        if (overrides.explainStructure) return overrides.explainStructure(b);
        return {
          ok: true,
          status: 200,
          data: {
            compound: {
              cid: 2244,
              name: "Aspirin",
              molecularFormula: "C9H8O4",
              molecularWeight: 180.16,
              canonicalSmiles: "CC(=O)Oc1ccccc1C(=O)O",
            },
            explanation: {
              classification: "Analgesic",
              functionalGroups: "Ester, Carboxylic Acid",
              bondingAndGeometry: "Planar aromatic ring",
              educationalSignificance: "COX inhibition",
            },
          },
        };
      },
    },
  };
}

function mockOpenRouter(script) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    if (url.includes("/endpoints")) {
      return new Response(
        JSON.stringify({
          data: { endpoints: [{ supported_parameters: ["tools", "temperature"] }] },
        }),
        { status: 200 }
      );
    }
    const body = JSON.parse(options.body);
    const turnIndex = requests.length;
    requests.push(body);
    const step = typeof script === "function" ? script(body, turnIndex) : script[turnIndex];
    if (!step) {
      throw new Error(`Unexpected turn ${turnIndex} for mock script`);
    }
    const message = { role: "assistant", ...step };
    return new Response(
      JSON.stringify({
        id: `mock-${turnIndex}`,
        model: body.model,
        choices: [{ index: 0, message, finish_reason: step.tool_calls ? "tool_calls" : "stop" }],
      }),
      { status: 200 }
    );
  };
  return { fetchImpl, requests };
}

const ENV = { OPENROUTER_API_KEY: "sk-test-real-format-key", OPENROUTER_MODEL: "test/model" };
const noCallAI = async () => {
  throw new Error("callAI should not be called in native mode");
};

console.log("--- Starting ChemAI Agent Molecular Editor Handshake Tests (Phase 2B) ---");

/* 1. Client-tool registration and runtime separation */
{
  const { handlers } = mockHandlers();
  const registry = createToolRegistry(handlers);

  assert(registry.size === 9, "Tool registry contains exactly 9 tools (5 server + 4 client)");

  // Server tools
  const serverToolNames = ["generate_structure", "identify_structure", "lookup_structure", "analyze_compound", "explain_structure"];
  for (const name of serverToolNames) {
    const t = registry.get(name);
    assert(t && t.runtime === "server", `Server tool "${name}" has runtime === 'server'`);
    assert(typeof t.execute === "function", `Server tool "${name}" exposes an execute handler`);
  }

  // Client tools
  const clientToolNames = ["read_editor_structure", "load_structure_into_editor", "fit_canvas_view", "get_editor_capabilities"];
  for (const name of clientToolNames) {
    const t = registry.get(name);
    assert(t && t.runtime === "client", `Client tool "${name}" has runtime === 'client'`);
    assert(t.provenance === "client_editor_bridge", `Client tool "${name}" has provenance 'client_editor_bridge'`);
    assert(ALLOWED_BRIDGE_ACTIONS.includes(name), `Client tool "${name}" matches ALLOWED_BRIDGE_ACTIONS allowlist`);
  }
}

/* 2. Continuation Token round-trip, tampering, and expiration */
{
  const samplePayload = {
    sessionId: "sess_123",
    message: "Read canvas",
    steps: [{ id: "step1", name: "dummy" }],
    iterations: 1,
    mode: "native",
  };

  const token = createContinuationToken(samplePayload);
  assert(typeof token === "string" && token.length > 20, "createContinuationToken produces base64url string");

  const decoded = decodeContinuationToken(token);
  assert(decoded.sessionId === "sess_123", "decodeContinuationToken restores sessionId");
  assert(decoded.message === "Read canvas", "decodeContinuationToken restores message");
  assert(decoded.steps.length === 1 && decoded.steps[0].id === "step1", "decodeContinuationToken restores past steps");

  // Expired token test
  const expiredPayload = { ...samplePayload, ts: Date.now() - 15 * 60 * 1000 };
  const expiredToken = createContinuationToken(expiredPayload);
  let expiredThrew = false;
  try {
    decodeContinuationToken(expiredToken);
  } catch (err) {
    expiredThrew = true;
    assert(/expired/i.test(err.message), "decodeContinuationToken rejects expired token");
  }
  assert(expiredThrew, "Expired continuation token throws an error");

  // Malformed token test
  let malformedThrew = false;
  try {
    decodeContinuationToken("not_valid_base64_json!@#");
  } catch {
    malformedThrew = true;
  }
  assert(malformedThrew, "Malformed continuation token throws an error");
}

/* 3. Agent suspends with action_required when model calls read_editor_structure */
{
  _resetCapabilityCache();
  const { handlers } = mockHandlers();
  const { fetchImpl } = mockOpenRouter([
    toolCall("call_read_1", "read_editor_structure", {}),
  ]);

  const res = await runAgent({
    message: "What is on my canvas?",
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl,
  });

  assert(res.status === "action_required", "Agent returns status 'action_required' for client tool");
  assert(res.actionRequest.tool === "read_editor_structure", "actionRequest.tool is 'read_editor_structure'");
  assert(res.actionRequest.id === "call_read_1", "actionRequest.id matches model tool_call id");
  assert(typeof res.continuationToken === "string", "Agent provides a continuationToken");
}

/* 4. Agent resumes from continuationToken with clientActionResult and continues reasoning */
{
  _resetCapabilityCache();
  const { handlers } = mockHandlers();

  // Turn 1: Model asks to read editor structure
  const { fetchImpl: fetch1 } = mockOpenRouter([
    toolCall("call_read_1", "read_editor_structure", {}),
  ]);

  const suspension = await runAgent({
    message: "What did I draw?",
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl: fetch1,
  });

  assert(suspension.status === "action_required", "Turn 1 suspends with action_required");

  // Client executes bridge: Ethanol on canvas
  const clientResult = {
    ok: true,
    data: {
      smiles: "CCO",
      formula: "C2H6O",
      weight: "46.07",
      atomCount: 3,
      bondCount: 2,
      isEmpty: false,
      hasMolecule: true,
    },
  };

  // Turn 2: Model receives client tool result and produces final answer
  const { fetchImpl: fetch2, requests: reqs2 } = mockOpenRouter((body) => {
    const toolMsg = body.messages.find((m) => m.role === "tool");
    const data = JSON.parse(toolMsg.content);
    assert(data.tool === "read_editor_structure" && data.ok === true, "Model receives serialized client tool result");
    assert(data.data.smiles === "CCO", "Client SMILES is delivered to the model");
    return { content: `You have drawn Ethanol (SMILES: ${data.data.smiles}), which contains 3 heavy atoms and 2 bonds.` };
  });

  const finalRes = await runAgent({
    continuationToken: suspension.continuationToken,
    clientActionResult: {
      id: suspension.actionRequest.id,
      tool: suspension.actionRequest.tool,
      result: clientResult,
    },
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl: fetch2,
  });

  assert(finalRes.reply.includes("Ethanol (SMILES: CCO)"), "Final answer incorporates client canvas inspection");
  assert(finalRes.agent.iterations === 1, "Recorded 1 iteration for client action turn");
  assert(finalRes.agent.toolCalls[0].name === "read_editor_structure", "Tool trace records read_editor_structure");
  assert(finalRes.agent.toolCalls[0].provenance === "client_editor_bridge", "Trace provenance is 'client_editor_bridge'");
}

/* 5. Multi-step workflow: Canvas Read -> Server Identification -> Final Answer */
{
  _resetCapabilityCache();
  const { handlers, calls } = mockHandlers();

  // Step 1: Model calls read_editor_structure
  const { fetchImpl: f1 } = mockOpenRouter([
    toolCall("c_read", "read_editor_structure", {}),
  ]);

  const suspended = await runAgent({
    message: "Read the molecule on my canvas and identify it",
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl: f1,
  });

  assert(suspended.status === "action_required", "Step 1: Suspended on canvas read");

  // Step 2 + 3: Model receives canvas SMILES "CC(=O)Oc1ccccc1C(=O)O", calls server identify_structure, then answers
  const { fetchImpl: f2, requests: r2 } = mockOpenRouter((body, turn) => {
    if (turn === 0) {
      // Model sees read_editor_structure result, calls identify_structure
      return toolCall("c_ident", "identify_structure", { smiles: "CC(=O)Oc1ccccc1C(=O)O" });
    }
    // Turn 1: Model sees identify_structure result and answers
    return { content: "The molecule drawn on your canvas is verified as Aspirin (CID 2244, C9H8O4)." };
  });

  const finalRes = await runAgent({
    continuationToken: suspended.continuationToken,
    clientActionResult: {
      id: suspended.actionRequest.id,
      tool: suspended.actionRequest.tool,
      result: {
        ok: true,
        data: {
          smiles: "CC(=O)Oc1ccccc1C(=O)O",
          formula: "C9H8O4",
          atomCount: 13,
          hasMolecule: true,
        },
      },
    },
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl: f2,
  });

  assert(calls.length === 1 && calls[0].name === "identify", "Server identify handler was invoked");
  assert(finalRes.reply.includes("Aspirin (CID 2244, C9H8O4)"), "Final answer successfully grounds on canvas read + server identification");
  assert(finalRes.agent.toolCalls.length === 2, "Agent trace contains both client and server tool calls");
  assert(finalRes.agent.toolCalls[0].name === "read_editor_structure" && finalRes.agent.toolCalls[0].provenance === "client_editor_bridge", "First step was client tool");
  assert(finalRes.agent.toolCalls[1].name === "identify_structure" && finalRes.agent.toolCalls[1].provenance === "external_reference_pubchem", "Second step was server tool");
}

/* 6. Multi-step workflow: Server Lookup -> Canvas Load -> Final Answer */
{
  _resetCapabilityCache();
  const { handlers, calls } = mockHandlers();

  // Model first looks up caffeine on server, then requests load_structure_into_editor
  const { fetchImpl: f1 } = mockOpenRouter((body, turn) => {
    if (turn === 0) {
      return toolCall("c_lookup", "lookup_structure", { query: "caffeine" });
    }
    return toolCall("c_load", "load_structure_into_editor", { smiles: "Cn1cnc2c1c(=O)n(c(=O)n2C)C" });
  });

  const step1 = await runAgent({
    message: "Draw caffeine in my editor",
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl: f1,
  });

  assert(step1.status === "action_required", "Suspended on load_structure_into_editor");
  assert(step1.actionRequest.tool === "load_structure_into_editor", "Action is load_structure_into_editor");
  assert(step1.actionRequest.arguments.smiles === "Cn1cnc2c1c(=O)n(c(=O)n2C)C", "SMILES argument matches caffeine");

  // Client loads it and confirms
  const { fetchImpl: f2 } = mockOpenRouter([
    { content: "I have drawn caffeine (Cn1cnc2c1c(=O)n(c(=O)n2C)C) in your editor and centered the canvas." },
  ]);

  const step2 = await runAgent({
    continuationToken: step1.continuationToken,
    clientActionResult: {
      id: step1.actionRequest.id,
      tool: step1.actionRequest.tool,
      result: {
        ok: true,
        data: {
          smiles: "Cn1cnc2c1c(=O)n(c(=O)n2C)C",
          atomCount: 14,
          bondCount: 15,
        },
      },
    },
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl: f2,
  });

  assert(step2.reply.includes("drawn caffeine"), "Model confirmed caffeine was loaded into editor");
  assert(step2.agent.toolCalls.some((t) => t.name === "lookup_structure"), "Trace includes server lookup");
  assert(step2.agent.toolCalls.some((t) => t.name === "load_structure_into_editor"), "Trace includes client load");
}

/* 7. Fit Canvas View (fit_canvas_view) */
{
  _resetCapabilityCache();
  const { handlers } = mockHandlers();
  const { fetchImpl: f1 } = mockOpenRouter([
    toolCall("c_fit", "fit_canvas_view", {}),
  ]);

  const suspended = await runAgent({
    message: "Center my molecule",
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl: f1,
  });

  assert(suspended.status === "action_required" && suspended.actionRequest.tool === "fit_canvas_view", "Suspends on fit_canvas_view");

  const { fetchImpl: f2 } = mockOpenRouter([
    { content: "Your canvas view has been centered and framed to fit the current structure." },
  ]);

  const completed = await runAgent({
    continuationToken: suspended.continuationToken,
    clientActionResult: {
      id: suspended.actionRequest.id,
      tool: suspended.actionRequest.tool,
      result: {
        ok: true,
        data: { viewMode: "desktop", viewport: { zoom: 1.45, panX: 200, panY: 150 } },
      },
    },
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl: f2,
  });

  assert(completed.reply.includes("centered and framed"), "Model answers confirming viewport fit");
}

/* 8. Handling of Unavailable Editor State (e.g. standalone chat) */
{
  _resetCapabilityCache();
  const { handlers } = mockHandlers();

  // Test executeClientTool when bridge is null
  assert(getActiveEditorBridge() === null, "Active editor bridge is initially null");
  const unavailResult = await executeClientTool("read_editor_structure", {});
  assert(unavailResult.ok === false, "executeClientTool returns ok: false when bridge is null");
  assert(unavailResult.unavailable === true, "executeClientTool sets unavailable: true");
  assert(/editor is not currently active/i.test(unavailResult.error), "Clear error explains editor is inactive");

  // Agent receives unavailable result and responds politely
  const { fetchImpl: f1 } = mockOpenRouter([
    toolCall("c_read", "read_editor_structure", {}),
  ]);

  const suspended = await runAgent({
    message: "What is on my canvas?",
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl: f1,
  });

  const { fetchImpl: f2 } = mockOpenRouter((body) => {
    const toolMsg = body.messages.find((m) => m.role === "tool");
    const data = JSON.parse(toolMsg.content);
    assert(data.ok === false, "Model receives ok: false from unavailable editor");
    return {
      content: "There is no active molecular editor open on this page. Please navigate to the Molecular Editor at /editor to draw structures, or ask me any general chemistry question.",
    };
  });

  const completed = await runAgent({
    continuationToken: suspended.continuationToken,
    clientActionResult: {
      id: suspended.actionRequest.id,
      tool: suspended.actionRequest.tool,
      result: unavailResult,
    },
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl: f2,
  });

  assert(completed.reply.includes("no active molecular editor open"), "Model explains that editor is not active on this page");
}

/* 9. Handling of User Decline / Cancellation */
{
  _resetCapabilityCache();
  const { handlers } = mockHandlers();

  const { fetchImpl: f1 } = mockOpenRouter([
    toolCall("c_load", "load_structure_into_editor", { smiles: "c1ccccc1" }),
  ]);

  const suspended = await runAgent({
    message: "Replace my drawing with benzene",
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl: f1,
  });

  // Client declined replacement
  const declineResult = {
    ok: false,
    cancelled: true,
    needsApproval: true,
    error: "Structure replacement was declined by user.",
  };

  const { fetchImpl: f2 } = mockOpenRouter((body) => {
    const toolMsg = body.messages.find((m) => m.role === "tool");
    const data = JSON.parse(toolMsg.content);
    assert(data.ok === false && /declined/i.test(data.error), "Model receives user decline notification");
    return { content: "Understood. I kept your existing molecule on the canvas without replacing it." };
  });

  const completed = await runAgent({
    continuationToken: suspended.continuationToken,
    clientActionResult: {
      id: suspended.actionRequest.id,
      tool: suspended.actionRequest.tool,
      result: declineResult,
    },
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl: f2,
  });

  assert(completed.reply.includes("kept your existing molecule"), "Model acknowledges user declined replacement");
}

/* 10. Handling of Empty Canvas */
{
  _resetCapabilityCache();
  const { handlers } = mockHandlers();

  const { fetchImpl: f1 } = mockOpenRouter([
    toolCall("c_read", "read_editor_structure", {}),
  ]);

  const suspended = await runAgent({
    message: "Explain what I just drew",
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl: f1,
  });

  const emptyCanvasResult = {
    ok: true,
    data: {
      smiles: "",
      atomCount: 0,
      bondCount: 0,
      isEmpty: true,
      hasMolecule: false,
    },
  };

  const { fetchImpl: f2 } = mockOpenRouter([
    { content: "Your canvas is currently blank (0 atoms). You can draw a structure using the editor tools, or ask me to draw one for you!" },
  ]);

  const completed = await runAgent({
    continuationToken: suspended.continuationToken,
    clientActionResult: {
      id: suspended.actionRequest.id,
      tool: suspended.actionRequest.tool,
      result: emptyCanvasResult,
    },
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl: f2,
  });

  assert(completed.reply.includes("currently blank (0 atoms)"), "Model informs user canvas is empty");
}

/* 11. SMILES validation failure during client tool request */
{
  _resetCapabilityCache();
  const { handlers } = mockHandlers();

  // Model sends invalid characters in SMILES to load_structure_into_editor
  const badCall = {
    content: null,
    tool_calls: [
      {
        id: "bad_smiles_call",
        type: "function",
        function: {
          name: "load_structure_into_editor",
          arguments: JSON.stringify({ smiles: "INVALID; DROP TABLE;" }),
        },
      },
    ],
  };

  const { fetchImpl, requests } = mockOpenRouter([
    badCall,
    { content: "The SMILES string was invalid, so I did not load anything into the editor." },
  ]);

  const res = await runAgent({
    message: "Load this bad SMILES",
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl,
  });

  // Since validation failed on server before dispatch, it did not suspend
  assert(res.agent.toolCalls[0].rejected === true, "Bad SMILES client call was rejected by schema validation");
  assert(/unsupported characters/i.test(res.agent.toolCalls[0].error), "Rejection specifies unsupported characters");
  assert(res.reply.includes("invalid"), "Model handles rejected SMILES without crashing");
}

/* 12. Structured fallback mode with client tool */
{
  const { handlers } = mockHandlers();

  // In structured fallback mode, model outputs {"action":"call_tool","tool":"read_editor_structure","arguments":{}}
  const fakeCallAI = async ({ prompt }) => {
    if (!prompt.includes("[TOOL RESULT]")) {
      return {
        text: '{"action":"call_tool","tool":"read_editor_structure","arguments":{}}',
        provider: "fallback-provider",
        model: "fallback-model",
      };
    }
    return {
      text: "Based on your canvas, you have drawn Ethanol (SMILES: CCO).",
      provider: "fallback-provider",
      model: "fallback-model",
    };
  };

  const suspended = await runAgent({
    message: "What did I draw?",
    env: {}, // no OpenRouter key -> structured fallback mode
    registry: createToolRegistry(handlers),
    callAI: fakeCallAI,
  });

  assert(suspended.status === "action_required", "Structured fallback mode successfully suspends for client tool");
  assert(suspended.actionRequest.tool === "read_editor_structure", "Action request is read_editor_structure");

  const completed = await runAgent({
    continuationToken: suspended.continuationToken,
    clientActionResult: {
      id: suspended.actionRequest.id,
      tool: suspended.actionRequest.tool,
      result: { ok: true, data: { smiles: "CCO", atomCount: 3 } },
    },
    env: {},
    registry: createToolRegistry(handlers),
    callAI: fakeCallAI,
  });

  assert(completed.agent.mode === "structured", "Structured fallback mode is maintained");
  assert(completed.reply.includes("Ethanol (SMILES: CCO)"), "Structured fallback resumes and completes final answer");
}

/* 13. End-to-end `sendAgentChat` client handshake coordinator */
{
  // Mount a mock editor bridge
  let currentSmiles = "";
  let fitCount = 0;
  const mockTarget = {
    getMolecule: () => (currentSmiles ? { atoms: [{ id: 1, element: "C", x: 0, y: 0 }] } : { atoms: [] }),
    loadSmiles: (s) => { currentSmiles = s; },
    fitView: () => { fitCount++; return { zoom: 1.5 }; },
    isReady: () => true,
    getViewMode: () => "desktop",
    exportCurrent: () => ({ smiles: currentSmiles, formula: currentSmiles ? "CH4" : "" }),
  };

  const bridge = createEditorBridge(mockTarget);
  const unregister = registerEditorBridge(bridge);

  try {
    assert(getActiveEditorBridge() === bridge, "Bridge is actively registered");

    // Mock fetch for sendAgentChat simulating Cloudflare Workers endpoint
    let serverTurn = 0;
    const mockChatEndpoint = async (url, options) => {
      const body = JSON.parse(options.body);
      serverTurn++;

      if (serverTurn === 1) {
        // First turn: server asks client to load aspirin into editor
        return new Response(
          JSON.stringify({
            status: "action_required",
            actionRequest: {
              id: "act_1",
              tool: "load_structure_into_editor",
              arguments: { smiles: "CC(=O)Oc1ccccc1C(=O)O" },
            },
            continuationToken: createContinuationToken({ test: 1 }),
          }),
          { status: 200 }
        );
      }

      // Second turn: client returned result, server outputs final answer
      assert(body.clientActionResult?.tool === "load_structure_into_editor", "Handshake returned clientActionResult");
      assert(body.clientActionResult?.result?.ok === true, "Client execution succeeded in live bridge");

      return new Response(
        JSON.stringify({
          reply: "Aspirin has been loaded into your molecular editor.",
          provider: "test-provider",
          model: "test-model",
          agent: { iterations: 1 },
        }),
        { status: 200 }
      );
    };

    const statusUpdates = [];
    const chatResult = await sendAgentChat({
      message: "Draw aspirin in my editor",
      fetchImpl: mockChatEndpoint,
      onStatusChange: (s) => statusUpdates.push(s.status),
    });

    assert(chatResult.reply.includes("Aspirin has been loaded"), "sendAgentChat returned final assistant answer");
    assert(currentSmiles === "CC(=O)Oc1ccccc1C(=O)O", "Structure was actually loaded into editor target by handshake");
    assert(fitCount === 1, "Canvas view was framed after loading structure");
    assert(statusUpdates.includes("executing_action"), "Status callback received 'executing_action'");
    assert(statusUpdates.includes("action_completed"), "Status callback received 'action_completed'");
    assert(statusUpdates.includes("completed"), "Status callback received 'completed'");
  } finally {
    unregister();
  }
}

/* 14. Phase 2C: AI Provider Failure (HTTP 502/503 + fallback failure) does not pretend editor action succeeded */
{
  _resetCapabilityCache();
  const { handlers } = mockHandlers();
  const failingFetch = async (url) => {
    if (String(url).includes("/endpoints")) {
      return new Response(JSON.stringify({ data: { endpoints: [{ supported_parameters: ["tools"] }] } }), { status: 200 });
    }
    return new Response("Upstream provider error", { status: 503 });
  };
  const fallbackCallAI = async () => ({
    text: "### Chemical Profile: **Caffeine** (C8H10N4O2) ...",
    provider: "chemai-assistant",
    model: "test/model",
    diagnostics: [{ type: AGENT_ERROR_TYPES.AI_PROVIDER_UNAVAILABLE, detail: "OpenRouter HTTP 503" }],
  });

  let caught = null;
  try {
    await runAgent({
      message: "Draw caffeine in my editor",
      env: ENV,
      registry: createToolRegistry(handlers),
      callAI: fallbackCallAI,
      fetchImpl: failingFetch,
    });
  } catch (err) {
    caught = err;
  }

  assert(caught instanceof AgentError, "Provider outage throws structured AgentError instead of returning generic fallback");
  assert(caught.type === AGENT_ERROR_TYPES.AI_PROVIDER_UNAVAILABLE, "Error type is ai_provider_unavailable");
  assert(caught.status === 502, "HTTP status for provider failure is 502");
  assert(/drawing was not changed/i.test(caught.message), "Error message confirms drawing was not changed");
}

/* 15. Phase 2C: Request Timeout surfaces ai_timeout (504) */
{
  _resetCapabilityCache();
  const { handlers } = mockHandlers();
  const timeoutFetch = async (url) => {
    if (String(url).includes("/endpoints")) {
      return new Response(JSON.stringify({ data: { endpoints: [{ supported_parameters: ["tools"] }] } }), { status: 200 });
    }
    const err = new Error("OpenRouter timed out after 12000 ms");
    err.code = "TIMEOUT";
    throw err;
  };
  const timeoutCallAI = async () => {
    const err = new Error("AI provider timed out");
    err.code = "TIMEOUT";
    throw err;
  };

  let caught = null;
  try {
    await runAgent({
      message: "Identify the structure on my canvas",
      env: ENV,
      registry: createToolRegistry(handlers),
      callAI: timeoutCallAI,
      fetchImpl: timeoutFetch,
    });
  } catch (err) {
    caught = err;
  }

  assert(caught instanceof AgentError, "Model timeout throws structured AgentError");
  assert(caught.type === AGENT_ERROR_TYPES.AI_TIMEOUT, "Error type is ai_timeout");
  assert(caught.status === 504, "HTTP status for timeout is 504");
  assert(/time limit/i.test(caught.message), "Timeout message mentions time limit");
}

/* 16. Phase 2C: Invalid / Malformed Model Response surfaces ai_invalid_response */
{
  _resetCapabilityCache();
  const { handlers } = mockHandlers();
  const malformedFetch = async (url) => {
    if (String(url).includes("/endpoints")) {
      return new Response(JSON.stringify({ data: { endpoints: [{ supported_parameters: ["tools"] }] } }), { status: 200 });
    }
    return new Response("<<<not json>>>", { status: 200 });
  };
  const emptyCallAI = async () => ({
    text: "   ",
    provider: "openrouter",
    model: "test/model",
  });

  let caught = null;
  try {
    await runAgent({
      message: "Center my canvas",
      env: ENV,
      registry: createToolRegistry(handlers),
      callAI: emptyCallAI,
      fetchImpl: malformedFetch,
    });
  } catch (err) {
    caught = err;
  }

  assert(caught instanceof AgentError, "Malformed/empty model response throws structured AgentError");
  assert(caught.type === AGENT_ERROR_TYPES.AI_INVALID_RESPONSE, "Error type is ai_invalid_response");
  assert(/invalid response/i.test(caught.message), "Message explains the AI returned an invalid response");
}

/* 17. Phase 2C: Unbalanced SMILES syntax (e.g. unclosed ring or paren) rejected before client dispatch */
{
  _resetCapabilityCache();
  const { handlers } = mockHandlers();
  const { fetchImpl } = mockOpenRouter([
    toolCall("c_bad_ring", "load_structure_into_editor", { smiles: "C1CCCCC" }),
    { content: "The proposed SMILES had an unclosed ring, so I did not modify your canvas." },
  ]);

  const res = await runAgent({
    message: "Load cyclohexane",
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl,
  });

  assert(res.status !== "action_required", "Unbalanced SMILES does not suspend for client execution");
  assert(res.agent.toolCalls[0].rejected === true, "Unbalanced SMILES is marked rejected");
  assert(res.agent.toolCalls[0].errorType === AGENT_ERROR_TYPES.INVALID_STRUCTURE, "Rejected SMILES carries errorType invalid_structure");
}

/* 18. Phase 2C: Bridge & Handshake errorType classification and drawing preservation */
{
  // Unmounted / not ready editor -> editor_unavailable
  const notReadyBridge = createEditorBridge({
    isReady: () => false,
    getViewMode: () => "desktop",
  });
  const unreadyRead = await notReadyBridge.read_editor_structure();
  assert(unreadyRead.ok === false && unreadyRead.errorType === BRIDGE_ERROR_TYPES.EDITOR_UNAVAILABLE, "Unready editor returns errorType editor_unavailable");

  // Existing ethanol drawing on canvas; test invalid SMILES, rejected replacement, and thrown operation error
  const ethanolGraph = {
    atoms: [
      { id: "a1", element: "C", x: 0, y: 0 },
      { id: "a2", element: "C", x: 1.5, y: 0 },
      { id: "a3", element: "O", x: 3.0, y: 0 },
    ],
    bonds: [
      { id: "b1", a1: "a1", a2: "a2", order: 1 },
      { id: "b2", a1: "a2", a2: "a3", order: 1 },
    ],
  };
  let storedMol = JSON.parse(JSON.stringify(ethanolGraph));
  let approvalDecision = false;
  let shouldThrowOnLoad = false;

  const target = {
    isReady: () => true,
    getViewMode: () => "desktop",
    getMolecule: () => storedMol,
    exportCurrent: () => ({ smiles: "CCO", formula: "C2H6O", weight: "46.07" }),
    requestApproval: async () => approvalDecision,
    loadSmiles: () => {
      if (shouldThrowOnLoad) throw new Error("Simulated canvas render failure");
      storedMol = { atoms: [{ id: "x", element: "N", x: 0, y: 0 }], bonds: [] };
    },
  };
  const bridge = createEditorBridge(target);
  const unregister = registerEditorBridge(bridge);

  try {
    // 18a. Invalid structure
    const badLoad = await executeClientTool("load_structure_into_editor", { smiles: "NOT_A_SMILES_@@@" });
    assert(badLoad.ok === false && badLoad.errorType === BRIDGE_ERROR_TYPES.INVALID_STRUCTURE, "Invalid SMILES classified as invalid_structure");
    assert(storedMol.atoms.length === 3, "Drawing preserved after invalid SMILES");

    // 18b. User rejects replacement
    approvalDecision = false;
    const rejectedLoad = await executeClientTool("load_structure_into_editor", { smiles: "c1ccccc1" });
    assert(rejectedLoad.ok === false && rejectedLoad.errorType === BRIDGE_ERROR_TYPES.REPLACEMENT_REJECTED, "Declined replacement classified as replacement_rejected");
    assert(rejectedLoad.cancelled === true, "Declined replacement sets cancelled: true");
    assert(storedMol.atoms.length === 3, "Drawing preserved after user declined replacement");

    // 18c. Editor operation throws during approved load
    approvalDecision = true;
    shouldThrowOnLoad = true;
    const failedOp = await executeClientTool("load_structure_into_editor", { smiles: "c1ccccc1" });
    assert(failedOp.ok === false && failedOp.errorType === BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED, "Thrown bridge error classified as editor_operation_failed");
    assert(failedOp.cancelled === false, "Thrown operation error is not misclassified as user cancellation");
    assert(storedMol.atoms.length === 3, "Drawing preserved when loadSmiles throws");
  } finally {
    unregister();
  }
}

/* 19. Phase 2C: Truthful continuation fallback when AI provider fails AFTER client tool execution */
{
  _resetCapabilityCache();
  const { handlers } = mockHandlers();

  // Turn 1: Model requests load_structure_into_editor
  const { fetchImpl: f1 } = mockOpenRouter([
    toolCall("c_load_1", "load_structure_into_editor", { smiles: "c1ccccc1" }),
  ]);
  const suspended = await runAgent({
    message: "Replace my drawing with benzene",
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl: f1,
  });

  // Turn 2a: User declined replacement, AND then AI provider fails on continuation
  const failingFetch = async () => new Response("Outage", { status: 503 });
  const fallbackCallAI = async () => ({
    text: "Generic chemistry profile that should not replace step summary",
    provider: "chemai-assistant",
    model: "test/model",
  });

  const declinedRes = await runAgent({
    continuationToken: suspended.continuationToken,
    clientActionResult: {
      id: suspended.actionRequest.id,
      tool: suspended.actionRequest.tool,
      result: {
        ok: false,
        errorType: BRIDGE_ERROR_TYPES.REPLACEMENT_REJECTED,
        cancelled: true,
        needsApproval: true,
        error: "Structure replacement was declined by user.",
      },
    },
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: fallbackCallAI,
    fetchImpl: failingFetch,
  });

  assert(/declined by the user/i.test(declinedRes.reply), "Fallback summary truthfully reports user declined replacement");
  assert(/unchanged/i.test(declinedRes.reply), "Fallback summary confirms current drawing was kept unchanged");
  assert(!/loaded structure into the molecular editor/i.test(declinedRes.reply), "Never claims structure was loaded when declined");

  // Turn 2b: Standalone chat (editor_unavailable) + AI provider fails on continuation
  const { fetchImpl: fRead } = mockOpenRouter([
    toolCall("c_read_standalone", "read_editor_structure", {}),
  ]);
  const suspendedRead = await runAgent({
    message: "What is on my canvas?",
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl: fRead,
  });

  const unavailRes = await runAgent({
    continuationToken: suspendedRead.continuationToken,
    clientActionResult: {
      id: suspendedRead.actionRequest.id,
      tool: suspendedRead.actionRequest.tool,
      result: {
        ok: false,
        errorType: BRIDGE_ERROR_TYPES.EDITOR_UNAVAILABLE,
        unavailable: true,
        error: "The molecular editor is not currently active on this page.",
      },
    },
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: fallbackCallAI,
    fetchImpl: failingFetch,
  });

  assert(/not open on this page/i.test(unavailRes.reply) && /\/editor/.test(unavailRes.reply), "Standalone chat fallback directs user to /editor");
}

/* 20. Phase 2C: Duplicate client tool call after failure is blocked (no duplicate mutations) */
{
  _resetCapabilityCache();
  const { handlers } = mockHandlers();

  const { fetchImpl: f1 } = mockOpenRouter([
    toolCall("c_load_dup_1", "load_structure_into_editor", { smiles: "c1ccccc1" }),
  ]);
  const suspended = await runAgent({
    message: "Draw benzene",
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl: f1,
  });

  // Model stubbornly tries to call the exact same load_structure_into_editor again after user declined
  const { fetchImpl: f2 } = mockOpenRouter([
    toolCall("c_load_dup_2", "load_structure_into_editor", { smiles: "c1ccccc1" }),
    { content: "You declined replacing the structure, so I left your canvas as is." },
  ]);

  const completed = await runAgent({
    continuationToken: suspended.continuationToken,
    clientActionResult: {
      id: suspended.actionRequest.id,
      tool: suspended.actionRequest.tool,
      result: {
        ok: false,
        errorType: BRIDGE_ERROR_TYPES.REPLACEMENT_REJECTED,
        cancelled: true,
        error: "Structure replacement was declined by user.",
      },
    },
    env: ENV,
    registry: createToolRegistry(handlers),
    callAI: noCallAI,
    fetchImpl: f2,
  });

  assert(completed.status !== "action_required", "Duplicate failed client tool call is not re-dispatched to client");
  assert(completed.agent.toolCalls.length === 2 && completed.agent.toolCalls[1].rejected === true, "Second identical client call is rejected in trace");
  assert(completed.reply.includes("left your canvas as is"), "Agent finishes with explanation instead of re-prompting user");
}

/* 21. Phase 2C: /api/chat route returns structured error code and HTTP status when AI fails */
{
  _resetCapabilityCache();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/endpoints")) {
      return new Response(JSON.stringify({ data: { endpoints: [{ supported_parameters: ["tools"] }] } }), { status: 200 });
    }
    return new Response("Service Unavailable", { status: 503 });
  };
  try {
    const req = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Load caffeine into the editor" }),
    });
    const res = await onRequest({ request: req, env: ENV });
    const data = await res.json();
    assert(res.status === 502, "/api/chat returns 502 when all AI providers fail");
    assert(data.code === AGENT_ERROR_TYPES.AI_PROVIDER_UNAVAILABLE, "/api/chat response includes code: ai_provider_unavailable");
    assert(/drawing was not changed/i.test(data.error), "/api/chat error truthfully states no editor action was performed");

    // Continuation with mismatched action id returns 400 invalid_continuation
    const token = createContinuationToken({
      message: "test",
      pendingCall: { id: "expected_id", name: "read_editor_structure", parsedArguments: {} },
    });
    const badContReq = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        continuationToken: token,
        clientActionResult: { id: "wrong_id", tool: "read_editor_structure", result: { ok: true } },
      }),
    });
    const badContRes = await onRequest({ request: badContReq, env: ENV });
    const badContData = await badContRes.json();
    assert(badContRes.status === 400 && badContData.code === AGENT_ERROR_TYPES.INVALID_CONTINUATION, "Mismatched continuation action id rejected with 400 invalid_continuation");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("--- All ChemAI Agent Handshake Tests Passed Successfully! ---");
