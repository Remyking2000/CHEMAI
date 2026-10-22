import React, { useState, useEffect, useRef } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import OCL from "openchemlib";
import { ChemAINeuralHexIcon } from "../components/ChemAIIcons";
import DesktopMolecularEditor from "../components/DesktopMolecularEditor";
import MobileMolecularEditor from "../components/MobileMolecularEditor";
import { useMoleculeManager } from "../lib/useMoleculeManager";
import { createEditorBridge, registerEditorBridge } from "../lib/editorBridge";
import { sendAgentChat } from "../lib/agentHandshake";
import { API_ROUTES } from "../config/api";

// Quick example templates to test and draw
const SAMPLE_STRUCTURES = [
  { name: "Benzene", smiles: "c1ccccc1" },
  { name: "Aspirin", smiles: "CC(=O)Oc1ccccc1C(=O)O" },
  { name: "Ethanol", smiles: "CCO" },
  { name: "Caffeine", smiles: "Cn1cnc2c1c(=O)n(c(=O)n2C)C" },
];

export default function MolecularEditor() {
  const navigate = useNavigate();
  const location = useLocation();

  // Authoritative shared molecule manager across Desktop and Mobile
  const moleculeManager = useMoleculeManager(null, location.state?.loadSmiles);
  const isEditorReady = true;

  const [copiedField, setCopiedField] = useState(null);

  // Phase 1B: Chemical Identification state
  const [identifyResult, setIdentifyResult] = useState(null);
  const [identifyLoading, setIdentifyLoading] = useState(false);
  const [identifyError, setIdentifyError] = useState(null);

  // Phase 2 Explanation state setters (preserved for reset cascades)
  const [, setExplainResult] = useState(null);
  const [, setExplainError] = useState(null);

  // Phase 3A: Reverse Structure Lookup (Build Structure) state
  const [showBuildStructure, setShowBuildStructure] = useState(false);
  const [buildQuery, setBuildQuery] = useState("");
  const [buildType, setBuildType] = useState("auto"); // "auto" | "name" | "formula"
  const [buildLoading, setBuildLoading] = useState(false);
  const [buildResult, setBuildResult] = useState(null);
  const [buildError, setBuildError] = useState(null);
  const [selectedCandidateCid, setSelectedCandidateCid] = useState(null);

  // Phase 3B: AI-Assisted Structure Generation state
  const [aiLoading, setAiLoading] = useState(false);
  const [aiCandidate, setAiCandidate] = useState(null);
  const [aiError, setAiError] = useState(null);
  const [aiApproved, setAiApproved] = useState(false);

  // Preserved Compound Analyzer state
  const [showAnalyzer, setShowAnalyzer] = useState(false);
  const [analyzerQuery, setAnalyzerQuery] = useState("");
  const [analyzerResult, setAnalyzerResult] = useState(null);
  const [analyzerLoading, setAnalyzerLoading] = useState(false);

  // Phase 4A: Mobile-first responsive view detection and manual override
  const [isMobileViewport, setIsMobileViewport] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 768
  );
  const [viewModeOverride, setViewModeOverride] = useState(null); // 'mobile' | 'desktop' | null (auto)
  const activeView = viewModeOverride || (isMobileViewport ? "mobile" : "desktop");

  // Responsive listener for viewport width changes and orientation changes
  useEffect(() => {
    const handleResize = () => {
      setIsMobileViewport(window.innerWidth < 768);
    };
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
    };
  }, []);

  // Status notification
  const [statusMessage, setStatusMessage] = useState("");
  const statusTimerRef = useRef(null);

  const showStatus = (msg) => {
    setStatusMessage(msg);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatusMessage(""), 4000);
  };

  useEffect(() => {
    return () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    };
  }, []);

  // Shared view switchers preserving molecular state with zero loss
  const handleSwitchToMobile = () => {
    setViewModeOverride("mobile");
    showStatus("Switched to Mobile Molecular Editor view.");
  };

  const handleSwitchToDesktop = () => {
    setViewModeOverride("desktop");
    showStatus("Switched to Desktop Molecular Editor view.");
  };

  // ---------------------------------------------------------------------------
  // Phase 2A: Controlled Molecular Editor Bridge & Safe Replacement Approval
  // ---------------------------------------------------------------------------
  const desktopEditorRef = useRef(null);
  const mobileEditorRef = useRef(null);
  const bridgeRef = useRef(null);
  const [pendingBridgeReplacement, setPendingBridgeReplacement] = useState(null);

  // Phase 2B: Interactive ChemAI Assistant Drawer (Live Editor Handshake)
  const [isChatDrawerOpen, setIsChatDrawerOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatAgentStatus, setChatAgentStatus] = useState("");
  const chatDrawerEndRef = useRef(null);

  useEffect(() => {
    if (isChatDrawerOpen) {
      chatDrawerEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages, chatLoading, isChatDrawerOpen]);

  const handleNavigateToFullChat = () => {
    let compound = identifyResult ? buildCompoundContext(identifyResult) : null;
    if (!compound && identifyError?.fallbackCompound) {
      compound = buildCompoundContext(identifyError.fallbackCompound);
    }
    navigate("/chat", {
      state: {
        compound,
        loadSmiles: moleculeManager.exportCurrent()?.smiles || undefined,
      },
    });
  };

  const handleSendChatMessage = async (textToSend = chatInput) => {
    if (chatLoading) return;
    const trimmed = (textToSend || "").trim();
    if (!trimmed) return;

    const activeCompound = identifyResult ? buildCompoundContext(identifyResult) : null;
    const userMessage = {
      id: `user-${Date.now()}`,
      sender: "user",
      text: trimmed,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    const currentHistory = chatMessages
      .filter((m) => !m.isError)
      .map((m) => ({
        role: m.sender === "user" ? "user" : "assistant",
        content: m.text,
      }));

    setChatMessages((prev) => [...prev, userMessage]);
    setChatInput("");
    setChatLoading(true);
    setChatAgentStatus("");

    try {
      const data = await sendAgentChat({
        message: trimmed,
        history: currentHistory,
        compound: activeCompound,
        onStatusChange: (s) => {
          if (s.status === "executing_action") {
            const toolLabels = {
              read_editor_structure: "Inspecting canvas molecule...",
              load_structure_into_editor: "Loading structure onto canvas...",
              fit_canvas_view: "Centering canvas view...",
              get_editor_capabilities: "Checking editor capabilities...",
            };
            setChatAgentStatus(toolLabels[s.action?.tool] || `Executing: ${s.action?.tool}...`);
          } else {
            setChatAgentStatus("");
          }
        },
      });

      const assistantMessage = {
        id: `assistant-${Date.now()}`,
        sender: "assistant",
        text: data.reply,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        provider: data.provider,
        model: data.model,
      };

      setChatMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      console.error("[Editor AI Chat] Error:", err);
      const errMsg = err?.message || "Failed to communicate with ChemAI service.";
      setChatMessages((prev) => [
        ...prev,
        {
          id: `assistant-err-${Date.now()}`,
          sender: "assistant",
          text: `⚠️ **Unable to complete request**\n\n${errMsg}`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          isError: true,
        },
      ]);
    } finally {
      setChatLoading(false);
      setChatAgentStatus("");
    }
  };

  const renderBridgeApprovalModal = () => {
    if (!pendingBridgeReplacement) return null;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150">
        <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl border border-slate-200 overflow-hidden text-slate-800">
          <div className="p-5 border-b border-slate-100 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center font-bold text-lg shrink-0">
              ⚠️
            </div>
            <div>
              <h3 className="font-bold text-base text-slate-900">Replace Current Drawing?</h3>
              <p className="text-xs text-slate-500">
                Action request from {pendingBridgeReplacement.source || "external agent"}
              </p>
            </div>
          </div>
          <div className="p-5 space-y-3 text-sm">
            <p className="text-slate-600 leading-relaxed">
              An action requested loading a new structure onto the canvas. Your current canvas already contains{" "}
              <strong className="text-slate-900">{pendingBridgeReplacement.currentAtomCount} atom(s)</strong>.
            </p>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-mono break-all text-indigo-700">
              <span className="text-slate-400 block font-sans text-3xs font-semibold uppercase tracking-wider mb-1">
                Candidate SMILES
              </span>
              {pendingBridgeReplacement.candidateSmiles}
            </div>
            <p className="text-xs text-amber-800 bg-amber-50 p-2.5 rounded-lg border border-amber-200/60">
              Approving will overwrite your currently drawn canvas.
            </p>
          </div>
          <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={() => pendingBridgeReplacement.resolve(false)}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 transition-colors cursor-pointer"
            >
              Keep Current Molecule
            </button>
            <button
              type="button"
              onClick={() => pendingBridgeReplacement.resolve(true)}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-sm cursor-pointer"
            >
              Approve & Replace
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderChatDrawer = () => {
    if (!isChatDrawerOpen) return null;
    return (
      <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-96 lg:w-[440px] bg-slate-900/98 backdrop-blur-md border-l border-slate-700/80 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200 text-slate-100">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/70">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white shadow-sm">
              <ChemAINeuralHexIcon className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h3 className="font-bold text-sm text-white">ChemAI Assistant</h3>
                <span className="text-[10px] bg-cyan-900/60 text-cyan-300 px-1.5 py-0.5 rounded border border-cyan-700/50 font-mono">
                  Editor Connected
                </span>
              </div>
              <p className="text-[11px] text-slate-400">Can inspect, draw & center your canvas</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleNavigateToFullChat}
              className="p-1.5 text-xs text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
              title="Open in full-page chat"
            >
              ↗ Full Page
            </button>
            <button
              type="button"
              onClick={() => setIsChatDrawerOpen(false)}
              className="p-1.5 text-xs text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
              title="Close Assistant"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Quick Prompts */}
        <div className="p-2.5 bg-slate-950/40 border-b border-slate-800/80 flex items-center gap-1.5 overflow-x-auto text-[11px] no-scrollbar">
          <button
            type="button"
            onClick={() => handleSendChatMessage("What molecule is currently on my canvas? Identify and explain it.")}
            disabled={chatLoading}
            className="px-2 py-1 bg-slate-800/90 hover:bg-slate-700 text-cyan-300 rounded-md border border-cyan-800/40 whitespace-nowrap cursor-pointer transition-colors"
          >
            🔬 Identify canvas
          </button>
          <button
            type="button"
            onClick={() => handleSendChatMessage("Draw caffeine in my editor.")}
            disabled={chatLoading}
            className="px-2 py-1 bg-slate-800/90 hover:bg-slate-700 text-slate-300 rounded-md border border-slate-700/50 whitespace-nowrap cursor-pointer transition-colors"
          >
            ☕ Draw caffeine
          </button>
          <button
            type="button"
            onClick={() => handleSendChatMessage("Center and frame my canvas view.")}
            disabled={chatLoading}
            className="px-2 py-1 bg-slate-800/90 hover:bg-slate-700 text-slate-300 rounded-md border border-slate-700/50 whitespace-nowrap cursor-pointer transition-colors"
          >
            🎯 Center view
          </button>
          <button
            type="button"
            onClick={() => handleSendChatMessage("What capabilities does my molecular editor have?")}
            disabled={chatLoading}
            className="px-2 py-1 bg-slate-800/90 hover:bg-slate-700 text-slate-300 rounded-md border border-slate-700/50 whitespace-nowrap cursor-pointer transition-colors"
          >
            ⚙️ Capabilities
          </button>
        </div>

        {/* Message Feed */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3 text-xs">
          {chatMessages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400 space-y-2">
              <div className="w-12 h-12 rounded-2xl bg-cyan-950/40 border border-cyan-800/30 flex items-center justify-center text-cyan-400 mb-1">
                <ChemAINeuralHexIcon className="w-6 h-6" />
              </div>
              <p className="font-semibold text-slate-200">How can ChemAI help your drawing?</p>
              <p className="text-[11px] text-slate-400 max-w-xs">
                Ask me to read the molecule on your canvas, draw any compound, center your view, or explain chemical concepts.
              </p>
            </div>
          ) : (
            chatMessages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col ${msg.sender === "user" ? "items-end" : "items-start"}`}
              >
                <div
                  className={`max-w-[88%] rounded-2xl p-3 leading-relaxed ${
                    msg.sender === "user"
                      ? "bg-cyan-600 text-white rounded-tr-xs"
                      : msg.isError
                      ? "bg-red-950/80 border border-red-800/60 text-red-200 rounded-tl-xs"
                      : "bg-slate-800/90 border border-slate-700/60 text-slate-200 rounded-tl-xs"
                  }`}
                >
                  <p className="whitespace-pre-wrap">{msg.text}</p>
                </div>
                <span className="text-[10px] text-slate-500 mt-1 px-1">{msg.timestamp}</span>
              </div>
            ))
          )}

          {chatLoading && (
            <div className="flex items-start gap-2 text-slate-300 p-3 bg-slate-800/60 rounded-xl border border-slate-700/50">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping mt-1" />
              <div className="space-y-0.5">
                <p className="text-[11px] font-semibold text-cyan-300">ChemAI is working...</p>
                <p className="text-[10px] text-slate-400 animate-pulse">{chatAgentStatus || "Reasoning..."}</p>
              </div>
            </div>
          )}
          <div ref={chatDrawerEndRef} />
        </div>

        {/* Input */}
        <div className="p-3 bg-slate-950 border-t border-slate-800">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendChatMessage();
            }}
            className="flex items-center gap-2"
          >
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Ask ChemAI about your canvas..."
              disabled={chatLoading}
              className="flex-1 bg-slate-900 border border-slate-700 text-slate-200 placeholder-slate-500 text-xs px-3 py-2 rounded-xl focus:outline-none focus:border-cyan-500"
            />
            <button
              type="submit"
              disabled={chatLoading || !chatInput.trim()}
              className="px-3.5 py-2 rounded-xl text-xs font-semibold text-white bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:opacity-50 transition-all cursor-pointer"
            >
              Send
            </button>
          </form>
        </div>
      </div>
    );
  };

  useEffect(() => {
    const target = {
      getMolecule: () => moleculeManager.molRef.current,
      exportCurrent: () => moleculeManager.exportCurrent(),
      loadSmiles: (smiles) => {
        moleculeManager.loadSmiles(smiles);
        setIdentifyResult(null);
        setIdentifyError(null);
        setExplainResult(null);
        setExplainError(null);
      },
      fitView: () => {
        if (activeView === "mobile" && mobileEditorRef.current?.fitToScreen) {
          return mobileEditorRef.current.fitToScreen();
        }
        if (desktopEditorRef.current?.fitToScreen) {
          return desktopEditorRef.current.fitToScreen();
        }
        return null;
      },
      getViewport: () => {
        if (activeView === "mobile" && mobileEditorRef.current?.getViewport) {
          return mobileEditorRef.current.getViewport();
        }
        if (desktopEditorRef.current?.getViewport) {
          return desktopEditorRef.current.getViewport();
        }
        return null;
      },
      getViewMode: () => activeView,
      isReady: () => isEditorReady,
      requestApproval: ({ candidateSmiles, currentAtomCount, source, parsedAtomCount }) => {
        return new Promise((resolve) => {
          setPendingBridgeReplacement({
            candidateSmiles,
            currentAtomCount,
            source,
            parsedAtomCount,
            resolve: (val) => {
              setPendingBridgeReplacement(null);
              resolve(val);
            },
          });
        });
      },
    };

    const bridge = createEditorBridge(target);
    bridgeRef.current = bridge;
    const unregister = registerEditorBridge(bridge);

    if (typeof window !== "undefined") {
      window.__CHEMAI_EDITOR_BRIDGE__ = {
        read_editor_structure: bridge.read_editor_structure,
        load_structure_into_editor: bridge.load_structure_into_editor,
        fit_canvas_view: bridge.fit_canvas_view,
        get_editor_capabilities: bridge.get_editor_capabilities,
        executeAction: bridge.executeAction,
      };
    }

    return () => {
      unregister();
      bridgeRef.current = null;
      if (typeof window !== "undefined" && window.__CHEMAI_EDITOR_BRIDGE__) {
        delete window.__CHEMAI_EDITOR_BRIDGE__;
      }
    };
  }, [moleculeManager, activeView, isEditorReady]);

  const { loadSmiles: loadSmilesToManager } = moleculeManager;

  // Restore structure from navigation state (e.g. returning from Chat)
  useEffect(() => {
    if (location.state?.loadSmiles) {
      loadSmilesToManager(location.state.loadSmiles);
      if (location.state?.compound) {
        const c = location.state.compound;
        setIdentifyResult({
          name: c.name,
          molecularFormula: c.formula,
          molecularWeight: c.weight ? parseFloat(c.weight) : null,
          cid: c.cid,
          canonicalSmiles: c.smiles,
          iupacName: c.iupac,
          category: c.category,
          wikipedia: c.description ? { extract: c.description } : null,
          casNumber: c.casNumber,
          synonyms: c.synonyms,
        });
      }
    }
  }, [location.state, loadSmilesToManager]);

  // Helper to extract current structure from shared engine
  const getCurrentStructure = async () => {
    const exp = moleculeManager.exportCurrent();
    return {
      smiles: exp.smiles || "",
      molfile: exp.molfile || "",
      atomCount: exp.atomCount || 0,
      bondCount: exp.bondCount || 0,
      formula: exp.formula || "",
      weight: exp.weight || "",
    };
  };

  // Identify drawn molecule via backend POST /api/identify
  const handleIdentifyMolecule = async (structureOverride = null) => {
    // Guard against React SyntheticEvent objects when passed as onClick={handleIdentifyMolecule}
    const isOverrideValid =
      structureOverride &&
      typeof structureOverride === "object" &&
      !("nativeEvent" in structureOverride) &&
      !("_reactName" in structureOverride) &&
      Boolean(structureOverride.smiles || structureOverride.molfile);

    const actualOverride = isOverrideValid ? structureOverride : null;

    if (identifyLoading) return; // Prevent duplicate submissions

    setIdentifyLoading(true);
    setIdentifyError(null);
    setIdentifyResult(null);
    setExplainResult(null);
    setExplainError(null);

    try {
      const { smiles, molfile, atomCount } = actualOverride
        ? {
            smiles: (actualOverride.smiles || "").trim(),
            molfile: actualOverride.molfile || "",
            atomCount: actualOverride.atomCount ?? (actualOverride.smiles ? 1 : 0),
          }
        : await getCurrentStructure();

      const hasStructure = Boolean(
        (smiles && smiles.trim().length > 0) ||
        (molfile && molfile.trim().length > 0 && atomCount > 0)
      );

      // Check for empty canvas
      if (!hasStructure) {
        setIdentifyError({
          type: "empty",
          title: "Canvas is Empty",
          message: "Please draw a chemical structure before clicking Identify Molecule.",
        });
        setIdentifyLoading(false);
        return;
      }

      const res = await fetch(API_ROUTES.identify, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ smiles, molfile }),
      });

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: "Invalid JSON received from server", raw: text };
      }

      if (!res.ok) {
        if (res.status === 404) {
          setIdentifyError({
            type: "not_found",
            title: "No Matching Compound Found",
            message: data.error || "No matching compound was found in PubChem for this structure.",
            details: "The drawn structure might be a novel molecule, an unsupported tautomer, or not currently indexed in PubChem.",
            smiles: data.smiles || smiles,
          });
        } else if (res.status === 400) {
          setIdentifyError({
            type: "invalid",
            title: "Structure Standardization Error",
            message: data.error || "PubChem could not standardize the drawn structure.",
            details: data.details,
          });
        } else if (res.status === 503 || res.status === 504) {
          setIdentifyError({
            type: "unavailable",
            title: "PubChem Service Busy or Timed Out",
            message: data.error || "The upstream PubChem service is temporarily busy (rate limited). Please wait a moment and try again.",
            fallbackCompound: data.fallbackCompound || null,
            smiles: data.smiles || smiles,
          });
        } else {
          setIdentifyError({
            type: "server_error",
            title: "Identification Error",
            message: data.error || "An error occurred while contacting the identification service.",
            details: data.details,
          });
        }
      } else {
        setIdentifyResult(data);
        showStatus(`Identified as ${data.name || "Compound"}!`);
      }
    } catch (err) {
      console.error("Identify fetch error:", err);
      setIdentifyError({
        type: "network_error",
        title: "Connection Failed",
        message: "Could not connect to the CHEMAI backend server. Please ensure the backend service is running.",
      });
    } finally {
      setIdentifyLoading(false);
    }
  };

  // Construct structured verified compound context for Chat navigation
  const buildCompoundContext = (res = identifyResult) => {
    if (!res) return null;
    return {
      name: res.name || "Identified Molecule",
      formula: res.molecularFormula || res.formula || "",
      weight: res.molecularWeight
        ? typeof res.molecularWeight === "number"
          ? `${res.molecularWeight} g/mol`
          : String(res.molecularWeight)
        : res.weight || "",
      cid: res.cid || null,
      smiles: res.canonicalSmiles || res.inputSmiles || res.smiles || "",
      iupac: res.iupacName || res.iupac || "",
      category: res.category || "PubChem Identified",
      description: res.wikipedia?.extract || res.description || "",
      casNumber: res.casNumber || "",
      synonyms: Array.isArray(res.synonyms) ? res.synonyms : [],
      wikipediaUrl: res.wikipedia?.url || null,
    };
  };

  // Open ChemAI Assistant Drawer (with live editor bridge)
  const handleOpenChat = (promptOverride = null) => {
    setIsChatDrawerOpen(true);
    if (promptOverride && typeof promptOverride === "string") {
      handleSendChatMessage(promptOverride);
    }
  };

  // Phase 2 Unified: Open Assistant and immediately generate explanation for identified molecule
  const handleExplainStructure = () => {
    if (!identifyResult) {
      showStatus("Identify a molecule first to generate a chemistry explanation.");
      return;
    }
    handleOpenChat(
      `Explain the molecular structure, functional groups, and chemical properties of ${identifyResult.name}${identifyResult.molecularFormula ? ` (${identifyResult.molecularFormula})` : ""}.`
    );
  };

  // Clear current molecular structure
  const handleClearStructure = async () => {
    moleculeManager.clear();
    setIdentifyResult(null);
    setIdentifyError(null);
    setExplainResult(null);
    setExplainError(null);
    showStatus("Structure canvas cleared.");
  };

  // Load a sample structure into editor
  const handleLoadSample = async (smiles, name) => {
    setIdentifyResult(null);
    setIdentifyError(null);
    setExplainResult(null);
    setExplainError(null);

    moleculeManager.loadSmiles(smiles);
    showStatus(`Loaded ${name} onto canvas.`);
  };

  // Copy text to clipboard helper
  const handleCopy = (text, field) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  // Preserved Compound Analyzer function (calls backend /api/analyze)
  const analyzeCompound = async () => {
    if (!analyzerQuery.trim()) {
      showStatus("Enter a compound name first!");
      return;
    }
    setAnalyzerLoading(true);
    setAnalyzerResult(null);

    try {
      const res = await fetch(API_ROUTES.analyze, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ compound: analyzerQuery.trim() }),
      });

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: "Invalid JSON from server", raw: text };
      }

      if (!res.ok) {
        setAnalyzerResult({ error: data?.error || data?.details || "Server returned an error" });
      } else {
        setAnalyzerResult(data);
      }
    } catch (err) {
      console.error("Analyzer fetch error:", err);
      setAnalyzerResult({ error: err?.message || "Network error connecting to backend" });
    } finally {
      setAnalyzerLoading(false);
    }
  };

  // Load analyzed compound into the editor canvas
  const handleLoadAnalyzedToEditor = async (smiles) => {
    if (!smiles) return;
    try {
      setIdentifyResult(null);
      setIdentifyError(null);
      setExplainResult(null);
      setExplainError(null);
      moleculeManager.loadSmiles(smiles);
      showStatus(`Imported ${analyzerResult?.compound || "compound"} into Editor!`);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      console.error("Failed to import compound:", err);
      showStatus(`Could not load structure into editor: ${err?.message || err}`);
    }
  };

  // Phase 3A: Validate SMILES syntax using OpenChemLib
  const validateSmiles = (smiles) => {
    if (!smiles || typeof smiles !== "string" || !smiles.trim()) {
      return { valid: false, error: "Empty or missing SMILES string." };
    }
    try {
      const mol = OCL.Molecule.fromSmiles(smiles.trim());
      if (!mol || mol.getAllAtoms() === 0) {
        return { valid: false, error: "Parsed structure contains 0 atoms." };
      }
      return { valid: true, atomCount: mol.getAllAtoms() };
    } catch (err) {
      return {
        valid: false,
        error: err?.message || "Invalid SMILES syntax according to OpenChemLib parser.",
      };
    }
  };

  // Phase 3A: Reverse Structure Lookup (search PubChem by compound name or molecular formula)
  const handleLookupStructure = async (queryOverride, typeOverride) => {
    const q = (queryOverride !== undefined ? queryOverride : buildQuery).trim();
    const t = typeOverride !== undefined ? typeOverride : buildType;

    if (!q) {
      setBuildError({
        type: "empty",
        title: "Input Required",
        message:
          "Please enter a chemical compound name (e.g. ethanol, aspirin) or molecular formula (e.g. C2H6O, C6H6).",
      });
      return;
    }

    if (queryOverride !== undefined) {
      setBuildQuery(queryOverride);
    }
    if (typeOverride !== undefined) {
      setBuildType(typeOverride);
    }

    setBuildLoading(true);
    setBuildError(null);
    setBuildResult(null);
    setSelectedCandidateCid(null);

    try {
      const res = await fetch(API_ROUTES.lookupStructure, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, type: t }),
      });

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: "Invalid JSON received from server", raw: text };
      }

      if (!res.ok) {
        if (res.status === 400) {
          setBuildError({
            type: "invalid",
            title:
              data.code === "INVALID_FORMULA"
                ? "Invalid Molecular Formula"
                : "Invalid Input",
            message:
              data.error ||
              "The query could not be processed as a valid formula or name.",
            details: data.details,
            code: data.code,
          });
        } else if (res.status === 404) {
          setBuildError({
            type: "not_found",
            title: "No Matching Compounds Found",
            message:
              data.error || `No compounds found in PubChem matching "${q}".`,
            details:
              data.details ||
              "Check the spelling or try searching by an alternative common or IUPAC name, or standard Hill molecular formula.",
            code: data.code,
          });
        } else if (res.status === 503 || res.status === 504) {
          setBuildError({
            type: "unavailable",
            title: "PubChem Service Busy or Timed Out",
            message:
              data.error ||
              "PubChem lookup is temporarily unavailable. Please try again shortly.",
            details: data.details,
            code: data.code,
          });
        } else {
          setBuildError({
            type: "server_error",
            title: "Structure Lookup Error",
            message: data.error || "An error occurred during structure lookup.",
            details: data.details,
            code: data.code,
          });
        }
      } else {
        setBuildResult(data);
        if (data.candidates && data.candidates.length > 0) {
          setSelectedCandidateCid(data.candidates[0].cid);
          showStatus(
            `Found ${data.count || data.candidates.length} candidate${
              (data.count || data.candidates.length) > 1 ? "s" : ""
            } for "${data.query}"`
          );
        } else {
          setBuildError({
            type: "not_found",
            title: "No Usable Structures Found",
            message:
              "The search succeeded but returned no candidate structures with valid SMILES.",
          });
        }
      }
    } catch (err) {
      console.error("Lookup structure error:", err);
      setBuildError({
        type: "network_error",
        title: "Connection Failed",
        message:
          "Could not connect to the CHEMAI backend server. Please ensure the backend is reachable.",
      });
    } finally {
      setBuildLoading(false);
    }
  };

  // Phase 3A: Load candidate structure into canvas
  const handleLoadCandidateToEditor = async (candidate) => {
    if (!candidate || !candidate.smiles) {
      showStatus("Selected candidate has no SMILES representation.");
      return;
    }

    // Requirement 6: Validate that the returned SMILES is parseable before loading it
    const validation = validateSmiles(candidate.smiles);
    if (!validation.valid) {
      setBuildError({
        type: "invalid_smiles",
        title: "Unparseable Structure SMILES",
        message: `The SMILES string for "${
          candidate.name || "CID " + candidate.cid
        }" could not be parsed: ${validation.error}`,
        details: `Candidate SMILES: ${candidate.smiles}`,
      });
      return;
    }

    try {
      // Clear stale identification and explanation results
      setIdentifyResult(null);
      setIdentifyError(null);
      setExplainResult(null);
      setExplainError(null);

      setSelectedCandidateCid(candidate.cid);
      moleculeManager.loadSmiles(candidate.smiles);
      showStatus(
        `Loaded "${
          candidate.name || "Candidate CID " + candidate.cid
        }" onto Canvas!`
      );

      // Smooth scroll to canvas
      const canvasEl = document.getElementById("desktop-canvas-card");
      if (canvasEl) {
        canvasEl.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    } catch (err) {
      console.error("Failed to load candidate structure:", err);
      setBuildError({
        type: "load_failed",
        title: "Failed to Load Structure",
        message:
          err?.message || "Could not render the candidate structure.",
        details: `SMILES: ${candidate.smiles}`,
      });
    }
  };

  // Phase 3B: Request AI-generated structure hypothesis via POST /api/generate-structure
  const handleGenerateStructure = async (queryOverride) => {
    const q = (queryOverride !== undefined ? queryOverride : buildQuery).trim();
    if (!q) {
      setAiError({
        type: "empty",
        title: "Input Required",
        message: "Please enter a compound name or molecular formula for AI structure generation.",
      });
      return;
    }

    if (queryOverride !== undefined) {
      setBuildQuery(queryOverride);
    }

    if (aiLoading) return; // Prevent duplicate requests while in flight

    setAiLoading(true);
    setAiError(null);
    setAiCandidate(null);
    setAiApproved(false);

    try {
      const res = await fetch(API_ROUTES.generateStructure, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: "Invalid JSON received from server", raw: text };
      }

      if (!res.ok) {
        if (data.code === "AI_CONFIG_MISSING" || res.status === 503) {
          setAiError({
            type: "config_error",
            title: "AI Configuration Required",
            message: data.error || "AI service is not configured on the backend.",
            details: data.details || "Add a valid OPENROUTER_API_KEY in backend/.env.",
            code: data.code,
          });
        } else if (data.code === "AI_INVALID_SMILES" || res.status === 422) {
          setAiError({
            type: "invalid_smiles",
            title: "Invalid Generated Structure",
            message: data.error || "The AI generated an unparseable molecular structure.",
            details: data.details,
            proposedSmiles: data.proposedSmiles,
            code: data.code,
          });
        } else if (data.code === "AI_CREDITS_DEPLETED" || res.status === 402) {
          setAiError({
            type: "credits_depleted",
            title: "AI Credits Depleted",
            message: data.error || "AI service credits or balance depleted.",
            details: data.details,
            code: data.code,
          });
        } else if (data.code === "AI_RATE_LIMIT" || res.status === 429) {
          setAiError({
            type: "rate_limit",
            title: "AI Rate Limit Reached",
            message: data.error || "Rate limit reached. Please wait a moment and try again.",
            details: data.details,
            code: data.code,
          });
        } else if (data.code === "AI_TIMEOUT" || res.status === 504) {
          setAiError({
            type: "timeout",
            title: "Request Timed Out",
            message: data.error || "AI structure generation request timed out. Please try again.",
            code: data.code,
          });
        } else {
          setAiError({
            type: "server_error",
            title: "Generation Error",
            message: data.error || "Failed to generate molecular structure.",
            details: data.details,
            code: data.code,
          });
        }
      } else {
        setAiCandidate(data.candidate);
        setAiApproved(false);
        showStatus(`AI proposed structure candidate for "${data.candidate?.proposedName || q}". Review before loading.`);
      }
    } catch (err) {
      console.error("Generate structure error:", err);
      setAiError({
        type: "network_error",
        title: "Connection Failed",
        message: "Could not connect to CHEMAI backend service.",
      });
    } finally {
      setAiLoading(false);
    }
  };

  // Phase 3B: Explicit approval to load AI candidate into canvas
  const handleApproveAndLoadAiCandidate = async () => {
    if (!aiCandidate || !aiCandidate.smiles) return;

    // Validate SMILES before loading
    const validation = validateSmiles(aiCandidate.smiles);
    if (!validation.valid) {
      setAiError({
        type: "invalid_smiles",
        title: "Unparseable Structure SMILES",
        message: `The SMILES string cannot be loaded: ${validation.error}`,
        details: `SMILES: ${aiCandidate.smiles}`,
      });
      return;
    }

    try {
      // Clear previous identification and explanation states
      setIdentifyResult(null);
      setIdentifyError(null);
      setExplainResult(null);
      setExplainError(null);

      setAiApproved(true);
      moleculeManager.loadSmiles(aiCandidate.smiles);
      showStatus(`Approved & loaded AI structure for "${aiCandidate.proposedName}" onto Canvas!`);

      // Smooth scroll to canvas
      const canvasEl = document.getElementById("desktop-canvas-card");
      if (canvasEl) {
        canvasEl.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    } catch (err) {
      console.error("Failed to load approved AI structure:", err);
      setAiError({
        type: "load_failed",
        title: "Failed to Load Structure",
        message: err?.message || "Could not render the AI candidate structure.",
        details: `SMILES: ${aiCandidate.smiles}`,
      });
    }
  };

  // Phase 3B: Discard AI-generated candidate
  const handleDiscardAiCandidate = () => {
    setAiCandidate(null);
    setAiError(null);
    setAiApproved(false);
    showStatus("Discarded AI-generated candidate.");
  };

  if (activeView === "mobile") {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col overflow-hidden text-slate-100">
        {/* Mobile-optimized workspace container fitting screen perfectly */}
        <div className="flex-1 flex flex-col h-[calc(100dvh-64px)] max-h-[calc(100dvh-64px)] sm:h-[100dvh] sm:max-h-[100dvh] relative overflow-hidden">
          <MobileMolecularEditor
            mol={moleculeManager.mol}
            onMolChange={(newMol) => {
              moleculeManager.pushState(newMol);
              setIdentifyResult(null);
              setIdentifyError(null);
            }}
            undo={moleculeManager.undo}
            redo={moleculeManager.redo}
            canUndo={moleculeManager.canUndo}
            canRedo={moleculeManager.canRedo}
            clear={handleClearStructure}
            loadVersion={moleculeManager.loadVersion}
            editorRef={mobileEditorRef}
            onIdentify={(exported) => handleIdentifyMolecule(exported)}
            identifyLoading={identifyLoading}
            onOpenChat={() => handleOpenChat()}
            onSwitchToDesktop={handleSwitchToDesktop}
            onStructureChange={() => {
              setIdentifyResult(null);
              setIdentifyError(null);
            }}
            onSearchCandidate={async (query) => {
              const res = await fetch(`/api/search-structure?query=${encodeURIComponent(query)}&type=auto`);
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || "PubChem search failed");
              return data.candidates || [];
            }}
            className="flex-1"
          />

          {/* If an identification result or error exists, show a responsive card/drawer */}
          {(identifyResult || identifyError) && (
            <div className="absolute inset-x-0 bottom-0 z-40 max-h-[75vh] overflow-y-auto bg-white border-t border-slate-200 rounded-t-2xl shadow-2xl p-4 animate-in slide-in-from-bottom duration-200">
              {/* Close / Dismiss Bar */}
              <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-100">
                <span className="text-xs font-bold text-slate-700">
                  {identifyResult ? "PubChem Verified Compound" : "Identification Notice"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setIdentifyResult(null);
                    setIdentifyError(null);
                  }}
                  className="w-7 h-7 rounded-full bg-slate-100 text-slate-500 hover:text-slate-900 flex items-center justify-center text-xs font-bold"
                >
                  ✕
                </button>
              </div>

              {/* Verified Result Card */}
              {identifyResult && (
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-base font-bold text-slate-900 leading-tight">
                        {identifyResult.name}
                      </h3>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1 font-mono text-xs text-indigo-700">
                        <span className="bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded font-semibold">
                          {identifyResult.molecularFormula || identifyResult.formula}
                        </span>
                        {identifyResult.molecularWeight && (
                          <span className="bg-slate-100 px-2 py-0.5 rounded text-slate-700">
                            {identifyResult.molecularWeight} g/mol
                          </span>
                        )}
                        {identifyResult.cid && (
                          <span className="bg-slate-100 px-2 py-0.5 rounded text-slate-600">
                            CID: {identifyResult.cid}
                          </span>
                        )}
                        {identifyResult.casNumber && (
                          <span className="bg-slate-100 px-2 py-0.5 rounded text-slate-600">
                            CAS: {identifyResult.casNumber}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {identifyResult.iupacName && (
                    <div className="text-2xs text-slate-600 font-mono break-all bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                      <span className="text-slate-400 block uppercase font-sans font-bold mb-0.5 text-3xs">IUPAC Name:</span>
                      {identifyResult.iupacName}
                    </div>
                  )}

                  {/* Actions: Explain Structure & Ask ChemAI */}
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleExplainStructure}
                      className="min-h-[44px] px-3 rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-semibold text-xs flex items-center justify-center gap-1.5 shadow-sm transition-colors cursor-pointer"
                    >
                      <ChemAINeuralHexIcon className="w-4 h-4 text-violet-100" />
                      <span>Explain</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenChat()}
                      className="min-h-[44px] px-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs flex items-center justify-center gap-1.5 shadow-sm transition-colors cursor-pointer"
                    >
                      <span>✨</span>
                      <span>Ask ChemAI</span>
                    </button>
                  </div>

                  {identifyResult.cid && (
                    <div className="pt-1 text-center">
                      <a
                        href={`https://pubchem.ncbi.nlm.nih.gov/compound/${identifyResult.cid}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 hover:underline"
                      >
                        View Full PubChem Compound Record #{identifyResult.cid} ↗
                      </a>
                    </div>
                  )}
                </div>
              )}

              {/* Error Notice */}
              {identifyError && (
                <div className="space-y-3">
                  <div className="flex items-start gap-2.5 text-amber-600">
                    <span className="text-lg">⚠️</span>
                    <div>
                      <h4 className="font-bold text-sm text-slate-900">{identifyError.title}</h4>
                      <p className="text-xs text-slate-600 mt-0.5">{identifyError.message}</p>
                    </div>
                  </div>
                  {identifyError.details && (
                    <p className="text-2xs text-slate-600 font-mono bg-slate-50 p-2.5 rounded border border-slate-200">
                      {identifyError.details}
                    </p>
                  )}
                  {identifyError.smiles && (
                    <div className="pt-2">
                      <button
                        type="button"
                        onClick={() => handleOpenChat(`Can you help me analyze this structure with SMILES: ${identifyError.smiles}?`)}
                        className="w-full min-h-[44px] px-4 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-semibold text-xs flex items-center justify-center gap-2 shadow-sm transition-colors cursor-pointer"
                      >
                        <ChemAINeuralHexIcon className="w-4 h-4 text-cyan-100" />
                        <span>Ask ChemAI to Analyze Structure</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        {renderBridgeApprovalModal()}
        {renderChatDrawer()}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Top Navigation & Workspace Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Link
                to="/"
                className="text-sm font-medium text-gray-500 hover:text-blue-600 transition-colors flex items-center gap-1"
              >
                <span>←</span> Back to Home
              </Link>
              <span className="text-gray-300">/</span>
              <span className="text-xs font-semibold px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full border border-blue-200">
                Phase 3B
              </span>
              <span className="text-xs font-semibold px-2 py-0.5 bg-violet-50 text-violet-700 rounded-full border border-violet-200">
                AI Structure Generation Active
              </span>
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mt-1">
              Molecular Structure Workspace
            </h1>
            <p className="text-sm text-gray-500">
              Draw structures, look up compounds by name or formula, identify molecules against PubChem, and explain chemistry.
            </p>
          </div>

          {/* Action Toolbar — Logically Grouped & Responsive */}
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Primary Action Group: Identification & Central AI */}
            <div className="flex items-center gap-2">
              {/* Identify Molecule (Primary action on canvas structure) */}
              <button
                type="button"
                onClick={() => handleIdentifyMolecule()}
                disabled={!isEditorReady || identifyLoading}
                className="px-4 py-2.5 min-h-[44px] text-xs sm:text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 rounded-lg disabled:opacity-50 transition-colors flex items-center gap-2 shadow-sm cursor-pointer"
                title="Query PubChem PUG REST with current structure to identify compound"
              >
                {identifyLoading ? (
                  <>
                    <span className="animate-spin text-sm">⏳</span>
                    <span>Identifying...</span>
                  </>
                ) : (
                  <>
                    <span>🔬</span>
                    <span>Identify Molecule</span>
                  </>
                )}
              </button>

              {/* Central AI: Ask ChemAI */}
              <button
                type="button"
                onClick={() => handleOpenChat()}
                className="px-4 py-2.5 min-h-[44px] text-xs sm:text-sm font-semibold text-white bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 active:from-cyan-700 active:to-blue-700 rounded-lg shadow-sm transition-all flex items-center gap-2 cursor-pointer"
                title="Open ChemAI Conversational Assistant"
              >
                <ChemAINeuralHexIcon className="w-4 h-4 text-cyan-200" />
                <span>Ask ChemAI</span>
                {identifyResult && (
                  <span className="hidden sm:inline-block text-[10px] bg-white/20 px-1.5 py-0.5 rounded font-mono truncate max-w-[90px]">
                    {identifyResult.name}
                  </span>
                )}
              </button>
            </div>

            {/* Canvas Tools Group */}
            <div className="flex flex-wrap items-center gap-1.5 bg-gray-100 p-1 rounded-lg border border-gray-200">
              <span className="text-[11px] font-semibold text-gray-500 px-1.5 hidden sm:inline">Samples:</span>
              {SAMPLE_STRUCTURES.map((sample) => (
                <button
                  key={sample.name}
                  type="button"
                  onClick={() => handleLoadSample(sample.smiles, sample.name)}
                  disabled={!isEditorReady}
                  className="px-2.5 py-1.5 min-h-[36px] text-xs font-medium text-gray-700 bg-white hover:bg-blue-50 hover:text-blue-700 rounded border border-gray-200 disabled:opacity-50 transition-colors shadow-2xs cursor-pointer"
                  title={`Load ${sample.name} (${sample.smiles})`}
                >
                  {sample.name}
                </button>
              ))}

              <div className="h-5 w-px bg-gray-300 mx-1 hidden sm:block" />

              {/* Clear Structure */}
              <button
                type="button"
                onClick={handleClearStructure}
                disabled={!isEditorReady}
                className="px-2.5 py-1.5 min-h-[36px] text-xs font-medium text-gray-700 bg-white hover:bg-red-50 hover:text-red-700 hover:border-red-300 rounded border border-gray-200 disabled:opacity-50 transition-colors flex items-center gap-1 shadow-2xs cursor-pointer"
                title="Clear all atoms and bonds from canvas"
              >
                <span>✕</span> Clear
              </button>
            </div>

            {/* Structure Search & Builder Group */}
            <div className="flex items-center gap-1.5">
              {/* Build Structure Toggle */}
              <button
                type="button"
                onClick={() => setShowBuildStructure(!showBuildStructure)}
                className={`px-3 py-2 min-h-[38px] text-xs sm:text-sm font-semibold rounded-lg border transition-all flex items-center gap-1.5 shadow-2xs cursor-pointer ${
                  showBuildStructure
                    ? "bg-sky-50 border-sky-400 text-sky-800 ring-2 ring-sky-200"
                    : "bg-white border-gray-300 text-gray-700 hover:bg-gray-50 hover:text-sky-700"
                }`}
                title="Toggle Search & Build panel to search PubChem by name or formula"
              >
                <span>🏗️</span>
                <span>{showBuildStructure ? "Hide Builder" : "Search & Build"}</span>
              </button>

              {/* Compound Analyzer Toggle */}
              <button
                type="button"
                onClick={() => setShowAnalyzer(!showAnalyzer)}
                className={`px-3 py-2 min-h-[38px] text-xs sm:text-sm font-medium rounded-lg border transition-colors flex items-center gap-1.5 shadow-2xs cursor-pointer ${
                  showAnalyzer
                    ? "bg-blue-50 border-blue-300 text-blue-700"
                    : "bg-white border-gray-300 text-gray-700 hover:bg-gray-50"
                }`}
                title="Toggle PubChem Compound Analyzer lookup"
              >
                <span>🔍</span>
                <span>{showAnalyzer ? "Hide Analyzer" : "Analyzer"}</span>
              </button>

              {/* View Mode Switcher: Switch to Mobile Editor */}
              <button
                type="button"
                onClick={handleSwitchToMobile}
                className="px-3 py-2 min-h-[38px] text-xs sm:text-sm font-semibold rounded-lg border border-purple-300 bg-purple-50 text-purple-700 hover:bg-purple-100 transition-colors flex items-center gap-1.5 shadow-2xs cursor-pointer"
                title="Switch to Mobile-First Molecular Editor"
              >
                <span>📱</span>
                <span>Mobile View</span>
              </button>
            </div>
          </div>
        </div>

        {/* Status Notification Banner */}
        {statusMessage && (
          <div className="max-w-7xl mx-auto mt-2 text-xs font-medium text-blue-800 bg-blue-50 border border-blue-200 px-3 py-1.5 rounded-md flex items-center justify-between">
            <span>ℹ️ {statusMessage}</span>
            <button
              onClick={() => setStatusMessage("")}
              className="text-blue-500 hover:text-blue-800 cursor-pointer"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Main Workspace Body */}
      <main className="max-w-7xl mx-auto w-full p-4 md:p-6 flex-1 flex flex-col gap-6">
        {/* Phase 1B: Identification Result Card */}
        {identifyResult && (
          <div className="bg-white rounded-xl shadow-md border-2 border-indigo-300 overflow-hidden transition-all animate-in fade-in slide-in-from-top-2 duration-200">
            {/* Header bar */}
            <div className="bg-gradient-to-r from-indigo-50 via-blue-50 to-indigo-50 px-6 py-3.5 border-b border-indigo-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="flex h-3 w-3 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-indigo-600"></span>
                </span>
                <span className="text-indigo-950 font-bold text-base">
                  PubChem Match Verified
                </span>
                <span className="text-xs bg-indigo-100 text-indigo-800 px-2.5 py-0.5 rounded-full font-semibold border border-indigo-200">
                  CID: {identifyResult.cid}
                </span>
                {identifyResult.casNumber && (
                  <span
                    className="text-xs bg-slate-100 text-slate-800 px-2.5 py-0.5 rounded-full font-semibold border border-slate-300"
                    title="Chemical Abstracts Service (CAS) Registry Number"
                  >
                    CAS: {identifyResult.casNumber}
                  </span>
                )}
                {identifyResult.ambiguous && (
                  <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-medium border border-amber-200">
                    Ambiguous Match ({identifyResult.matchCount} records)
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleExplainStructure}
                  className="px-3.5 py-2 min-h-[40px] text-xs sm:text-sm font-semibold text-white bg-violet-600 hover:bg-violet-700 active:bg-violet-800 rounded-lg transition-colors flex items-center gap-1.5 shadow-2xs cursor-pointer"
                  title="Open ChemAI Chat and generate full chemistry explanation"
                >
                  <ChemAINeuralHexIcon className="w-4 h-4 text-violet-100" />
                  <span>Explain Structure</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleOpenChat()}
                  className="px-3.5 py-2 min-h-[40px] text-xs sm:text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 rounded-lg transition-colors flex items-center gap-1.5 shadow-2xs cursor-pointer"
                  title="Open ChemAI Chat to ask custom questions about this compound"
                >
                  <span>✨</span>
                  <span>Ask ChemAI</span>
                </button>
                <a
                  href={`https://pubchem.ncbi.nlm.nih.gov/compound/${identifyResult.cid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-semibold text-indigo-700 hover:text-indigo-900 bg-white px-3 py-2 min-h-[40px] rounded-lg border border-indigo-200 hover:border-indigo-300 transition-colors shadow-2xs flex items-center gap-1 cursor-pointer"
                >
                  <span>PubChem</span>
                  <span>↗</span>
                </a>
                <button
                  type="button"
                  onClick={() => {
                    setIdentifyResult(null);
                  }}
                  className="text-gray-400 hover:text-gray-600 p-2 min-h-[40px] min-w-[40px] flex items-center justify-center cursor-pointer text-sm"
                  title="Close identification results"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Content body */}
            <div className="p-6 space-y-6">
              {/* Primary Identity Row */}
              <div className="flex flex-col md:flex-row md:items-baseline md:justify-between gap-2 pb-4 border-b border-gray-100">
                <div>
                  <span className="text-xs uppercase font-bold tracking-wider text-indigo-600">
                    Preferred Compound Name
                  </span>
                  <h2 className="text-3xl font-extrabold text-gray-900 mt-0.5">
                    {identifyResult.name}
                  </h2>
                  {identifyResult.iupacName && (
                    <p className="text-sm text-gray-600 mt-1">
                      <span className="font-semibold text-gray-500">IUPAC Name: </span>
                      <span className="font-mono text-gray-800">{identifyResult.iupacName}</span>
                    </p>
                  )}
                </div>
              </div>

              {/* Chemical Properties Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="bg-gray-50 p-3.5 rounded-lg border border-gray-200">
                  <span className="text-xs text-gray-500 uppercase font-semibold">Formula</span>
                  <p className="text-lg font-bold text-gray-900 mt-0.5 font-mono">
                    {identifyResult.molecularFormula || "—"}
                  </p>
                </div>
                <div className="bg-gray-50 p-3.5 rounded-lg border border-gray-200">
                  <span className="text-xs text-gray-500 uppercase font-semibold">Molecular Weight</span>
                  <p className="text-lg font-bold text-gray-900 mt-0.5 font-mono">
                    {identifyResult.molecularWeight ? `${identifyResult.molecularWeight} g/mol` : "—"}
                  </p>
                </div>
                <div className="bg-gray-50 p-3.5 rounded-lg border border-gray-200">
                  <span className="text-xs text-gray-500 uppercase font-semibold">PubChem CID</span>
                  <p className="text-lg font-bold text-indigo-700 mt-0.5 font-mono">
                    {identifyResult.cid}
                  </p>
                </div>
                <div className="bg-gray-50 p-3.5 rounded-lg border border-gray-200">
                  <span className="text-xs text-gray-500 uppercase font-semibold">Match Confidence</span>
                  <p className="text-lg font-bold text-emerald-700 mt-0.5">
                    100% Exact
                  </p>
                </div>
              </div>

              {/* Canonical SMILES */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-gray-700 uppercase tracking-wider">
                    Canonical SMILES (Standardized by PubChem)
                  </label>
                  <button
                    onClick={() => handleCopy(identifyResult.canonicalSmiles, "canonicalSmiles")}
                    className="text-xs text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1 cursor-pointer"
                  >
                    {copiedField === "canonicalSmiles" ? "✓ Copied" : "📋 Copy SMILES"}
                  </button>
                </div>
                <input
                  type="text"
                  readOnly
                  value={identifyResult.canonicalSmiles || ""}
                  className="w-full px-3.5 py-2.5 bg-gray-50 border border-gray-300 rounded-lg font-mono text-sm text-gray-900 select-all focus:outline-none"
                />
              </div>

              {/* Real-World Encyclopedic Context (Wikipedia API) */}
              {identifyResult.wikipedia && (
                <div className="bg-gradient-to-br from-slate-50 to-blue-50/40 rounded-xl p-4 sm:p-5 border border-slate-200/90 shadow-2xs">
                  <div className="flex items-start justify-between gap-3 mb-2.5">
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-slate-800 text-white flex items-center justify-center font-serif font-black text-xs select-none">
                        W
                      </span>
                      <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                        Real-World Context & Applications (Wikipedia)
                      </h4>
                    </div>
                    {identifyResult.wikipedia.url && (
                      <a
                        href={identifyResult.wikipedia.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-semibold text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-1"
                      >
                        <span>Read on Wikipedia</span>
                        <span>↗</span>
                      </a>
                    )}
                  </div>

                  <div className="flex flex-col sm:flex-row gap-4 items-start">
                    {identifyResult.wikipedia.thumbnail && (
                      <img
                        src={identifyResult.wikipedia.thumbnail}
                        alt={identifyResult.wikipedia.title || identifyResult.name}
                        className="w-20 h-20 object-contain rounded-lg bg-white p-1 border border-slate-200 shrink-0 shadow-2xs"
                        loading="lazy"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      {identifyResult.wikipedia.description && (
                        <p className="text-xs font-semibold text-slate-600 mb-1 capitalize">
                          {identifyResult.wikipedia.description}
                        </p>
                      )}
                      <p className="text-xs sm:text-sm text-slate-700 leading-relaxed">
                        {identifyResult.wikipedia.extract}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Synonyms / Alternative Names */}
              {identifyResult.synonyms && identifyResult.synonyms.length > 0 && (
                <div>
                  <label className="text-xs font-bold text-gray-700 uppercase tracking-wider block mb-2">
                    Common Synonyms & Trade Names
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {identifyResult.synonyms.map((syn, idx) => (
                      <span
                        key={idx}
                        className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 px-2.5 py-1 rounded-md border border-gray-200 font-medium transition-colors"
                      >
                        {syn}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Connected ChemAI Conversational Inquiries Hub */}
              <div className="mt-4 bg-gradient-to-br from-indigo-50/80 via-white to-violet-50/60 rounded-xl p-4 sm:p-5 border border-indigo-200/90 shadow-2xs space-y-3.5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2.5 border-b border-indigo-100">
                  <div className="flex items-center gap-2.5">
                    <div className="p-1.5 rounded-lg bg-indigo-600 text-white shadow-2xs shrink-0">
                      <ChemAINeuralHexIcon className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold uppercase tracking-wider text-indigo-950">
                        ChemAI Conversational Assistant
                      </h4>
                      <p className="text-[11px] text-indigo-700">
                        Ask questions, explore reaction mechanisms, or generate full chemistry explanations
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleExplainStructure}
                      className="px-3 py-1.5 min-h-[38px] text-xs font-semibold text-white bg-violet-600 hover:bg-violet-700 rounded-lg shadow-2xs flex items-center gap-1.5 transition-colors cursor-pointer"
                      title="Open AI Chat and generate full chemistry explanation"
                    >
                      <ChemAINeuralHexIcon className="w-3.5 h-3.5" />
                      <span>Explain Structure</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenChat()}
                      className="px-3 py-1.5 min-h-[38px] text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-2xs flex items-center gap-1.5 transition-colors cursor-pointer"
                      title="Open AI Chat with this compound attached"
                    >
                      <span>💬</span>
                      <span>Ask Custom Query</span>
                    </button>
                  </div>
                </div>

                <div>
                  <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider block mb-2">
                    Quick Chemistry Inquiries:
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        handleOpenChat(
                          `What functional groups are present in ${identifyResult.name}, and how do they determine its reactivity and acid-base behavior?`
                        )
                      }
                      className="p-2.5 text-left rounded-lg bg-white hover:bg-indigo-50/70 border border-indigo-100 hover:border-indigo-300 text-xs text-gray-700 hover:text-indigo-950 transition-all flex items-center justify-between group cursor-pointer shadow-2xs"
                    >
                      <span>🔬 Functional groups & reactivity</span>
                      <span className="text-indigo-400 group-hover:translate-x-0.5 transition-transform">→</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        handleOpenChat(
                          `Describe the primary synthetic routes, precursors, and retrosynthetic disconnections for ${identifyResult.name}.`
                        )
                      }
                      className="p-2.5 text-left rounded-lg bg-white hover:bg-indigo-50/70 border border-indigo-100 hover:border-indigo-300 text-xs text-gray-700 hover:text-indigo-950 transition-all flex items-center justify-between group cursor-pointer shadow-2xs"
                    >
                      <span>⚗️ Synthesis & reaction pathways</span>
                      <span className="text-indigo-400 group-hover:translate-x-0.5 transition-transform">→</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        handleOpenChat(
                          `What are the characteristic ¹H-NMR, ¹³C-NMR, and IR spectroscopic peaks for ${identifyResult.name}?`
                        )
                      }
                      className="p-2.5 text-left rounded-lg bg-white hover:bg-indigo-50/70 border border-indigo-100 hover:border-indigo-300 text-xs text-gray-700 hover:text-indigo-950 transition-all flex items-center justify-between group cursor-pointer shadow-2xs"
                    >
                      <span>📊 NMR & IR spectroscopy signatures</span>
                      <span className="text-indigo-400 group-hover:translate-x-0.5 transition-transform">→</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        handleOpenChat(
                          `What is the biological mechanism of action, pharmacology, or real-world application of ${identifyResult.name}?`
                        )
                      }
                      className="p-2.5 text-left rounded-lg bg-white hover:bg-indigo-50/70 border border-indigo-100 hover:border-indigo-300 text-xs text-gray-700 hover:text-indigo-950 transition-all flex items-center justify-between group cursor-pointer shadow-2xs"
                    >
                      <span>💊 Biological mechanism & applications</span>
                      <span className="text-indigo-400 group-hover:translate-x-0.5 transition-transform">→</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Phase 1B: Useful Identification Error / Notice Message */}
        {identifyError && (
          <div className="bg-white rounded-xl shadow-sm border border-amber-300 p-5 flex items-start justify-between gap-4 animate-in fade-in">
            <div className="flex items-start gap-3.5">
              <div className="w-10 h-10 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center font-bold text-lg shrink-0">
                {identifyError.type === "empty" ? "✏️" : identifyError.type === "not_found" ? "❓" : "⚠️"}
              </div>
              <div>
                <h3 className="text-base font-bold text-gray-900">
                  {identifyError.title || "Structure Notice"}
                </h3>
                <p className="text-sm text-gray-700 mt-0.5">
                  {identifyError.message}
                </p>
                {identifyError.details && (
                  <p className="text-xs text-gray-500 mt-1 font-mono">
                    {identifyError.details}
                  </p>
                )}
                {identifyError.smiles && (
                  <p className="text-xs text-gray-500 mt-1">
                    Submitted SMILES: <code className="bg-gray-100 px-1 py-0.5 rounded font-mono">{identifyError.smiles}</code>
                  </p>
                )}
                {identifyError.type === "unavailable" && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleOpenChat(`Can you analyze this chemical structure: ${identifyError.smiles || "drawn molecule"}? Explain its functional groups and chemical properties.`)}
                      className="px-3 py-1.5 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white text-xs font-semibold rounded-lg shadow-sm flex items-center gap-1.5 transition-all cursor-pointer"
                    >
                      <ChemAINeuralHexIcon className="w-3.5 h-3.5" />
                      <span>Ask ChemAI About This Structure</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleIdentifyMolecule()}
                      className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-medium rounded-lg transition-colors cursor-pointer"
                    >
                      Retry Identification
                    </button>
                  </div>
                )}
              </div>
            </div>
            <button
              onClick={() => setIdentifyError(null)}
              className="text-gray-400 hover:text-gray-600 text-sm cursor-pointer"
            >
              ✕
            </button>
          </div>
        )}

        {/* Phase 3A: Build Structure from Name or Molecular Formula */}
        {showBuildStructure && (
          <div
            id="build-structure-panel"
            className="bg-white rounded-xl shadow-sm border-2 border-sky-300 overflow-hidden transition-all animate-in fade-in slide-in-from-top-2 duration-200"
          >
            {/* Header */}
            <div className="bg-gradient-to-r from-sky-50 via-blue-50 to-indigo-50 px-6 py-4 border-b border-sky-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-sky-600 text-white flex items-center justify-center font-bold text-lg shadow-sm">
                  🏗️
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-gray-900">
                      Build Structure from Name or Formula
                    </h2>
                    <span className="text-xs bg-sky-100 text-sky-800 px-2.5 py-0.5 rounded-full font-semibold border border-sky-200">
                      Phase 3A
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Query PubChem by chemical compound name or molecular formula, view verified candidates, and load directly onto the canvas.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowBuildStructure(false)}
                className="text-gray-400 hover:text-gray-600 text-sm p-1.5 rounded-lg hover:bg-white/80 transition-colors cursor-pointer"
                title="Hide Build Structure panel"
              >
                ✕
              </button>
            </div>

            <div className="p-6 space-y-5">
              {/* Search Form */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleLookupStructure();
                }}
                className="space-y-3"
              >
                <div className="flex flex-col sm:flex-row gap-3">
                  {/* Mode selector */}
                  <div className="flex items-center bg-gray-100 p-1 rounded-lg border border-gray-200 shrink-0">
                    <button
                      type="button"
                      onClick={() => setBuildType("auto")}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                        buildType === "auto"
                          ? "bg-white text-gray-900 shadow-2xs"
                          : "text-gray-600 hover:text-gray-900"
                      }`}
                    >
                      Auto-Detect
                    </button>
                    <button
                      type="button"
                      onClick={() => setBuildType("name")}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                        buildType === "name"
                          ? "bg-white text-gray-900 shadow-2xs"
                          : "text-gray-600 hover:text-gray-900"
                      }`}
                    >
                      Compound Name
                    </button>
                    <button
                      type="button"
                      onClick={() => setBuildType("formula")}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                        buildType === "formula"
                          ? "bg-white text-gray-900 shadow-2xs"
                          : "text-gray-600 hover:text-gray-900"
                      }`}
                    >
                      Molecular Formula
                    </button>
                  </div>

                  {/* Input field */}
                  <div className="relative flex-1">
                    <input
                      type="text"
                      value={buildQuery}
                      onChange={(e) => setBuildQuery(e.target.value)}
                      placeholder={
                        buildType === "formula"
                          ? "Enter molecular formula (e.g. C2H6O, C6H6, H2O, NaCl)..."
                          : buildType === "name"
                          ? "Enter compound name (e.g. ethanol, aspirin, caffeine)..."
                          : "Enter compound name or formula (e.g. ethanol, C2H6O, aspirin, C6H6)..."
                      }
                      className="w-full pl-3.5 pr-8 py-2 text-sm border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-sky-500 focus:border-sky-500 font-mono sm:font-sans"
                    />
                    {buildQuery && (
                      <button
                        type="button"
                        onClick={() => {
                          setBuildQuery("");
                          setBuildResult(null);
                          setBuildError(null);
                        }}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs p-1 cursor-pointer"
                        title="Clear input"
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  {/* Submit Button */}
                  <button
                    type="submit"
                    disabled={buildLoading || !isEditorReady}
                    className="px-5 py-2 text-sm font-semibold text-white bg-sky-600 hover:bg-sky-700 active:bg-sky-800 disabled:opacity-50 rounded-lg transition-colors flex items-center justify-center gap-1.5 shadow-sm shrink-0 cursor-pointer"
                  >
                    {buildLoading ? (
                      <>
                        <span className="animate-spin text-sm">⏳</span> Searching...
                      </>
                    ) : (
                      <>
                        <span>🔍</span> Search Structure
                      </>
                    )}
                  </button>
                </div>

                {/* Quick Example Pills */}
                <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
                  <span className="text-gray-500 font-medium">Try Examples:</span>
                  <button
                    type="button"
                    onClick={() => handleLookupStructure("ethanol", "name")}
                    className="px-2.5 py-1 bg-gray-100 hover:bg-sky-100 hover:text-sky-800 rounded-md border border-gray-200 transition-colors text-gray-700 cursor-pointer"
                  >
                    Ethanol <span className="text-gray-400 font-mono">(Name)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleLookupStructure("C2H6O", "formula")}
                    className="px-2.5 py-1 bg-gray-100 hover:bg-sky-100 hover:text-sky-800 rounded-md border border-gray-200 transition-colors text-gray-700 font-mono cursor-pointer"
                  >
                    C2H6O <span className="text-gray-400 font-sans">(Isomers)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleLookupStructure("aspirin", "name")}
                    className="px-2.5 py-1 bg-gray-100 hover:bg-sky-100 hover:text-sky-800 rounded-md border border-gray-200 transition-colors text-gray-700 cursor-pointer"
                  >
                    Aspirin <span className="text-gray-400 font-mono">(Name)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleLookupStructure("C6H6", "formula")}
                    className="px-2.5 py-1 bg-gray-100 hover:bg-sky-100 hover:text-sky-800 rounded-md border border-gray-200 transition-colors text-gray-700 font-mono cursor-pointer"
                  >
                    C6H6 <span className="text-gray-400 font-sans">(Benzene, etc.)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleLookupStructure("caffeine", "name")}
                    className="px-2.5 py-1 bg-gray-100 hover:bg-sky-100 hover:text-sky-800 rounded-md border border-gray-200 transition-colors text-gray-700 cursor-pointer"
                  >
                    Caffeine <span className="text-gray-400 font-mono">(Name)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleLookupStructure("C3H8O", "formula")}
                    className="px-2.5 py-1 bg-gray-100 hover:bg-sky-100 hover:text-sky-800 rounded-md border border-gray-200 transition-colors text-gray-700 font-mono cursor-pointer"
                  >
                    C3H8O <span className="text-gray-400 font-sans">(Propanols)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleGenerateStructure()}
                    disabled={aiLoading || !buildQuery.trim()}
                    className="px-2.5 py-1 bg-violet-50 hover:bg-violet-100 hover:text-violet-900 text-violet-700 rounded-md border border-violet-200 transition-colors font-medium flex items-center gap-1 cursor-pointer disabled:opacity-40"
                    title="Ask AI to propose a structure for the query currently entered"
                  >
                    <span>✨</span> Ask AI to Suggest Structure
                  </button>
                </div>
              </form>

              {/* Build Error Notice */}
              {buildError && (
                <div className="bg-amber-50/80 border border-amber-300 rounded-lg p-4 flex flex-col gap-3 animate-in fade-in">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <span className="text-lg text-amber-600">
                        {buildError.type === "empty"
                          ? "✏️"
                          : buildError.type === "not_found"
                          ? "❓"
                          : "⚠️"}
                      </span>
                      <div>
                        <h4 className="text-sm font-bold text-amber-900">
                          {buildError.title}
                        </h4>
                        <p className="text-xs text-amber-800 mt-0.5">
                          {buildError.message}
                        </p>
                        {buildError.details && (
                          <p className="text-xs text-amber-700/80 mt-1 font-mono">
                            {buildError.details}
                          </p>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setBuildError(null)}
                      className="text-amber-500 hover:text-amber-800 text-xs p-1 cursor-pointer"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Phase 3B: Explicit Ask AI CTA when PubChem does not find compound */}
                  {buildError.type === "not_found" && (
                    <div className="mt-1 pt-3 border-t border-amber-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="text-xs text-amber-900">
                        <span className="font-semibold">Unindexed or novel compound?</span> Ask OpenRouter AI to formulate a molecular structure hypothesis.
                      </div>
                      <button
                        type="button"
                        onClick={() => handleGenerateStructure(buildQuery)}
                        disabled={aiLoading || !buildQuery.trim()}
                        className="px-3.5 py-1.5 bg-violet-600 hover:bg-violet-700 active:bg-violet-800 disabled:opacity-50 text-white text-xs font-semibold rounded-md shadow-2xs transition-colors flex items-center justify-center gap-1.5 shrink-0 cursor-pointer"
                        title="Query OpenRouter AI to propose a candidate structure"
                      >
                        {aiLoading ? (
                          <>
                            <span className="animate-spin text-xs">⏳</span> Asking AI...
                          </>
                        ) : (
                          <>
                            <span>✨</span> Ask AI to Suggest a Structure
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Phase 3B: AI Generation Loading Banner */}
              {aiLoading && (
                <div className="bg-violet-50/80 border border-violet-200 rounded-xl p-5 flex items-center gap-3.5 animate-in fade-in">
                  <div className="w-8 h-8 border-3 border-violet-600 border-t-transparent rounded-full animate-spin shrink-0"></div>
                  <div>
                    <h4 className="text-sm font-bold text-violet-950">
                      Generating Molecular Structure with AI...
                    </h4>
                    <p className="text-xs text-violet-800 mt-0.5">
                      Consulting OpenRouter to formulate a plausible chemical hypothesis and valid SMILES for <strong className="font-mono">{buildQuery}</strong>.
                    </p>
                  </div>
                </div>
              )}

              {/* Phase 3B: AI Generation Error Banner */}
              {aiError && (
                <div className="bg-red-50/90 border border-red-300 rounded-xl p-4 flex items-start justify-between gap-3 animate-in fade-in">
                  <div className="flex items-start gap-3">
                    <span className="text-lg text-red-600">⚠️</span>
                    <div>
                      <h4 className="text-sm font-bold text-red-950">
                        {aiError.title || "AI Structure Generation Notice"}
                      </h4>
                      <p className="text-xs text-red-800 mt-0.5">
                        {aiError.message}
                      </p>
                      {aiError.details && (
                        <p className="text-xs text-red-700/80 mt-1 font-mono">
                          {aiError.details}
                        </p>
                      )}
                      {aiError.proposedSmiles && (
                        <p className="text-xs text-red-700 mt-1 font-mono">
                          Proposed SMILES: {aiError.proposedSmiles}
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAiError(null)}
                    className="text-red-400 hover:text-red-700 text-xs p-1 cursor-pointer"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Phase 3B: AI-Generated Candidate Review Card (Safe preview & explicit approval) */}
              {aiCandidate && (
                <div className="bg-white rounded-xl shadow-sm border-2 border-violet-300 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                  {/* Card Header */}
                  <div className="bg-gradient-to-r from-violet-50 via-purple-50 to-indigo-50 px-6 py-3.5 border-b border-violet-200 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-3 w-3 relative">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-3 w-3 bg-violet-600"></span>
                      </span>
                      <span className="text-violet-950 font-bold text-base">
                        AI Structure Candidate Review
                      </span>
                      <span className="text-2xs bg-amber-100 text-amber-900 px-2.5 py-0.5 rounded-full font-bold border border-amber-300 flex items-center gap-1">
                        <span>⚠️</span> Unverified Hypothesis
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {aiApproved && (
                        <span className="text-xs bg-emerald-100 text-emerald-800 px-2.5 py-0.5 rounded-full font-semibold border border-emerald-300">
                          ✓ Loaded on Canvas
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={handleDiscardAiCandidate}
                        className="text-gray-400 hover:text-gray-600 text-sm p-1 cursor-pointer"
                        title="Discard AI candidate"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* Prominent Disclaimer Banner */}
                  <div className="bg-amber-50/70 border-b border-amber-200 px-6 py-2.5 flex items-start gap-2.5 text-xs text-amber-900">
                    <span className="text-base text-amber-600 shrink-0">⚠️</span>
                    <div>
                      <p className="font-semibold">AI-Generated — Not Independently Verified</p>
                      <p className="text-amber-800 text-2xs mt-0.5">
                        This molecular structure was generated by OpenRouter AI. It has not been experimentally validated and should be treated as an educational hypothesis. Review the proposed SMILES and reasoning below before deciding to load onto canvas.
                      </p>
                    </div>
                  </div>

                  <div className="p-6 space-y-4">
                    {/* Title & Query matching */}
                    <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2 pb-3 border-b border-gray-100">
                      <div>
                        <span className="text-2xs uppercase tracking-wider text-gray-500 font-semibold block">Proposed Compound Name</span>
                        <h3 className="text-lg font-bold text-gray-900 mt-0.5">
                          {aiCandidate.proposedName}
                        </h3>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Suggested for requested input: <strong className="font-mono text-gray-800">{aiCandidate.input}</strong>
                        </p>
                      </div>
                      {aiCandidate.pubchemVerification && (
                        <div className="text-right">
                          <span className="text-2xs uppercase tracking-wider text-gray-500 font-semibold block">PubChem Verification Check</span>
                          {aiCandidate.pubchemVerification.matched ? (
                            <span className="text-xs text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-2 py-0.5 inline-block font-semibold mt-0.5">
                              Matched CID: {aiCandidate.pubchemVerification.cid} ({aiCandidate.pubchemVerification.pubchemName})
                            </span>
                          ) : (
                            <span className="text-xs text-gray-600 bg-gray-100 border border-gray-200 rounded px-2 py-0.5 inline-block mt-0.5">
                              Novel / Unindexed in PubChem
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Properties summary */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="bg-gray-50 p-2.5 rounded-lg border border-gray-200">
                        <span className="text-2xs text-gray-500 uppercase font-semibold">Formula</span>
                        <p className="text-base font-bold text-gray-900 mt-0.5 font-mono">
                          {aiCandidate.molecularFormula || "—"}
                        </p>
                      </div>
                      <div className="bg-gray-50 p-2.5 rounded-lg border border-gray-200">
                        <span className="text-2xs text-gray-500 uppercase font-semibold">Mol Weight</span>
                        <p className="text-base font-bold text-gray-900 mt-0.5 font-mono">
                          {aiCandidate.molecularWeight ? `${aiCandidate.molecularWeight} g/mol` : "—"}
                        </p>
                      </div>
                      <div className="bg-gray-50 p-2.5 rounded-lg border border-gray-200">
                        <span className="text-2xs text-gray-500 uppercase font-semibold">Atoms</span>
                        <p className="text-base font-bold text-gray-900 mt-0.5 font-mono">
                          {aiCandidate.atomCount}
                        </p>
                      </div>
                      <div className="bg-gray-50 p-2.5 rounded-lg border border-gray-200">
                        <span className="text-2xs text-gray-500 uppercase font-semibold">Parser Status</span>
                        <p className="text-xs font-semibold text-emerald-700 mt-1 flex items-center gap-1">
                          <span>✓</span> OCL Verified SMILES
                        </p>
                      </div>
                    </div>

                    {/* Proposed SMILES */}
                    <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                      <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
                        <span className="font-semibold text-gray-700">Proposed SMILES String:</span>
                        <button
                          type="button"
                          onClick={() => handleCopy(aiCandidate.smiles, "aiSmiles")}
                          className="text-violet-600 hover:text-violet-800 text-xs cursor-pointer font-medium"
                        >
                          {copiedField === "aiSmiles" ? "✓ Copied" : "Copy SMILES"}
                        </button>
                      </div>
                      <div className="font-mono text-xs text-gray-800 bg-white p-2 rounded border border-gray-200 break-all select-all">
                        {aiCandidate.smiles}
                      </div>
                    </div>

                    {/* AI Reasoning & Uncertainty Notes */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                      <div className="bg-violet-50/40 p-3 rounded-lg border border-violet-100">
                        <span className="font-bold text-violet-950 block mb-1">💡 Reasoning Summary:</span>
                        <p className="text-gray-700 leading-relaxed">
                          {aiCandidate.reasoningSummary}
                        </p>
                      </div>
                      <div className="bg-amber-50/40 p-3 rounded-lg border border-amber-100">
                        <span className="font-bold text-amber-950 block mb-1">⚖️ Uncertainty & Isomerism:</span>
                        <p className="text-gray-700 leading-relaxed">
                          {aiCandidate.uncertaintyNote}
                        </p>
                      </div>
                    </div>

                    {/* Explicit Approval Actions */}
                    <div className="pt-3 border-t border-gray-100 flex flex-wrap items-center justify-between gap-3">
                      <div className="text-xs text-gray-500">
                        Review the candidate structure above. Click approve to load it onto the drawing canvas.
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleDiscardAiCandidate}
                          className="px-3.5 py-2 text-xs font-semibold text-gray-700 bg-white hover:bg-gray-50 rounded-lg border border-gray-300 transition-colors cursor-pointer"
                        >
                          Discard
                        </button>
                        <button
                          type="button"
                          onClick={handleApproveAndLoadAiCandidate}
                          disabled={!isEditorReady}
                          className="px-4 py-2 text-xs font-semibold text-white bg-violet-600 hover:bg-violet-700 active:bg-violet-800 rounded-lg shadow-sm transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                        >
                          <span>✓</span> {aiApproved ? "Reload Approved Structure" : "Approve & Load into Canvas"}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Candidate Results */}
              {buildResult && buildResult.candidates && buildResult.candidates.length > 0 && (
                <div className="space-y-4 pt-1 border-t border-gray-100">
                  {/* Results Header */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-gray-900">
                        Candidate Structures
                      </span>
                      <span className="text-xs font-semibold px-2 py-0.5 bg-sky-100 text-sky-800 rounded-full border border-sky-200">
                        {buildResult.candidates.length} candidate{buildResult.candidates.length > 1 ? "s" : ""}
                      </span>
                      <span className="text-xs text-gray-500">
                        for query <strong className="font-mono text-gray-800">"{buildResult.query}"</strong> ({buildResult.queryType})
                      </span>
                    </div>
                    {buildResult.source === "cache" && (
                      <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded">
                        ⚡ cached
                      </span>
                    )}
                  </div>

                  {/* Formula Isomer Honesty Notice (Requirement 9) */}
                  {buildResult.queryType === "formula" && (
                    <div className="bg-blue-50/70 border border-blue-200 rounded-lg p-3 text-xs text-blue-900 flex items-start gap-2">
                      <span className="text-blue-500 font-bold shrink-0">ℹ️</span>
                      <div>
                        <p className="font-semibold">Molecular Formula Notice:</p>
                        <p className="text-blue-800 mt-0.5">
                          Molecular formulas like <strong>{buildResult.query}</strong> can correspond to multiple distinct chemical isomers. CHEMAI displays verified structural candidates from PubChem without assuming a single identity. Review candidates below and select the specific structure to load.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Candidate Cards Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {buildResult.candidates.map((cand) => {
                      const isSelected = selectedCandidateCid === cand.cid;
                      return (
                        <div
                          key={cand.cid}
                          className={`rounded-lg border p-4 flex flex-col justify-between transition-all ${
                            isSelected
                              ? "border-sky-500 bg-sky-50/40 ring-1 ring-sky-400 shadow-xs"
                              : "border-gray-200 bg-white hover:border-gray-300 hover:shadow-2xs"
                          }`}
                        >
                          <div>
                            {/* Title & Badge */}
                            <div className="flex items-start justify-between gap-2">
                              <h5
                                className="font-bold text-sm text-gray-900 line-clamp-1"
                                title={cand.name}
                              >
                                {cand.name}
                              </h5>
                              <a
                                href={`https://pubchem.ncbi.nlm.nih.gov/compound/${cand.cid}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-2xs text-sky-700 hover:text-sky-900 bg-sky-50 px-1.5 py-0.5 rounded border border-sky-200 shrink-0 font-medium"
                                title="View CID on PubChem"
                              >
                                CID {cand.cid} ↗
                              </a>
                            </div>

                            {/* IUPAC Name if different */}
                            {cand.iupacName && cand.iupacName !== cand.name && (
                              <p
                                className="text-2xs text-gray-500 line-clamp-1 mt-0.5"
                                title={cand.iupacName}
                              >
                                {cand.iupacName}
                              </p>
                            )}

                            {/* Properties Row */}
                            <div className="flex items-center gap-3 text-xs text-gray-600 mt-2.5 pt-2 border-t border-gray-100">
                              <div>
                                <span className="text-gray-400 text-2xs block uppercase font-medium">
                                  Formula
                                </span>
                                <span className="font-mono font-semibold text-gray-800">
                                  {cand.molecularFormula || "—"}
                                </span>
                              </div>
                              <div>
                                <span className="text-gray-400 text-2xs block uppercase font-medium">
                                  MW
                                </span>
                                <span className="font-mono text-gray-800">
                                  {cand.molecularWeight
                                    ? `${cand.molecularWeight} g/mol`
                                    : "—"}
                                </span>
                              </div>
                            </div>

                            {/* SMILES */}
                            <div className="mt-2.5 bg-gray-50 rounded p-1.5 border border-gray-100 flex items-center justify-between text-2xs">
                              <span
                                className="font-mono text-gray-700 truncate max-w-[200px]"
                                title={cand.smiles}
                              >
                                {cand.smiles}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  handleCopy(cand.smiles, `smiles_${cand.cid}`)
                                }
                                className="text-sky-600 hover:text-sky-800 ml-1 shrink-0 cursor-pointer"
                              >
                                {copiedField === `smiles_${cand.cid}`
                                  ? "✓"
                                  : "Copy"}
                              </button>
                            </div>
                          </div>

                          {/* Load Button */}
                          <div className="mt-3 pt-2">
                            <button
                              type="button"
                              onClick={() => handleLoadCandidateToEditor(cand)}
                              disabled={!isEditorReady}
                              className={`w-full py-1.5 px-3 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                                isSelected
                                  ? "bg-sky-600 hover:bg-sky-700 text-white shadow-2xs"
                                  : "bg-gray-100 hover:bg-sky-100 hover:text-sky-800 text-gray-800 border border-gray-200"
                              }`}
                            >
                              <span>⬇</span>{" "}
                              {isSelected
                                ? "Reload into Canvas"
                                : "Load into Canvas"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Desktop Molecular Structure Editor Canvas */}
        <div id="desktop-canvas-card" className="flex flex-col gap-3">
          {/* Quick Samples Strip */}
          <div className="bg-white px-4 py-2.5 rounded-xl border border-slate-200 shadow-2xs flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full inline-block bg-emerald-500 animate-pulse"></span>
              <span className="font-bold text-slate-800">Desktop Molecular Editor</span>
              <span className="text-slate-300">|</span>
              <span className="text-slate-500 hidden sm:inline">Draw atoms, bonds & rings</span>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-2xs font-semibold text-slate-400 uppercase tracking-wider mr-1">
                Samples:
              </span>
              {SAMPLE_STRUCTURES.map((sample) => (
                <button
                  key={sample.name}
                  type="button"
                  onClick={() => handleLoadSample(sample.smiles, sample.name)}
                  className="px-2.5 py-1 text-xs font-semibold text-slate-700 bg-slate-50 hover:bg-indigo-50 hover:text-indigo-700 hover:border-indigo-200 rounded-lg border border-slate-200 transition-colors shadow-2xs cursor-pointer"
                  title={`Load ${sample.name} structure`}
                >
                  {sample.name}
                </button>
              ))}
            </div>
          </div>

          {/* Desktop Molecular Editor Component */}
          <DesktopMolecularEditor
            mol={moleculeManager.mol}
            onMolChange={(newM) => {
              moleculeManager.pushState(newM);
              setIdentifyResult(null);
              setIdentifyError(null);
            }}
            undo={moleculeManager.undo}
            redo={moleculeManager.redo}
            canUndo={moleculeManager.canUndo}
            canRedo={moleculeManager.canRedo}
            clear={handleClearStructure}
            loadVersion={moleculeManager.loadVersion}
            onIdentify={handleIdentifyMolecule}
            identifyLoading={identifyLoading}
            onOpenChat={() => handleOpenChat()}
            onSwitchToMobile={handleSwitchToMobile}
            editorRef={desktopEditorRef}
          />
        </div>

        {/* Preserved Compound Analyzer Panel (PubChem Search & Backend Integration) */}
        {showAnalyzer && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="bg-gray-100/90 px-6 py-3 border-b border-gray-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-bold text-gray-800 text-sm">
                  ChemAI Compound Analyzer & PubChem Search
                </span>
                <span className="text-xs text-gray-500 bg-gray-200 px-2 py-0.5 rounded-full">
                  Endpoint: /api/analyze
                </span>
              </div>
              <button
                onClick={() => setShowAnalyzer(false)}
                className="text-gray-400 hover:text-gray-600 text-sm cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="p-6">
              <p className="text-xs text-gray-500 mb-4">
                Look up compounds from PubChem by name (e.g. <em>benzene</em>, <em>aspirin</em>, <em>caffeine</em>, <em>ibuprofen</em>) and inspect their molecular formula, molecular weight, SMILES, and PubChem CID. You can also import the structure directly into the editor canvas.
              </p>

              <div className="flex flex-wrap gap-3 mb-6">
                <input
                  type="text"
                  placeholder="Enter compound name (e.g. benzene)"
                  value={analyzerQuery}
                  onChange={(e) => setAnalyzerQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && analyzeCompound()}
                  className="px-4 py-2 border border-gray-300 rounded-lg w-72 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={analyzeCompound}
                  disabled={analyzerLoading}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium transition-colors cursor-pointer"
                >
                  {analyzerLoading ? "Analyzing..." : "Analyze Compound"}
                </button>
              </div>

              {analyzerResult && (
                <div className="bg-gray-50 border border-gray-200 p-5 rounded-lg max-w-xl">
                  {analyzerResult.error ? (
                    <div className="text-red-600 text-sm">
                      <p className="font-semibold">Analysis Error:</p>
                      <pre className="mt-1 font-mono text-xs whitespace-pre-wrap">
                        {analyzerResult.error}
                        {analyzerResult.raw ? `\n\nraw: ${analyzerResult.raw}` : ""}
                      </pre>
                    </div>
                  ) : (
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between items-center pb-2 border-b border-gray-200">
                        <span className="font-bold text-gray-900 text-base">
                          {analyzerResult.compound}
                        </span>
                        {analyzerResult.isomericSmiles && (
                          <button
                            onClick={() => handleLoadAnalyzedToEditor(analyzerResult.isomericSmiles)}
                            className="px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-md transition-colors cursor-pointer"
                          >
                            ⬇ Load into Editor Canvas
                          </button>
                        )}
                      </div>
                      <p className="text-gray-700">
                        <strong>Molecular Formula:</strong>{" "}
                        <span className="font-mono">{analyzerResult.molecularFormula || "—"}</span>
                      </p>
                      <p className="text-gray-700">
                        <strong>Molecular Weight:</strong>{" "}
                        <span className="font-mono">{analyzerResult.molecularWeight ? `${analyzerResult.molecularWeight} g/mol` : "—"}</span>
                      </p>
                      <p className="text-gray-700">
                        <strong>PubChem CID:</strong>{" "}
                        <span className="font-mono">{analyzerResult.cid || "—"}</span>
                      </p>
                      <p className="text-gray-700 flex items-center justify-between">
                        <span>
                          <strong>SMILES:</strong>{" "}
                          <span className="font-mono text-xs bg-white px-1.5 py-0.5 rounded border border-gray-200">
                            {analyzerResult.isomericSmiles || "—"}
                          </span>
                        </span>
                        {analyzerResult.isomericSmiles && (
                          <button
                            onClick={() => handleCopy(analyzerResult.isomericSmiles, "analyzerSmiles")}
                            className="text-xs text-blue-600 hover:text-blue-800 ml-2 cursor-pointer"
                          >
                            {copiedField === "analyzerSmiles" ? "✓ Copied" : "Copy"}
                          </button>
                        )}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
      {renderBridgeApprovalModal()}
      {renderChatDrawer()}
    </div>
  );
}