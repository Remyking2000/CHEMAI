import React, { useState, useEffect, useRef, useMemo } from "react";
import { Link } from "react-router-dom";
import { Editor } from "ketcher-react";
import { ketcherProvider } from "ketcher-core";
import { StandaloneStructServiceProvider } from "ketcher-standalone";
import OCL from "openchemlib";
import "ketcher-react/dist/index.css";
import { ChemAINeuralHexIcon } from "../components/ChemAIIcons";

// Ensure KetcherLogger has a safe fallback before Ketcher finishes async initialization
if (typeof window !== "undefined" && !window.ketcher) {
  window.ketcher = {
    logging: { enabled: false },
    eventBus: { addListener: () => {}, removeListener: () => {} },
    editor: { serverSettings: {} },
  };
}

// Safeguard ketcherProvider.getKetcher against async unmount/remount race conditions on route changes
if (ketcherProvider && !ketcherProvider.__chemaiPatched) {
  const originalGetKetcher = ketcherProvider.getKetcher.bind(ketcherProvider);
  ketcherProvider.getKetcher = function (id) {
    try {
      return originalGetKetcher(id);
    } catch {
      if (this.ketcherInstances && this.ketcherInstances.size > 0) {
        const instances = Array.from(this.ketcherInstances.values());
        return instances[instances.length - 1];
      }
      return window.ketcher;
    }
  };
  ketcherProvider.__chemaiPatched = true;
}

// Quick example templates to test and draw
const SAMPLE_STRUCTURES = [
  { name: "Benzene", smiles: "c1ccccc1" },
  { name: "Aspirin", smiles: "CC(=O)Oc1ccccc1C(=O)O" },
  { name: "Ethanol", smiles: "CCO" },
  { name: "Caffeine", smiles: "Cn1cnc2c1c(=O)n(c(=O)n2C)C" },
];

