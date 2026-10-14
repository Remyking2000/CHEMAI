import React, { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { ChemAINeuralHexIcon } from "../components/ChemAIIcons";
import { API_ROUTES } from "../config/api";

// Curated compound presets for testing compound-focused context
const PRESET_COMPOUNDS = [
  {
    name: "Aspirin",
    formula: "C9H8O4",
    cid: 2244,
    weight: "180.16 g/mol",
    smiles: "CC(=O)Oc1ccccc1C(=O)O",
    iupac: "2-acetyloxybenzoic acid",
    category: "Analgesic & NSAID",
    description: "An acetylated salicylate derivative that irreversibly inhibits cyclooxygenase (COX-1 & COX-2) enzymes.",
  },
  {
    name: "Benzene",
    formula: "C6H6",
    cid: 241,
    weight: "78.11 g/mol",
    smiles: "c1ccccc1",
    iupac: "benzene",
    category: "Aromatic Hydrocarbon",
    description: "The prototypical planar aromatic hydrocarbon with 6 delocalized pi electrons satisfying Hückel's 4n+2 rule.",
  },
  {
    name: "Caffeine",
    formula: "C8H10N4O2",
    cid: 2519,
    weight: "194.19 g/mol",
    smiles: "Cn1cnc2c1c(=O)n(c(=O)n2C)C",
    iupac: "1,3,7-trimethylpurine-2,6-dione",
    category: "Purine Alkaloid",
    description: "A methylxanthine central nervous system stimulant that acts as a competitive antagonist of adenosine receptors.",
  },
  {
    name: "Ethanol",
    formula: "C2H6O",
    cid: 702,
    weight: "46.07 g/mol",
    smiles: "CCO",
    iupac: "ethanol",
    category: "Primary Alcohol",
    description: "A polar protic two-carbon alcohol capable of extensive hydrogen bonding, acting as a universal lab solvent.",
  },
  {
    name: "Paracetamol",
    formula: "C8H9NO2",
    cid: 1983,
    weight: "151.16 g/mol",
    smiles: "CC(=O)Nc1ccc(O)cc1",
    iupac: "N-(4-hydroxyphenyl)acetamide",
    category: "Analgesic & Antipyretic",
    description: "A para-aminophenol derivative that acts centrally to inhibit prostaglandin synthesis and lower fever.",
  },
];

// Example starter questions tailored to mode
const COMPOUND_EXAMPLE_QUESTIONS = [
  "What functional groups are present, and how do they govern this compound's acid-base behavior?",
  "What is the pharmacological or biological mechanism of action for this molecule?",
  "Describe the primary synthetic route and potential retrosynthetic disconnections for this compound.",
  "What are the characteristic IR and NMR spectroscopic signatures for this structure?",
];

const GENERAL_EXAMPLE_QUESTIONS = [
  "Explain the difference between SN1 and SN2 nucleophilic substitution reaction mechanisms.",
  "How does Hückel's 4n+2 rule determine aromaticity and molecular orbital stability?",
  "What molecular factors influence the pKa values of carboxylic acids versus alcohols?",
  "Explain how chirality, stereoisomerism, and enantiomeric excess impact medicinal chemistry.",
];

// Format chemical formulas into subscript notation (e.g., C9H8O4 -> C₉H₈O₄)
function formatSubscripts(formula) {
  if (!formula || typeof formula !== "string") return "";
  const subscriptMap = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
    "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉"
  };
  return formula.replace(/\d/g, (d) => subscriptMap[d] || d);
}

// Safely normalize compound data from navigation state, presets, or PubChem
function normalizeCompound(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    name: raw.name || "Identified Molecule",
    formula: raw.formula || raw.molecularFormula || "",
    weight: raw.weight || (raw.molecularWeight ? (typeof raw.molecularWeight === "number" ? `${raw.molecularWeight} g/mol` : String(raw.molecularWeight)) : ""),
    cid: raw.cid || null,
    smiles: raw.smiles || raw.canonicalSmiles || raw.inputSmiles || "",
    iupac: raw.iupac || raw.iupacName || "",
    category: raw.category || "PubChem Compound",
    description: raw.description || raw.wikipedia?.extract || "",
    casNumber: raw.casNumber || "",
    synonyms: Array.isArray(raw.synonyms) ? raw.synonyms : [],
    wikipediaUrl: raw.wikipediaUrl || raw.wikipedia?.url || null,
  };
}

