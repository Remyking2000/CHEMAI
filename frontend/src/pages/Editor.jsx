import React, { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Editor } from "ketcher-react";
import { StandaloneStructServiceProvider } from "ketcher-standalone";
import OCL from "openchemlib";
import "ketcher-react/dist/index.css";

// Instantiate the standalone Indigo struct service provider once
const structServiceProvider = new StandaloneStructServiceProvider();

// Quick example templates to test and draw
const SAMPLE_STRUCTURES = [
  { name: "Benzene", smiles: "c1ccccc1" },
  { name: "Aspirin", smiles: "CC(=O)Oc1ccccc1C(=O)O" },
  { name: "Ethanol", smiles: "CCO" },
  { name: "Caffeine", smiles: "Cn1cnc2c1c(=O)n(c(=O)n2C)C" },
];

export default function MolecularEditor() {
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

  // Listen for canvas edits to clear stale identification results
  useEffect(() => {
    if (!ketcher) return;

    const handleCanvasChange = () => {
      // Clear stale identification results when user edits canvas, but not while actively loading
      if (identifyLoadingRef.current) return;
      setIdentifyResult(null);
      setIdentifyError(null);
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
      showStatus("Structure canvas cleared.");
    } catch (err) {
      console.error("Failed to clear structure:", err);
      try {
        await ketcher.setMolecule("");
        setExportData(null);
        setIdentifyResult(null);
        setIdentifyError(null);
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
      // Clear previous identification results
      setIdentifyResult(null);
      setIdentifyError(null);
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
                  onClick={() => setIdentifyResult(null)}
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