export default function MolecularEditor() {
  const structServiceProvider = useMemo(
    () => new StandaloneStructServiceProvider(),
    []
  );
  const [ketcher, setKetcher] = useState(null);
  const [isEditorReady, setIsEditorReady] = useState(false);
  const [editorError, setEditorError] = useState(null);

  // Exported structure data
  const [exportData, setExportData] = useState(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [copiedField, setCopiedField] = useState(null);

  // Phase 1B: Chemical Identification state
  const [identifyResult, setIdentifyResult] = useState(null);
  const [identifyLoading, setIdentifyLoading] = useState(false);
  const [identifyError, setIdentifyError] = useState(null);

  // Phase 2: Gemini Chemistry Explanation state
  const [explainResult, setExplainResult] = useState(null);
  const [explainLoading, setExplainLoading] = useState(false);
  const [explainError, setExplainError] = useState(null);

  // Preserved Compound Analyzer state
  const [showAnalyzer, setShowAnalyzer] = useState(false);
  const [analyzerQuery, setAnalyzerQuery] = useState("");
  const [analyzerResult, setAnalyzerResult] = useState(null);
  const [analyzerLoading, setAnalyzerLoading] = useState(false);

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

  const identifyLoadingRef = useRef(false);
  identifyLoadingRef.current = identifyLoading;

  // Listen for canvas edits to clear stale identification and explanation results
  useEffect(() => {
    if (!ketcher) return;

    const handleCanvasChange = () => {
      // Clear stale identification and explanation results when user edits canvas, but not while actively loading identification
      if (identifyLoadingRef.current) return;
      setIdentifyResult(null);
      setIdentifyError(null);
      setExplainResult(null);
      setExplainError(null);
      setExplainLoading(false);
    };

    if (ketcher.changeEvent && typeof ketcher.changeEvent.add === "function") {
      ketcher.changeEvent.add(handleCanvasChange);
    }

    return () => {
      if (ketcher.changeEvent && typeof ketcher.changeEvent.remove === "function") {
        ketcher.changeEvent.remove(handleCanvasChange);
      }
    };
  }, [ketcher]);


  // Handler when Ketcher initializes
  const handleOnInit = (ketcherInstance) => {
    // Ketcher's internal KetcherLogger expects window.ketcher to be set
    window.ketcher = ketcherInstance;
    setKetcher(ketcherInstance);
    setIsEditorReady(true);
    setEditorError(null);
  };

  // Handler for Ketcher errors
  const handleEditorError = (err) => {
    console.error("Ketcher editor error:", err);
    setEditorError(typeof err === "string" ? err : err?.message || "Failed to initialize editor");
  };

  // Helper to extract current structure from Ketcher
  const getCurrentStructure = async () => {
    if (!ketcher) return { smiles: "", molfile: "", atomCount: 0 };

    let molfile = "";
    try {
      molfile = await ketcher.getMolfile();
    } catch (err) {
      console.warn("getMolfile error:", err);
    }

    let smiles = "";
    try {
      smiles = await ketcher.getSmiles();
    } catch (err) {
      console.warn("getSmiles error:", err);
    }

    let atomCount = 0;
    if (molfile && molfile.trim()) {
      try {
        const mol = OCL.Molecule.fromMolfile(molfile);
        atomCount = mol.getAllAtoms();
        if ((!smiles || !smiles.trim()) && atomCount > 0) {
          smiles = mol.toSmiles();
        }
      } catch (e) {
        console.warn("OCL parse error:", e);
      }
    }

    return { smiles: smiles ? smiles.trim() : "", molfile, atomCount };
  };

  // Identify drawn molecule via backend POST /api/identify
  const handleIdentifyMolecule = async () => {
    if (!ketcher) {
      showStatus("Editor is still initializing, please wait.");
      return;
    }

    if (identifyLoading) return; // Prevent duplicate submissions

    setIdentifyLoading(true);
    setIdentifyError(null);
    setIdentifyResult(null);
    setExplainResult(null);
    setExplainError(null);

    try {
      const { smiles, molfile, atomCount } = await getCurrentStructure();

      // Check for empty canvas
      if ((!smiles && !molfile) || atomCount === 0) {
        setIdentifyError({
          type: "empty",
          title: "Canvas is Empty",
          message: "Please draw a chemical structure before clicking Identify Molecule.",
        });
        setIdentifyLoading(false);
        return;
      }

      const res = await fetch("http://localhost:5000/api/identify", {
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
            message: data.error || "The upstream PubChem service is temporarily busy. Please try again shortly.",
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
        message: "Could not connect to the CHEMAI backend server (http://localhost:5000). Please ensure the backend is running.",
      });
    } finally {
      setIdentifyLoading(false);
    }
  };

  // Phase 2: Request Gemini chemistry explanation for the currently identified molecule
  const handleExplainStructure = async () => {
    if (!identifyResult || !identifyResult.cid) {
      showStatus("Identify a molecule first to generate a chemistry explanation.");
      return;
    }

    if (explainLoading) return; // Prevent duplicate submissions

    const smilesToSubmit =
      identifyResult.inputSmiles || identifyResult.canonicalSmiles || "";
    if (!smilesToSubmit.trim()) {
      setExplainError({
        type: "invalid",
        title: "Missing Structure SMILES",
        message: "No valid SMILES string is available for the currently identified compound.",
      });
      return;
    }

    setExplainLoading(true);
    setExplainError(null);
    setExplainResult(null);

    try {
      const res = await fetch("http://localhost:5000/api/explain-structure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ smiles: smilesToSubmit }),
      });

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: "Invalid JSON received from server", raw: text };
      }

      if (!res.ok) {
        if (
          data.configError ||
          data.code === "GEMINI_CONFIG_MISSING" ||
          data.code === "GEMINI_AUTH_ERROR"
        ) {
          setExplainError({
            type: "config_error",
            title: "Gemini Configuration Required",
            message:
              data.error || "Gemini API key is not configured on the backend server.",
            details:
              data.details ||
              "Set GEMINI_API_KEY in backend/.env (see backend/.env.example) and restart the backend server.",
            code: data.code,
          });
        } else if (res.status === 404 || data.code === "UNIDENTIFIED_COMPOUND") {
          setExplainError({
            type: "unidentified",
            title: "Identified Compound Required",
            message:
              data.error ||
              "This phase supports chemistry explanations for identified PubChem compounds only.",
            details: data.details,
          });
        } else if (res.status === 429 || data.code === "GEMINI_RATE_LIMIT") {
          setExplainError({
            type: "rate_limit",
            title: "Gemini Rate Limit Reached",
            message:
              data.error ||
              "Gemini API rate limit or quota reached. Please wait a moment and try again.",
          });
        } else if (res.status === 504 || data.code === "GEMINI_TIMEOUT") {
          setExplainError({
            type: "timeout",
            title: "Explanation Request Timed Out",
            message:
              data.error ||
              "The Gemini explanation request timed out. Please try again shortly.",
          });
        } else {
          setExplainError({
            type: "service_error",
            title: "Explanation Service Error",
            message:
              data.error ||
              "Unable to generate chemistry explanation from the Gemini service.",
            details: data.details,
          });
        }
      } else {
        setExplainResult(data);
        showStatus(`Generated chemistry explanation for ${identifyResult.name}!`);
      }
    } catch (err) {
      console.error("Explain structure fetch error:", err);
      setExplainError({
        type: "network_error",
        title: "Connection Failed",
        message:
          "Could not connect to the CHEMAI backend server (http://localhost:5000). Please ensure the backend is running.",
      });
    } finally {
      setExplainLoading(false);
    }
  };

  // Export current molecular structure
  const handleExportStructure = async () => {
    if (!ketcher) {
      showStatus("Editor is not ready yet.");
      return;
    }

    setExportLoading(true);
    try {
      const { smiles, molfile, atomCount } = await getCurrentStructure();

      let formula = "";
      let molecularWeight = "";
      let bondCount = 0;

      if (molfile && molfile.trim()) {
        try {
          const mol = OCL.Molecule.fromMolfile(molfile);
          bondCount = mol.getAllBonds();
          if (atomCount > 0) {
            const mf = mol.getMolecularFormula();
            formula = mf.formula;
            molecularWeight = mf.absoluteWeight ? mf.absoluteWeight.toFixed(3) : "";
          }
        } catch (oclErr) {
          console.warn("OpenChemLib parsing notice:", oclErr);
        }
      }

      const isEmpty = (!molfile || !molfile.trim() || atomCount === 0) && (!smiles || !smiles.trim());

      if (isEmpty) {
        showStatus("Canvas is empty. Draw a molecule first to export its structure.");
        setExportData(null);
      } else {
        setExportData({
          smiles: smiles || "N/A",
          molfile: molfile || "",
          formula: formula || "—",
          molecularWeight: molecularWeight || "—",
          atomCount,
          bondCount,
          timestamp: new Date().toLocaleTimeString(),
        });
        showStatus("Structure successfully exported!");
      }
    } catch (err) {
      console.error("Failed to export structure:", err);
      showStatus(`Error exporting structure: ${err?.message || err}`);
    } finally {
      setExportLoading(false);
    }
  };

  // Clear current molecular structure
  const handleClearStructure = async () => {
    if (!ketcher) return;

    try {
      if (ketcher.editor && typeof ketcher.editor.clear === "function") {
        ketcher.editor.clear();
      } else if (typeof ketcher.setMolecule === "function") {
        await ketcher.setMolecule("");
      }
      setExportData(null);
      setIdentifyResult(null);
      setIdentifyError(null);
      setExplainResult(null);
      setExplainError(null);
      showStatus("Structure canvas cleared.");
    } catch (err) {
      console.error("Failed to clear structure:", err);
      try {
        await ketcher.setMolecule("");
        setExportData(null);
        setIdentifyResult(null);
        setIdentifyError(null);
        setExplainResult(null);
        setExplainError(null);
        showStatus("Structure canvas cleared.");
      } catch (e) {
        console.error("Fallback clear failed:", e);
      }
    }
  };

  // Load a sample structure into Ketcher
  const handleLoadSample = async (smiles, name) => {
    if (!ketcher) return;
    try {
      // Clear previous identification and explanation results
      setIdentifyResult(null);
      setIdentifyError(null);
      setExplainResult(null);
      setExplainError(null);
      await ketcher.setMolecule(smiles);
      showStatus(`Loaded ${name} onto canvas.`);
      // Auto-refresh export if currently viewing
      if (exportData) {
        setTimeout(handleExportStructure, 300);
      }
    } catch (err) {
      console.error(`Failed to load ${name}:`, err);
      showStatus(`Could not load molecule: ${err?.message || err}`);
    }
  };

  // Copy text to clipboard helper
  const handleCopy = (text, field) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  // Download Molfile as .mol
  const handleDownloadMol = () => {
    if (!exportData?.molfile) return;
    const blob = new Blob([exportData.molfile], { type: "chemical/x-mdl-molfile" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `chemai_structure_${Date.now()}.mol`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
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
      const res = await fetch("http://localhost:5000/api/analyze", {
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

  // Load analyzed compound into the Ketcher canvas
  const handleLoadAnalyzedToEditor = async (smiles) => {
    if (!ketcher || !smiles) return;
    try {
      setIdentifyResult(null);
      setIdentifyError(null);
      setExplainResult(null);
      setExplainError(null);
      await ketcher.setMolecule(smiles);
      showStatus(`Imported ${analyzerResult?.compound || "compound"} into Editor!`);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      console.error("Failed to import compound:", err);
      showStatus(`Could not load structure into editor: ${err?.message || err}`);
    }
  };

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
                Phase 1B
              </span>
              <span className="text-xs font-semibold px-2 py-0.5 bg-indigo-50 text-indigo-700 rounded-full border border-indigo-200">
                PubChem Identification Active
              </span>
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mt-1">
              Molecular Structure Workspace
            </h1>
            <p className="text-sm text-gray-500">
              Draw chemical structures, identify molecules against PubChem, and export data.
            </p>
          </div>

          {/* Action Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Quick Templates */}
            <div className="flex items-center gap-1 bg-gray-100 p-1 rounded-lg border border-gray-200">
              <span className="text-xs font-medium text-gray-500 px-2">Samples:</span>
              {SAMPLE_STRUCTURES.map((sample) => (
                <button
                  key={sample.name}
                  onClick={() => handleLoadSample(sample.smiles, sample.name)}
                  disabled={!isEditorReady}
                  className="px-2.5 py-1 text-xs font-medium text-gray-700 bg-white hover:bg-blue-50 hover:text-blue-700 rounded border border-gray-200 disabled:opacity-50 transition-colors shadow-2xs cursor-pointer"
                  title={`Load ${sample.name} (${sample.smiles})`}
                >
                  {sample.name}
                </button>
              ))}
            </div>

            {/* Clear Structure */}
            <button
              onClick={handleClearStructure}
              disabled={!isEditorReady}
              className="px-3.5 py-2 text-sm font-medium text-gray-700 bg-white hover:bg-red-50 hover:text-red-700 hover:border-red-300 rounded-lg border border-gray-300 disabled:opacity-50 transition-colors flex items-center gap-1.5 shadow-2xs cursor-pointer"
              title="Clear all atoms and bonds from canvas"
            >
              <span>✕</span> Clear Canvas
            </button>

            {/* Export Structure */}
            <button
              onClick={handleExportStructure}
              disabled={!isEditorReady || exportLoading}
              className="px-3.5 py-2 text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 hover:text-blue-700 rounded-lg border border-gray-300 disabled:opacity-50 transition-colors flex items-center gap-1.5 shadow-2xs cursor-pointer"
              title="Export structure as SMILES and Molfile"
            >
              {exportLoading ? (
                <>
                  <span className="animate-spin text-sm">⏳</span> Exporting...
                </>
              ) : (
                <>
                  <span>⬇</span> Export Structure
                </>
              )}
            </button>

            {/* Phase 1B: Primary Action — Identify Molecule */}
            <button
              onClick={handleIdentifyMolecule}
              disabled={!isEditorReady || identifyLoading}
              className="px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 rounded-lg disabled:opacity-50 transition-colors flex items-center gap-1.5 shadow-sm cursor-pointer"
              title="Query PubChem PUG REST with current structure to identify compound"
            >
              {identifyLoading ? (
                <>
                  <span className="animate-spin text-sm">⏳</span> Identifying Molecule...
                </>
              ) : (
                <>
                  <span>🔬</span> Identify Molecule
                </>
              )}
            </button>

            {/* Compound Analyzer Toggle (Preserved Functionality) */}
            <button
              onClick={() => setShowAnalyzer(!showAnalyzer)}
              className={`px-3.5 py-2 text-sm font-medium rounded-lg border transition-colors flex items-center gap-1.5 shadow-2xs cursor-pointer ${
                showAnalyzer
                  ? "bg-blue-50 border-blue-300 text-blue-700"
                  : "bg-white border-gray-300 text-gray-700 hover:bg-gray-50"
              }`}
              title="Toggle PubChem Compound Analyzer lookup"
            >
              <span>🔍</span> {showAnalyzer ? "Hide Analyzer" : "Compound Analyzer"}
            </button>
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
                {identifyResult.ambiguous && (
                  <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-medium border border-amber-200">
                    Ambiguous Match ({identifyResult.matchCount} records)
                  </span>
                )}
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={handleExplainStructure}
                  disabled={!identifyResult?.cid || explainLoading}
                  className="px-3.5 py-1.5 text-xs sm:text-sm font-semibold text-white bg-violet-600 hover:bg-violet-700 active:bg-violet-800 rounded-lg disabled:opacity-50 transition-colors flex items-center gap-1.5 shadow-2xs cursor-pointer"
                  title="Generate a beginner-friendly chemistry explanation using Gemini AI"
                >
                  {explainLoading ? (
                    <>
                      <span className="animate-spin text-xs">⏳</span> Explaining...
                    </>
                  ) : (
                    <>
                      <ChemAINeuralHexIcon className="w-4 h-4 text-violet-100" />
                      <span>Explain Structure</span>
                    </>
                  )}
                </button>
                <a
                  href={`https://pubchem.ncbi.nlm.nih.gov/compound/${identifyResult.cid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-semibold text-indigo-700 hover:text-indigo-900 bg-white px-3 py-1.5 rounded-lg border border-indigo-200 hover:border-indigo-300 transition-colors shadow-2xs flex items-center gap-1"
                >
                  <span>View on PubChem</span>
                  <span>↗</span>
                </a>
                <button
                  onClick={() => {
                    setIdentifyResult(null);
                    setExplainResult(null);
                    setExplainError(null);
                  }}
                  className="text-gray-400 hover:text-gray-600 text-sm p-1 cursor-pointer"
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

              {/* Phase 2: Gemini Chemistry Explanation Loading State */}
              {explainLoading && (
                <div className="mt-4 bg-violet-50/70 border border-violet-200 rounded-xl p-5 flex items-center gap-4">
                  <div className="w-8 h-8 border-3 border-violet-600 border-t-transparent rounded-full animate-spin shrink-0"></div>
                  <div>
                    <h4 className="text-sm font-bold text-violet-950">
                      Generating Gemini Chemistry Explanation...
                    </h4>
                    <p className="text-xs text-violet-700 mt-0.5">
                      Analyzing verified PubChem structure ({identifyResult.name}, {identifyResult.molecularFormula}) for functional groups, bonding, and educational insights.
                    </p>
                  </div>
                </div>
              )}

              {/* Phase 2: Gemini Explanation Error / Configuration Notice */}
              {explainError && (
                <div
                  className={`mt-4 rounded-xl p-5 border flex items-start justify-between gap-4 ${
                    explainError.type === "config_error"
                      ? "bg-amber-50/90 border-amber-300"
                      : "bg-red-50/90 border-red-300"
                  }`}
                >
                  <div className="flex items-start gap-3.5">
                    <div
                      className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-base shrink-0 ${
                        explainError.type === "config_error"
                          ? "bg-amber-100 text-amber-800"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {explainError.type === "config_error" ? "🔑" : "⚠️"}
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-gray-900">
                        {explainError.title || "Explanation Unavailable"}
                      </h4>
                      <p className="text-sm text-gray-800 mt-0.5">
                        {explainError.message}
                      </p>
                      {explainError.details && (
                        <p className="text-xs text-gray-600 mt-1.5 font-mono bg-white/80 px-2.5 py-1.5 rounded border border-gray-200">
                          {explainError.details}
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => setExplainError(null)}
                    className="text-gray-400 hover:text-gray-600 text-sm cursor-pointer"
                    title="Dismiss explanation notice"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Phase 2: Gemini Chemistry Explanation Panel */}
              {explainResult && explainResult.explanation && (
                <div className="mt-4 bg-gradient-to-br from-violet-50/60 via-white to-indigo-50/40 rounded-xl border-2 border-violet-200 overflow-hidden shadow-xs">
                  {/* Panel Header */}
                  <div className="bg-violet-100/70 px-5 py-3 border-b border-violet-200 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <ChemAINeuralHexIcon className="w-5 h-5 text-violet-700" />
                      <h3 className="text-sm font-bold text-violet-950">
                        Gemini Chemistry Explanation Assistant
                      </h3>
                      <span className="text-xs bg-violet-200/80 text-violet-900 px-2 py-0.5 rounded-full font-mono font-medium">
                        {explainResult.model || "gemini-2.5-flash"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs bg-white text-gray-600 px-2.5 py-0.5 rounded-full border border-violet-200 font-medium">
                        Educational Interpretation (Verify Independently)
                      </span>
                      <button
                        onClick={() => setExplainResult(null)}
                        className="text-gray-400 hover:text-gray-600 text-sm p-1 cursor-pointer"
                        title="Close explanation panel"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* Distinction Banner: Reference Data vs AI Interpretation */}
                  <div className="px-5 py-2.5 bg-indigo-50/70 border-b border-violet-100 text-xs text-indigo-950 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-bold uppercase tracking-wider text-indigo-700 mr-1.5">
                        Verified PubChem Reference:
                      </span>
                      <span className="font-semibold">{explainResult.referenceData?.name || identifyResult.name}</span>
                      {" · "}
                      <span className="font-mono">CID {explainResult.referenceData?.cid || identifyResult.cid}</span>
                      {" · "}
                      <span className="font-mono">{explainResult.referenceData?.molecularFormula || identifyResult.molecularFormula}</span>
                      {" · "}
                      <span className="font-mono">{explainResult.referenceData?.molecularWeight || identifyResult.molecularWeight} g/mol</span>
                    </div>
                    <span className="text-[11px] text-indigo-700 font-medium">
                      Source: PubChem PUG REST
                    </span>
                  </div>

                  {/* Structured Educational Sections */}
                  <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-white p-4 rounded-lg border border-gray-200 md:col-span-2">
                      <h4 className="text-xs font-bold uppercase tracking-wider text-violet-700 mb-1">
                        1. What This Compound Is
                      </h4>
                      <p className="text-sm text-gray-800 leading-relaxed">
                        {explainResult.explanation.whatItIs}
                      </p>
                    </div>

                    <div className="bg-white p-4 rounded-lg border border-gray-200">
                      <h4 className="text-xs font-bold uppercase tracking-wider text-violet-700 mb-1">
                        2. Formula & Basic Structural Features
                      </h4>
                      <p className="text-sm text-gray-800 leading-relaxed">
                        {explainResult.explanation.formulaAndStructure}
                      </p>
                    </div>

                    <div className="bg-white p-4 rounded-lg border border-gray-200">
                      <h4 className="text-xs font-bold uppercase tracking-wider text-violet-700 mb-1">
                        3. Functional Groups & Their Roles
                      </h4>
                      <p className="text-sm text-gray-800 leading-relaxed">
                        {explainResult.explanation.functionalGroups}
                      </p>
                    </div>

                    <div className="bg-white p-4 rounded-lg border border-gray-200">
                      <h4 className="text-xs font-bold uppercase tracking-wider text-violet-700 mb-1">
                        4. Bonding & Structural Characteristics
                      </h4>
                      <p className="text-sm text-gray-800 leading-relaxed">
                        {explainResult.explanation.bondingAndCharacteristics}
                      </p>
                    </div>

                    <div className="bg-white p-4 rounded-lg border border-gray-200">
                      <h4 className="text-xs font-bold uppercase tracking-wider text-violet-700 mb-1">
                        5. Why These Features Matter
                      </h4>
                      <p className="text-sm text-gray-800 leading-relaxed">
                        {explainResult.explanation.whyItMatters}
                      </p>
                    </div>
                  </div>

                  {/* Verification & Uncertainty Disclaimer Footer */}
                  <div className="px-5 py-3 bg-amber-50/70 border-t border-amber-200 text-xs text-amber-900 space-y-1">
                    <p>
                      <span className="font-bold">⚠️ Verification Note: </span>
                      {explainResult.explanation.uncertaintyAndVerificationNote}
                    </p>
                    {explainResult.disclaimer && (
                      <p className="text-[11px] text-amber-800">
                        {explainResult.disclaimer}
                      </p>
                    )}
                  </div>
                </div>
              )}
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

        {/* Ketcher Molecular Structure Editor Canvas */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col relative">
          {/* Ketcher Canvas Header Bar */}
          <div className="bg-gray-100/80 px-4 py-2 border-b border-gray-200 flex items-center justify-between text-xs text-gray-600">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block animate-pulse"></span>
              <span className="font-semibold text-gray-700">Ketcher 2D Drawing Workspace</span>
              <span className="text-gray-400">|</span>
              <span>Draw atoms, bonds, and rings, then click Identify Molecule</span>
            </div>
            <div className="text-gray-500 hidden sm:block">
              {isEditorReady ? "Status: Ready" : "Status: Initializing..."}
            </div>
          </div>

          {/* Ketcher React Workspace Wrapper */}
          <div className="relative w-full h-[620px] min-h-[500px] bg-white">
            {/* Loading Overlay */}
            {!isEditorReady && !editorError && (
              <div className="absolute inset-0 z-20 bg-white/95 flex flex-col items-center justify-center gap-3">
                <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                <p className="text-base font-medium text-gray-800">
                  Initializing Molecular Drawing Workspace...
                </p>
                <p className="text-xs text-gray-500">
                  Loading Ketcher and Indigo WebAssembly chemical engine
                </p>
              </div>
            )}

            {/* Error Overlay */}
            {editorError && (
              <div className="absolute inset-0 z-20 bg-white flex flex-col items-center justify-center p-6 text-center">
                <div className="w-12 h-12 bg-red-100 text-red-600 rounded-full flex items-center justify-center text-xl font-bold mb-3">
                  ⚠️
                </div>
                <h3 className="text-lg font-bold text-gray-900 mb-1">
                  Editor Initialization Error
                </h3>
                <p className="text-sm text-red-600 max-w-md mb-4">{editorError}</p>
                <button
                  onClick={() => window.location.reload()}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium cursor-pointer"
                >
                  Reload Page
                </button>
              </div>
            )}

            {/* Ketcher Editor Component */}
            <div className="w-full h-full">
              <Editor
                staticResourcesUrl=""
                structServiceProvider={structServiceProvider}
                disableMacromoleculesEditor={true}
                onInit={handleOnInit}
                errorHandler={handleEditorError}
              />
            </div>
          </div>
        </div>

        {/* Export Structure Results Panel */}
        {exportData && (
          <div className="bg-white rounded-xl shadow-sm border border-emerald-200 overflow-hidden">
            <div className="bg-emerald-50/80 px-6 py-3 border-b border-emerald-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-emerald-700 font-bold text-base">
                  Exported Structure
                </span>
                <span className="text-xs text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full font-medium">
                  Generated at {exportData.timestamp}
                </span>
              </div>
              <button
                onClick={() => setExportData(null)}
                className="text-gray-400 hover:text-gray-600 text-sm px-2 py-1 cursor-pointer"
                title="Dismiss export panel"
              >
                ✕ Close
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* Chemical Summary Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="bg-gray-50 p-3 rounded-lg border border-gray-200">
                  <span className="text-xs text-gray-500 uppercase font-semibold">Formula</span>
                  <p className="text-lg font-bold text-gray-900 mt-0.5 font-mono">
                    {exportData.formula}
                  </p>
                </div>
                <div className="bg-gray-50 p-3 rounded-lg border border-gray-200">
                  <span className="text-xs text-gray-500 uppercase font-semibold">Mol Weight</span>
                  <p className="text-lg font-bold text-gray-900 mt-0.5 font-mono">
                    {exportData.molecularWeight ? `${exportData.molecularWeight} g/mol` : "—"}
                  </p>
                </div>
                <div className="bg-gray-50 p-3 rounded-lg border border-gray-200">
                  <span className="text-xs text-gray-500 uppercase font-semibold">Atoms</span>
                  <p className="text-lg font-bold text-gray-900 mt-0.5">
                    {exportData.atomCount}
                  </p>
                </div>
                <div className="bg-gray-50 p-3 rounded-lg border border-gray-200">
                  <span className="text-xs text-gray-500 uppercase font-semibold">Bonds</span>
                  <p className="text-lg font-bold text-gray-900 mt-0.5">
                    {exportData.bondCount}
                  </p>
                </div>
              </div>

              {/* SMILES Representation */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-gray-700 uppercase tracking-wider">
                    SMILES Notation (Machine-Readable)
                  </label>
                  <button
                    onClick={() => handleCopy(exportData.smiles, "smiles")}
                    className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1 cursor-pointer"
                  >
                    {copiedField === "smiles" ? "✓ Copied SMILES" : "📋 Copy SMILES"}
                  </button>
                </div>
                <div className="relative">
                  <input
                    type="text"
                    readOnly
                    value={exportData.smiles}
                    className="w-full px-3.5 py-2.5 bg-gray-50 border border-gray-300 rounded-lg font-mono text-sm text-gray-900 select-all focus:outline-none"
                  />
                </div>
              </div>

              {/* Molfile (MDL V2000) Representation */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-gray-700 uppercase tracking-wider">
                    Molfile (MDL Molfile V2000)
                  </label>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => handleCopy(exportData.molfile, "molfile")}
                      className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1 cursor-pointer"
                    >
                      {copiedField === "molfile" ? "✓ Copied Molfile" : "📋 Copy Molfile"}
                    </button>
                    <button
                      onClick={handleDownloadMol}
                      className="text-xs text-emerald-600 hover:text-emerald-800 font-medium flex items-center gap-1 cursor-pointer"
                    >
                      💾 Download .mol
                    </button>
                  </div>
                </div>
                <pre className="bg-gray-900 text-emerald-400 p-4 rounded-lg font-mono text-xs overflow-x-auto max-h-56 overflow-y-auto leading-relaxed border border-gray-800 select-all">
                  {exportData.molfile}
                </pre>
              </div>
            </div>
          </div>
        )}

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
    </div>
  );
}