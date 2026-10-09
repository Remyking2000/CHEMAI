import React, { useState } from "react";

export default function Analyzer() {
  const [compound, setCompound] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const analyzeCompound = async () => {
    if (!compound.trim()) return alert("Enter a compound name first!");
    setLoading(true);
    setResult(null);

    try {
      const res = await fetch("http://localhost:5000/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ compound }),
      });

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = { error: "Invalid JSON from server", raw: text };
      }

      console.log("analyze response:", res.status, data);

      if (!res.ok) {
        setResult({ error: data?.error || data?.details || "Server returned an error" });
      } else {
        setResult(data);
      }
    } catch (err) {
      console.error("fetch error:", err);
      setResult({ error: err?.message || "Network error" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 p-6">
      <h1 className="text-3xl font-bold mb-6">ChemAI Compound Analyzer</h1>

      <div className="flex gap-3 mb-6">
        <input
          type="text"
          placeholder="Enter compound name (e.g. benzene)"
          value={compound}
          onChange={(e) => setCompound(e.target.value)}
          className="px-4 py-2 border rounded w-72"
        />
        <button
          onClick={analyzeCompound}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          {loading ? "Analyzing..." : "Analyze"}
        </button>
      </div>

      {result && (
        <div className="bg-white shadow p-6 rounded w-full max-w-md text-center">
          {result.error ? (
            <pre className="text-red-500">{result.error}{result.raw ? `\n\nraw: ${result.raw}` : ""}</pre>
          ) : (
            <>
              <p><strong>Compound:</strong> {result.compound}</p>
              <p><strong>Formula:</strong> {result.molecularFormula}</p>
              <p><strong>Weight:</strong> {result.molecularWeight}</p>
              <p><strong>SMILES:</strong> {result.isomericSmiles}</p>
              <p><strong>CID:</strong> {result.cid}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}