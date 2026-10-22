/**
 * ==============================================================================
 * ChemAI — Frontend-to-Agent Handshake & Client Tool Dispatcher (Phase 2B)
 * ------------------------------------------------------------------------------
 * Coordinates communication between the frontend React application and the central
 * ChemAI agent running on Cloudflare Workers.
 *
 * When the backend agent calls a `runtime: "client"` tool (e.g. read_editor_structure,
 * load_structure_into_editor, fit_canvas_view, get_editor_capabilities), this module:
 *   1. Intercepts the `action_required` suspension response.
 *   2. Validates the requested action against `ALLOWED_BRIDGE_ACTIONS`.
 *   3. Checks `getActiveEditorBridge()`. If unavailable (e.g. in standalone chat),
 *      returns a structured `{ ok: false, unavailable: true }` error back to the agent.
 *   4. Executes the action safely through the active editor bridge.
 *   5. Dispatches a continuation turn back to `/api/chat` with the actual result.
 *   6. Repeats until the agent completes reasoning and delivers its final answer.
 * ==============================================================================
 */

import { ALLOWED_BRIDGE_ACTIONS, getActiveEditorBridge } from "./editorBridge.js";
import { API_ROUTES } from "../config/api.js";

const MAX_HANDSHAKE_TURNS = 6;

/**
 * Executes an allowlisted client tool against the active editor bridge.
 *
 * @param {string} actionName - Name of the bridge action
 * @param {object} params - Action parameters
 * @returns {Promise<{ok: boolean, data?: object, error?: string, unavailable?: boolean, cancelled?: boolean, needsApproval?: boolean}>}
 */
export async function executeClientTool(actionName, params = {}) {
  // 1. Strict allowlist validation
  if (typeof actionName !== "string" || !ALLOWED_BRIDGE_ACTIONS.includes(actionName)) {
    return {
      ok: false,
      error: `Action "${String(actionName)}" is not an allowlisted client editor operation.`,
    };
  }

  // 2. Editor availability check
  const bridge = getActiveEditorBridge();
  if (!bridge) {
    return {
      ok: false,
      error: "The molecular editor is not currently active on this page. Please open the Molecular Editor at /editor to perform canvas operations.",
      unavailable: true,
    };
  }

  // 3. Execution through bridge
  try {
    const res = await bridge.executeAction(actionName, params);
    if (!res || typeof res !== "object") {
      return { ok: false, error: "Editor bridge returned an empty or invalid result." };
    }
    return {
      ok: Boolean(res.ok),
      data: res.data,
      error: res.error,
      needsApproval: Boolean(res.needsApproval),
      cancelled: Boolean(res.needsApproval && !res.ok),
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || "Unexpected exception during client editor tool execution.",
    };
  }
}

/**
 * Sends a message to the ChemAI agent and transparently manages the client-tool handshake loop.
 *
 * @param {object} options
 * @param {string} options.message - User prompt
 * @param {Array} [options.history=[]] - Conversation history
 * @param {object|null} [options.compound=null] - Optional compound context
 * @param {string|null} [options.sessionId=null] - Optional session ID
 * @param {function} [options.onStatusChange=null] - Status callback ({ status, action, result })
 * @param {function} [options.fetchImpl] - Fetch implementation (default window.fetch)
 * @param {string} [options.chatUrl] - Chat API endpoint (default API_ROUTES.chat)
 * @returns {Promise<{reply: string, provider: string, model: string, agent?: object}>}
 */
export async function sendAgentChat({
  message,
  history = [],
  compound = null,
  sessionId = null,
  onStatusChange = null,
  fetchImpl = typeof fetch !== "undefined" ? fetch : null,
  chatUrl = API_ROUTES?.chat || "/api/chat",
}) {
  if (!fetchImpl) {
    throw new Error("No fetch implementation available.");
  }

  let turnCount = 0;
  let payload = {
    message,
    history,
    compound,
    sessionId,
  };

  while (turnCount < MAX_HANDSHAKE_TURNS) {
    turnCount += 1;

    const res = await fetchImpl(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const detail = data?.details ? ` (${data.details})` : "";
      throw new Error(data?.error ? `${data.error}${detail}` : `Server returned HTTP ${res.status}`);
    }

    // Check if the agent requires a client editor tool to be executed
    if (data?.status === "action_required" && data?.actionRequest) {
      const { id, tool, arguments: actionArgs } = data.actionRequest;

      onStatusChange?.({
        status: "executing_action",
        action: { id, tool, arguments: actionArgs },
      });

      const clientResult = await executeClientTool(tool, actionArgs);

      onStatusChange?.({
        status: "action_completed",
        action: { id, tool, arguments: actionArgs },
        result: clientResult,
      });

      // Prepare continuation payload to resume the agent loop
      payload = {
        message,
        history,
        compound,
        sessionId,
        continuationToken: data.continuationToken,
        clientActionResult: {
          id,
          tool,
          result: clientResult,
        },
      };
      continue;
    }

    // Final answer received
    onStatusChange?.({ status: "completed" });
    return data;
  }

  throw new Error("Maximum client-agent handshake turns exceeded.");
}