export default function Chat() {
  const location = useLocation();

  // Active compound context: initialized from navigation state or defaults to null (General Chemistry)
  const [selectedCompound, setSelectedCompound] = useState(() => {
    if (location.state?.compound) {
      return normalizeCompound(location.state.compound);
    }
    return null;
  });

  // Conversation history
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [copiedField, setCopiedField] = useState(null);
  const [showMobileContext, setShowMobileContext] = useState(false);
  const [showPresetPicker, setShowPresetPicker] = useState(false);
  const [loading, setLoading] = useState(false);
  const [, setApiError] = useState(null);

  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const lastExecutedKeyRef = useRef(null);
  const handleSendMessageRef = useRef(null);

  // Auto-scroll to bottom whenever messages or loading state changes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Adjust textarea height dynamically
  const handleInputChange = (e) => {
    setInputValue(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
    }
  };

  // Copy string to clipboard with feedback
  const handleCopy = (text, fieldName) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedField(fieldName);
    setTimeout(() => setCopiedField(null), 2000);
  };

  // Submit a question to the backend chat API
  const handleSendMessage = async (textToSend = inputValue, compoundOverride = undefined) => {
    if (loading) return;
    const trimmed = (textToSend || "").trim();
    if (!trimmed) return;

    setApiError(null);

    const activeCompound = compoundOverride !== undefined ? compoundOverride : selectedCompound;

    const timestamp = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    const userMessage = {
      id: `user-${Date.now()}`,
      sender: "user",
      text: trimmed,
      timestamp,
      compoundContext: activeCompound,
    };

    // Capture conversation history for follow-ups
    const currentHistory = messages
      .filter((m) => !m.isError)
      .map((m) => ({
        role: m.sender === "user" ? "user" : "assistant",
        content: m.text,
      }));

    setMessages((prev) => [...prev, userMessage]);
    setInputValue("");
    setLoading(true);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    const payload = {
      message: trimmed,
      history: currentHistory,
      compound: activeCompound
        ? {
            name: activeCompound.name,
            formula: activeCompound.formula,
            weight: activeCompound.weight,
            cid: activeCompound.cid,
            smiles: activeCompound.smiles,
            iupac: activeCompound.iupac,
            category: activeCompound.category,
            description: activeCompound.description,
            casNumber: activeCompound.casNumber,
          }
        : null,
    };

    try {
      const res = await fetch(API_ROUTES.chat, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        const errorDetail = data.details ? ` (${data.details})` : "";
        throw new Error(data.error ? `${data.error}${errorDetail}` : `Server returned status ${res.status}`);
      }

      const assistantMessage = {
        id: `assistant-${Date.now()}`,
        sender: "assistant",
        text: data.reply,
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        compoundContext: activeCompound,
        provider: data.provider,
        model: data.model,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      console.error("[Chat] Request failed:", err);
      const errMsg = err.message || "Failed to communicate with ChemAI service. Please check your backend connection.";
      setApiError(errMsg);

      const errorMessage = {
        id: `assistant-err-${Date.now()}`,
        sender: "assistant",
        text: `⚠️ **Unable to complete chemistry query**\n\n${errMsg}\n\n*Please ensure your ChemAI server or Cloudflare API is reachable with a valid API key.*`,
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        compoundContext: activeCompound,
        isError: true,
      };

      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setLoading(false);
    }
  };

  handleSendMessageRef.current = handleSendMessage;

  // Synchronize incoming navigation state (e.g. from Explain Structure or Ask ChemAI)
  useEffect(() => {
    const rawCompound = location.state?.compound;
    const initialPrompt = location.state?.initialPrompt;

    if (rawCompound) {
      const norm = normalizeCompound(rawCompound);
      setSelectedCompound(norm);

      const executionKey = `${norm.name || "compound"}-${initialPrompt || ""}`;
      if (initialPrompt && lastExecutedKeyRef.current !== executionKey) {
        lastExecutedKeyRef.current = executionKey;
        if (handleSendMessageRef.current) {
          handleSendMessageRef.current(initialPrompt, norm);
        }
      }
    } else if (initialPrompt) {
      const executionKey = `general-${initialPrompt}`;
      if (lastExecutedKeyRef.current !== executionKey) {
        lastExecutedKeyRef.current = executionKey;
        if (handleSendMessageRef.current) {
          handleSendMessageRef.current(initialPrompt, null);
        }
      }
    }
  }, [location.state]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleClearConversation = () => {
    setMessages([]);
  };

  const handleAttachCompound = (compound) => {
    setSelectedCompound(compound);
    setShowPresetPicker(false);
    setShowMobileContext(false);
  };

  const handleDetachCompound = () => {
    setSelectedCompound(null);
    setShowMobileContext(false);
  };

  const activeQuestions = selectedCompound
    ? COMPOUND_EXAMPLE_QUESTIONS
    : GENERAL_EXAMPLE_QUESTIONS;

  return (
    <div className="min-h-[calc(100dvh-64px)] max-h-[calc(100dvh-64px)] h-[calc(100dvh-64px)] bg-slate-950 text-slate-100 flex flex-col lg:flex-row overflow-hidden">
      {/* Mobile Context Drawer Backdrop */}
      {showMobileContext && (
        <div
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-xs lg:hidden"
          onClick={() => setShowMobileContext(false)}
        />
      )}

      {/* ========================================================= */}
      {/* LEFT PANEL: Clearly Identifiable Compound-Context Area    */}
      {/* ========================================================= */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-80 sm:w-96 bg-slate-900 border-r border-slate-800/90 flex flex-col transition-transform duration-300 ease-in-out lg:static lg:translate-x-0 ${
          showMobileContext ? "translate-x-0 shadow-2xl" : "-translate-x-full"
        }`}
      >
        {/* Panel Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <ChemAINeuralHexIcon className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight">Compound Context</h2>
              <p className="text-[11px] text-slate-400">Attached Molecule Workspace</p>
            </div>
          </div>
          <button
            onClick={() => setShowMobileContext(false)}
            className="lg:hidden p-2 min-h-[44px] min-w-[44px] rounded-md text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center cursor-pointer"
            aria-label="Close context drawer"
          >
            ✕
          </button>
        </div>

        {/* Panel Body: Context Display */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
          {/* Context Status Indicator Card */}
          <div
            className={`p-3.5 rounded-xl border transition-all ${
              selectedCompound
                ? "bg-gradient-to-br from-cyan-950/40 via-slate-900 to-indigo-950/40 border-cyan-500/40 shadow-xs shadow-cyan-950/50"
                : "bg-slate-900/80 border-slate-800"
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Operating Mode
              </span>
              <span
                className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                  selectedCompound
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                    : "bg-cyan-500/10 text-cyan-300 border-cyan-500/30"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    selectedCompound ? "bg-emerald-400 animate-pulse" : "bg-cyan-400"
                  }`}
                />
                {selectedCompound ? "Compound-Focused" : "General Chemistry"}
              </span>
            </div>

            <p className="text-[11px] text-slate-300 leading-relaxed">
              {selectedCompound
                ? `Assistant answers are anchored to ${selectedCompound.name}. Inquiries will prioritize this structure's specific chemistry.`
                : "No compound attached. The assistant operates globally across organic, inorganic, analytical, and physical chemistry."}
            </p>
          </div>

          {/* ACTIVE COMPOUND DETAILS CARD */}
          {selectedCompound ? (
            <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 space-y-3.5">
              {/* Header and Category */}
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-widest text-cyan-400 block mb-0.5">
                    {selectedCompound.category || "Target Compound"}
                  </span>
                  <h3 className="text-lg font-black text-white">{selectedCompound.name}</h3>
                  {selectedCompound.iupac && (
                    <p className="text-[11px] text-slate-400 font-mono mt-0.5 break-words">
                      {selectedCompound.iupac}
                    </p>
                  )}
                </div>
                {selectedCompound.cid && (
                  <span className="shrink-0 px-2 py-0.5 rounded bg-blue-500/10 border border-blue-500/30 text-blue-300 text-[10px] font-mono font-bold">
                    CID {selectedCompound.cid}
                  </span>
                )}
              </div>

              {/* 2D Structure Preview Thumbnail (PubChem or Fallback) */}
              {selectedCompound.cid ? (
                <div className="relative rounded-lg bg-white p-2.5 flex items-center justify-center border border-slate-700/60 overflow-hidden group">
                  <img
                    src={`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${selectedCompound.cid}/PNG`}
                    alt={`2D structure of ${selectedCompound.name}`}
                    className="max-h-36 max-w-full object-contain filter contrast-125"
                    loading="lazy"
                  />
                  <div className="absolute bottom-1 right-1.5 text-[9px] font-mono font-bold text-gray-500 bg-white/90 px-1 rounded">
                    PubChem 2D
                  </div>
                </div>
              ) : (
                <div className="rounded-lg bg-slate-900 border border-slate-800 p-4 text-center text-slate-400">
                  <div className="text-2xl mb-1">⬡</div>
                  <p className="text-[11px]">2D structure preview available via CID</p>
                </div>
              )}

              {/* Molecular Properties Table */}
              <div className="grid grid-cols-2 gap-2 text-slate-300">
                <div className="p-2 rounded-lg bg-slate-900/90 border border-slate-800/80">
                  <span className="text-[10px] text-slate-400 block font-semibold uppercase">Formula</span>
                  <span className="text-sm font-extrabold font-mono text-cyan-300">
                    {formatSubscripts(selectedCompound.formula) || "—"}
                  </span>
                </div>
                <div className="p-2 rounded-lg bg-slate-900/90 border border-slate-800/80">
                  <span className="text-[10px] text-slate-400 block font-semibold uppercase">Mol Weight</span>
                  <span className="text-sm font-extrabold font-mono text-slate-200">
                    {selectedCompound.weight || "—"}
                  </span>
                </div>
              </div>

              {/* Canonical SMILES with One-Click Copy */}
              {selectedCompound.smiles && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[10px] text-slate-400 font-semibold uppercase">
                    <span>Canonical SMILES</span>
                    <button
                      onClick={() => handleCopy(selectedCompound.smiles, "smiles")}
                      className="text-cyan-400 hover:text-cyan-300 transition-colors cursor-pointer"
                    >
                      {copiedField === "smiles" ? "✓ Copied" : "Copy"}
                    </button>
                  </div>
                  <div className="p-2 rounded-lg bg-slate-900 border border-slate-800 font-mono text-[11px] text-slate-200 break-all select-all">
                    {selectedCompound.smiles}
                  </div>
                </div>
              )}

              {/* Description */}
              {selectedCompound.description && (
                <p className="text-[11px] text-slate-300 leading-relaxed border-t border-slate-800/80 pt-2.5">
                  {selectedCompound.description}
                </p>
              )}

              {/* Context Actions */}
              <div className="pt-2 flex flex-col gap-2">
                <button
                  onClick={handleDetachCompound}
                  className="w-full py-2 px-3 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-rose-300 border border-rose-500/25 hover:border-rose-500/40 transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <span>✕</span>
                  <span>Detach Context (Switch to General)</span>
                </button>
                <Link
                  to="/editor"
                  state={selectedCompound ? { loadSmiles: selectedCompound.smiles, compound: selectedCompound } : null}
                  className="w-full py-2.5 px-3 min-h-[44px] rounded-lg text-xs font-semibold bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <span>🧪</span>
                  <span>Open in Molecular Editor</span>
                </Link>
              </div>
            </div>
          ) : (
            /* EMPTY CONTEXT: GENERAL MODE INFO & QUICK PRESETS */
            <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800/90 space-y-4">
              <div className="text-center py-2">
                <div className="inline-flex p-3 rounded-xl bg-cyan-500/10 text-cyan-400 mb-2">
                  <ChemAINeuralHexIcon className="w-6 h-6" />
                </div>
                <h3 className="text-sm font-bold text-white">General Chemistry Active</h3>
                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                  You are currently asking unconstrained chemistry questions. You can attach a compound anytime to anchor the discussion.
                </p>
              </div>

              {/* Quick Preset Selector */}
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-2">
                  Attach Preset Compound:
                </span>
                <div className="space-y-1.5">
                  {PRESET_COMPOUNDS.map((cmp) => (
                    <button
                      key={cmp.name}
                      onClick={() => handleAttachCompound(cmp)}
                      className="w-full text-left p-2.5 rounded-lg bg-slate-900/90 hover:bg-slate-800/90 border border-slate-800 hover:border-cyan-500/40 transition-all flex items-center justify-between group cursor-pointer"
                    >
                      <div>
                        <div className="font-bold text-white group-hover:text-cyan-300 text-xs transition-colors">
                          {cmp.name}
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono">
                          {formatSubscripts(cmp.formula)} • {cmp.category}
                        </div>
                      </div>
                      <span className="text-xs text-slate-500 group-hover:text-cyan-400 transition-colors">
                        + Attach
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Quick Preset Switcher Dropdown (when context is already active) */}
          {selectedCompound && (
            <div className="relative">
              <button
                onClick={() => setShowPresetPicker((prev) => !prev)}
                className="w-full py-2 px-3 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 text-xs font-semibold flex items-center justify-between transition-colors cursor-pointer"
              >
                <span>Switch to another preset...</span>
                <span>{showPresetPicker ? "▲" : "▼"}</span>
              </button>
              {showPresetPicker && (
                <div className="absolute bottom-full left-0 right-0 mb-1 rounded-xl bg-slate-900 border border-slate-700 shadow-xl p-2 space-y-1 z-30">
                  {PRESET_COMPOUNDS.map((cmp) => (
                    <button
                      key={cmp.name}
                      onClick={() => handleAttachCompound(cmp)}
                      className={`w-full text-left p-2 rounded-lg text-xs transition-colors flex items-center justify-between cursor-pointer ${
                        selectedCompound?.name === cmp.name
                          ? "bg-cyan-500/20 text-cyan-300 font-bold"
                          : "text-slate-300 hover:bg-slate-800"
                      }`}
                    >
                      <span>{cmp.name}</span>
                      <span className="font-mono text-[10px] text-slate-400">
                        {formatSubscripts(cmp.formula)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Panel Footer */}
        <div className="p-3 border-t border-slate-800/80 bg-slate-950/70 text-[11px] text-slate-400 flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-cyan-400" />
            ChemAI Lab Suite
          </span>
          <span className="font-mono text-[10px] text-slate-500">Phase 1</span>
        </div>
      </aside>

      {/* ========================================================= */}
      {/* RIGHT AREA: Main Chat Area & Conversation Feed            */}
      {/* ========================================================= */}
      <main className="flex-1 flex flex-col h-[calc(100dvh-64px)] max-h-[calc(100dvh-64px)] overflow-hidden bg-slate-950">
        {/* Top Control Bar */}
        <div className="px-3 sm:px-6 py-2.5 sm:py-3 border-b border-slate-800/80 bg-slate-900/70 backdrop-blur-md flex items-center justify-between gap-2 sm:gap-3 shrink-0">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            {/* Primary Return to Editor Action */}
            <Link
              to="/editor"
              state={selectedCompound ? { loadSmiles: selectedCompound.smiles, compound: selectedCompound } : null}
              className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[44px] rounded-lg bg-slate-800 hover:bg-slate-700 active:bg-slate-900 text-xs sm:text-sm font-semibold text-cyan-300 border border-slate-700/80 hover:border-cyan-500/40 transition-colors shadow-2xs shrink-0 cursor-pointer"
              title="Return to Molecular Editor"
            >
              <span className="text-base font-bold">←</span>
              <span className="hidden sm:inline">Return to</span>
              <span>Editor</span>
            </Link>

            {/* Mobile Context Drawer Toggle */}
            <button
              onClick={() => setShowMobileContext(true)}
              className="lg:hidden px-2.5 py-2 min-h-[44px] rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-xs font-semibold text-cyan-300 flex items-center gap-1.5 cursor-pointer max-w-[130px] sm:max-w-[180px] truncate"
              title="Open Compound Details Drawer"
            >
              <span>⬡</span>
              <span className="truncate">{selectedCompound ? selectedCompound.name : "Context"}</span>
            </button>

            {/* Desktop Active Mode Badge */}
            <div className="hidden lg:flex items-center gap-2">
              <span className="text-slate-400 font-medium text-xs">Active Mode:</span>
              {selectedCompound ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 font-semibold font-mono text-xs">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span>{selectedCompound.name}</span>
                  {selectedCompound.formula && (
                    <span className="text-slate-400">({formatSubscripts(selectedCompound.formula)})</span>
                  )}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 border border-slate-700 text-slate-300 font-semibold text-xs">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                  <span>General Chemistry Mode</span>
                </span>
              )}

              {selectedCompound && (
                <button
                  onClick={handleDetachCompound}
                  className="text-[11px] text-slate-400 hover:text-rose-300 transition-colors cursor-pointer px-1 py-0.5"
                  title="Switch to unconstrained general chemistry"
                >
                  (Detach)
                </button>
              )}
            </div>
          </div>

          {/* Action buttons: Clear History */}
          <div className="flex items-center gap-2 shrink-0">
            {messages.length > 0 && (
              <button
                onClick={handleClearConversation}
                className="px-3 py-2 min-h-[44px] rounded-lg text-xs font-semibold text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
              >
                Clear History
              </button>
            )}
          </div>
        </div>

        {/* Mobile Compound Quick Pill Bar (visible when compound attached on small screens) */}
        {selectedCompound && (
          <div className="lg:hidden px-3.5 py-1.5 bg-slate-900/90 border-b border-cyan-500/20 text-xs flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
              <span className="font-bold text-white truncate text-[11px]">{selectedCompound.name}</span>
              {selectedCompound.formula && (
                <span className="text-slate-400 font-mono text-[10px] shrink-0">
                  ({formatSubscripts(selectedCompound.formula)})
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setShowMobileContext(true)}
                className="text-[11px] text-cyan-300 underline font-medium min-h-[36px] flex items-center cursor-pointer"
              >
                View Info
              </button>
              <button
                onClick={handleDetachCompound}
                className="text-[11px] text-rose-300 font-medium min-h-[36px] flex items-center cursor-pointer"
                title="Switch to General Chemistry"
              >
                Detach
              </button>
            </div>
          </div>
        )}

        {/* Message Stream Area */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
          {messages.length === 0 ? (
            /* ======================================================= */
            /* WELCOMING EMPTY STATE                                  */
            /* ======================================================= */
            <div className="max-w-2xl mx-auto py-8 sm:py-12 space-y-8">
              {/* Welcome Banner */}
              <div className="text-center space-y-3">
                <div className="inline-flex p-3.5 rounded-2xl bg-gradient-to-br from-cyan-500/20 via-blue-500/20 to-indigo-500/20 border border-cyan-500/30 shadow-lg shadow-cyan-950/40 text-cyan-400">
                  <ChemAINeuralHexIcon className="w-10 h-10" />
                </div>
                <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                  ChemAI Conversational Assistant
                </h1>
                <p className="text-sm sm:text-base text-slate-300 max-w-lg mx-auto leading-relaxed">
                  Your dedicated intelligent laboratory co-pilot. Inquire about reaction mechanisms,
                  stereochemistry, molecular properties, and chemical synthesis.
                </p>

                {/* Mode Pill Notice */}
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-xs">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      selectedCompound ? "bg-emerald-400" : "bg-cyan-400"
                    }`}
                  />
                  <span className="text-slate-300">
                    {selectedCompound
                      ? `Focused on compound: ${selectedCompound.name}`
                      : "General Mode — No compound attached"}
                  </span>
                </div>
              </div>

              {/* Example Question Cards */}
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs text-slate-400 font-semibold uppercase tracking-wider px-1">
                  <span>Suggested Chemistry Prompts</span>
                  <span className="text-[11px] font-normal text-slate-500 lowercase">
                    click any prompt to load into chat
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {activeQuestions.map((question, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleSendMessage(question)}
                      className="text-left p-3.5 rounded-xl bg-slate-900/75 hover:bg-slate-900 border border-slate-800/90 hover:border-cyan-500/40 text-xs sm:text-sm text-slate-300 hover:text-white transition-all shadow-xs hover:shadow-md hover:shadow-cyan-950/30 flex items-start gap-2.5 group cursor-pointer"
                    >
                      <span className="text-cyan-400 font-bold group-hover:translate-x-0.5 transition-transform mt-0.5">
                        →
                      </span>
                      <span className="leading-snug">{question}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Quick Mode Switcher Info Banner */}
              <div className="p-4 rounded-xl bg-slate-900/40 border border-slate-800/70 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-slate-400">
                <div>
                  <span className="font-semibold text-slate-200 block">
                    {selectedCompound
                      ? "Looking for general chemistry topics instead?"
                      : "Looking to analyze a specific chemical structure?"}
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {selectedCompound
                      ? "Detach the compound context from the sidebar to ask universal questions."
                      : "Select a compound preset or import from the 2D Editor for structure-anchored dialogues."}
                  </span>
                </div>

                {selectedCompound ? (
                  <button
                    onClick={handleDetachCompound}
                    className="shrink-0 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold transition-colors cursor-pointer"
                  >
                    Switch to General
                  </button>
                ) : (
                  <button
                    onClick={() => handleAttachCompound(PRESET_COMPOUNDS[0])}
                    className="shrink-0 px-3 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 font-semibold transition-colors cursor-pointer"
                  >
                    Attach Aspirin
                  </button>
                )}
              </div>
            </div>
          ) : (
            /* ======================================================= */
            /* CONVERSATION MESSAGE LIST                               */
            /* ======================================================= */
            <div className="max-w-3xl mx-auto space-y-4">
              {messages.map((msg) => {
                const isUser = msg.sender === "user";
                return (
                  <div
                    key={msg.id}
                    className={`flex items-start gap-3 ${
                      isUser ? "flex-row-reverse" : "flex-row"
                    }`}
                  >
                    {/* Avatar */}
                    <div
                      className={`w-8 h-8 rounded-lg shrink-0 flex items-center justify-center text-sm ${
                        isUser
                          ? "bg-gradient-to-r from-cyan-500 to-blue-600 text-white font-bold"
                          : "bg-slate-900 border border-cyan-500/30 text-cyan-400"
                      }`}
                    >
                      {isUser ? "🧑‍🔬" : <ChemAINeuralHexIcon className="w-4 h-4" />}
                    </div>

                    {/* Bubble Content */}
                    <div
                      className={`max-w-[85%] sm:max-w-[80%] rounded-2xl p-4 text-xs sm:text-sm leading-relaxed ${
                        isUser
                          ? "bg-gradient-to-r from-cyan-600/90 to-blue-600/90 text-white shadow-md shadow-cyan-950/40 rounded-tr-none"
                          : "bg-slate-900/95 border border-slate-800 text-slate-200 shadow-md rounded-tl-none space-y-2"
                      }`}
                    >
                      {/* Role & Context Meta Header */}
                      <div className="flex items-center justify-between gap-3 text-[10px] opacity-75 pb-1 border-b border-white/10">
                        <span className="font-bold uppercase tracking-wider">
                          {isUser ? "You (Researcher)" : "ChemAI Assistant"}
                        </span>
                        <span>{msg.timestamp}</span>
                      </div>

                      {/* Compound Context Tag if present */}
                      {msg.compoundContext && (
                        <div
                          className={`inline-flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded font-mono ${
                            isUser
                              ? "bg-white/20 text-white font-semibold"
                              : "bg-cyan-500/10 text-cyan-300 border border-cyan-500/20"
                          }`}
                        >
                          <span>⬡ Context:</span>
                          <span className="font-bold">{msg.compoundContext.name}</span>
                          {msg.compoundContext.formula && (
                            <span className="opacity-80">
                              ({formatSubscripts(msg.compoundContext.formula)})
                            </span>
                          )}
                        </div>
                      )}

                      {/* Message Body */}
                      <div className="whitespace-pre-wrap break-words">{msg.text}</div>

                      {/* Real Model Provider Metadata */}
                      {msg.model && (
                        <div className="mt-2 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[10px] text-cyan-400/80">
                          <span className="flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                            {msg.provider === "gemini" ? "Google Gemini" : "ChemAI Assistant"}
                          </span>
                          <span className="text-slate-500 font-mono text-[9px]">{msg.model}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Active Thinking / Reasoning Indicator */}
              {loading && (
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center bg-slate-900 border border-cyan-500/40 text-cyan-400">
                    <ChemAINeuralHexIcon className="w-4 h-4 animate-spin-slow" />
                  </div>
                  <div className="max-w-[85%] sm:max-w-[80%] rounded-2xl p-4 bg-slate-900/95 border border-cyan-500/30 text-slate-200 shadow-md rounded-tl-none space-y-2">
                    <div className="flex items-center justify-between text-[10px] text-cyan-400 pb-1 border-b border-white/5">
                      <span className="font-bold uppercase tracking-wider">ChemAI Assistant</span>
                      <span className="animate-pulse">Reasoning...</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-slate-300">
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping" />
                      <span>
                        Formulating chemistry response{selectedCompound ? ` on ${selectedCompound.name}` : ""}...
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 pt-1">
                      <span className="w-2 h-2 rounded-full bg-cyan-400 animate-bounce [animation-delay:-0.3s]" />
                      <span className="w-2 h-2 rounded-full bg-cyan-400 animate-bounce [animation-delay:-0.15s]" />
                      <span className="w-2 h-2 rounded-full bg-cyan-400 animate-bounce" />
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input & Send Area (Always pinned at bottom, mobile keyboard accessible) */}
        <div className="sticky bottom-0 z-20 p-3 sm:p-5 border-t border-slate-800/90 bg-slate-900/85 backdrop-blur-md pb-[max(0.75rem,env(safe-area-inset-bottom))] shrink-0">
          <div className="max-w-3xl mx-auto space-y-2">
            {/* Context Notice Tag above input */}
            <div className="flex items-center justify-between text-[11px] px-1 text-slate-400">
              <span className="flex items-center gap-1.5 truncate">
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    selectedCompound ? "bg-emerald-400" : "bg-cyan-400"
                  }`}
                />
                {selectedCompound ? (
                  <span className="truncate">
                    Directing question to: <strong className="text-cyan-300">{selectedCompound.name}</strong>
                  </span>
                ) : (
                  <span>General chemistry question mode</span>
                )}
              </span>
              <span className="hidden sm:inline text-slate-500 font-mono text-[10px] shrink-0">
                Enter to send • Shift+Enter for new line
              </span>
            </div>

            {/* Input Form */}
            <div className="relative flex items-end gap-2 bg-slate-950 border border-slate-800 focus-within:border-cyan-500/60 rounded-xl p-2 transition-all shadow-inner">
              <textarea
                ref={textareaRef}
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                disabled={loading}
                rows={1}
                placeholder={
                  loading
                    ? "ChemAI is formulating an answer..."
                    : selectedCompound
                    ? `Ask about ${selectedCompound.name} (e.g. reactivity, synthesis, functional groups)...`
                    : "Ask any chemistry question (e.g. SN1 vs SN2, aromaticity, pKa trends)..."
                }
                className="flex-1 bg-transparent border-0 text-slate-100 placeholder-slate-500 text-base sm:text-sm resize-none focus:outline-hidden px-2 py-2 min-h-[44px] max-h-40 leading-relaxed disabled:opacity-50"
              />

              <button
                onClick={() => handleSendMessage()}
                disabled={loading || !inputValue.trim()}
                className={`px-3.5 py-2.5 min-h-[44px] rounded-lg font-bold text-xs sm:text-sm flex items-center justify-center transition-all cursor-pointer ${
                  !loading && inputValue.trim()
                    ? "bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white shadow-md shadow-cyan-500/30 scale-100"
                    : "bg-slate-800 text-slate-500 cursor-not-allowed opacity-50"
                }`}
                title={loading ? "Generating response..." : "Send message"}
              >
                <span>{loading ? "Thinking..." : "Send"}</span>
                <span className="ml-1">{loading ? "⌛" : "→"}</span>
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
