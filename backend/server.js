import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const AXIOS_TIMEOUT = 10000; // ms
const CACHE_DIR = path.resolve("./cache/pubchem_json"); // adjust if needed

app.get("/api/test", (req, res) => {
  res.json({ message: "Backend is running fine!" });
});

async function readCacheForCompound(name) {
  try {
    const safe = name.replace(/[^a-z0-9._-]/gi, "_").toLowerCase();
    const file = path.join(CACHE_DIR, `${safe}.json`);
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

app.post("/api/analyze", async (req, res) => {
  const { compound } = req.body;
  console.log("[/api/analyze] request body:", req.body);

  if (!compound) return res.status(400).json({ error: "No compound name provided" });

  try {
    const cidUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(
      compound
    )}/cids/JSON`;
    console.log("[/api/analyze] fetching CID from:", cidUrl);

    const cidResp = await axios.get(cidUrl, { timeout: AXIOS_TIMEOUT });
    console.log("[/api/analyze] cidResp.status:", cidResp.status);

    const cid = cidResp.data?.IdentifierList?.CID?.[0];
    if (!cid) return res.status(404).json({ error: "Compound not found" });

    const propsUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/property/MolecularFormula,MolecularWeight,IsomericSMILES/JSON`;
    console.log("[/api/analyze] fetching props from:", propsUrl);

    const propsResp = await axios.get(propsUrl, { timeout: AXIOS_TIMEOUT });
    console.log("[/api/analyze] propsResp.status:", propsResp.status);

    const props = propsResp.data?.PropertyTable?.Properties?.[0] || {};

    const payload = {
      source: "pubchem",
      compound,
      cid,
      molecularFormula: props.MolecularFormula,
      molecularWeight: props.MolecularWeight,
      isomericSmiles: props.IsomericSMILES,
    };

    try {
      const safe = compound.replace(/[^a-z0-9._-]/gi, "_").toLowerCase();
      const file = path.join(CACHE_DIR, `${safe}.json`);
      await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
    } catch {}

    return res.json(payload);
  } catch (err) {
    console.error("[/api/analyze] err.message:", err?.message);
    console.error("[/api/analyze] err.code:", err?.code);
    console.error("[/api/analyze] err.config?.url:", err?.config?.url);

    // Try cache fallback for network/timeouts/503
    if (err?.code === "ETIMEDOUT" || err?.code === "ECONNABORTED" || err?.response?.status === 503 || err?.response?.status === 429) {
      console.log("[/api/analyze] network timeout or rate limit — attempting cache fallback for:", compound);
      const cached = await readCacheForCompound(compound);
      if (cached) {
        console.log("[/api/analyze] served from cache for:", compound);
        return res.json({ source: "cache", ...cached });
      } else {
        console.log("[/api/analyze] no cache available for:", compound);
      }
    }

    if (err?.response?.status === 503 || err?.response?.status === 429) {
      return res.status(503).json({
        error: "PubChem service is temporarily busy (503). Please try again in a moment.",
        code: err?.code,
        upstreamStatus: err?.response?.status,
      });
    }


    if (err?.response) {
      console.error("[/api/analyze] upstream status:", err.response.status);
      try {
        console.error("[/api/analyze] upstream data (truncated):", JSON.stringify(err.response.data).slice(0, 2000));
      } catch {}
    }
    console.error("[/api/analyze] stack:", err?.stack);

    return res.status(500).json({
      error: "Failed to fetch compound data",
      details: err?.message,
      code: err?.code,
      url: err?.config?.url,
      upstreamStatus: err?.response?.status,
    });
  }
});

app.post("/api/identify", async (req, res) => {
  let { smiles, molfile } = req.body || {};
  console.log("[/api/identify] request body:", { smiles, molfileLen: molfile?.length });

  // 1. Resolve SMILES from molfile if needed
  if ((!smiles || typeof smiles !== "string" || !smiles.trim()) && molfile && typeof molfile === "string") {
    try {
      const OCL = (await import("openchemlib")).default;
      const mol = OCL.Molecule.fromMolfile(molfile);
      smiles = mol.toSmiles();
    } catch (molErr) {
      console.warn("[/api/identify] OCL molfile conversion error:", molErr?.message);
    }
  }

  // 2. Validate non-empty structure
  if (!smiles || typeof smiles !== "string" || !smiles.trim()) {
    return res.status(400).json({
      error: "No molecular structure provided. Please draw a molecule before identifying.",
    });
  }

  const trimmedSmiles = smiles.trim();

  try {
    // 3. Query PubChem PUG REST by SMILES using POST to handle special characters safely
    const cidUrl = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/smiles/cids/JSON";
    console.log("[/api/identify] fetching CID for SMILES:", trimmedSmiles);

    let cidResp;
    try {
      cidResp = await axios.post(
        cidUrl,
        new URLSearchParams({ smiles: trimmedSmiles }).toString(),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: AXIOS_TIMEOUT,
        }
      );
    } catch (postErr) {
      // Handle 400 (PubChem couldn't parse/standardize the structure)
      if (postErr.response?.status === 400) {
        return res.status(400).json({
          error: "Invalid or unparseable chemical structure.",
          details: postErr.response?.data?.Fault?.Message || "Standardization failed",
        });
      }
      // Handle 404 (Not found in PubChem)
      if (postErr.response?.status === 404 || postErr.response?.data?.Fault?.Code === "PUGREST.NotFound") {
        return res.status(404).json({
          error: "No matching compound found in PubChem for this structure.",
          found: false,
          smiles: trimmedSmiles,
        });
      }
      throw postErr;
    }

    const cids = cidResp.data?.IdentifierList?.CID || [];
    // If PubChem returns [0] or empty list, it means no match was found
    if (!cids.length || cids[0] === 0) {
      return res.status(404).json({
        error: "No matching compound found in PubChem for this structure.",
        found: false,
        smiles: trimmedSmiles,
      });
    }

    const cid = cids[0];
    const isAmbiguous = cids.length > 1;
    const allCids = isAmbiguous ? cids.slice(0, 5) : [cid];

    console.log(`[/api/identify] resolved CID: ${cid} (total matches: ${cids.length})`);

    // 4. Retrieve properties and synonyms concurrently
    const propsUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/property/Title,IUPACName,MolecularFormula,MolecularWeight,CanonicalSMILES,IsomericSMILES/JSON`;
    const synUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/synonyms/JSON`;

    const [propsSettled, synSettled] = await Promise.allSettled([
      axios.get(propsUrl, { timeout: AXIOS_TIMEOUT }),
      axios.get(synUrl, { timeout: AXIOS_TIMEOUT }),
    ]);

    const props = propsSettled.status === "fulfilled"
      ? propsSettled.value.data?.PropertyTable?.Properties?.[0] || {}
      : {};

    const synonyms = synSettled.status === "fulfilled"
      ? synSettled.value.data?.InformationList?.Information?.[0]?.Synonym || []
      : [];

    // Preferred common compound name: Title -> first synonym -> IUPAC name -> Unnamed
    const preferredName =
      props.Title ||
      (synonyms.length > 0 ? synonyms[0] : null) ||
      props.IUPACName ||
      `Compound CID ${cid}`;

    const result = {
      source: "pubchem",
      cid,
      name: preferredName,
      iupacName: props.IUPACName || null,
      molecularFormula: props.MolecularFormula || null,
      molecularWeight: props.MolecularWeight ? String(props.MolecularWeight) : null,
      canonicalSmiles: props.CanonicalSMILES || props.IsomericSMILES || trimmedSmiles,
      inputSmiles: trimmedSmiles,
      synonyms: synonyms.slice(0, 8),
      ambiguous: isAmbiguous,
      matchCount: cids.length,
      allCids,
    };

    // Cache the successful result
    try {
      const safe = `identify_${trimmedSmiles.replace(/[^a-z0-9._-]/gi, "_").toLowerCase()}`;
      const file = path.join(CACHE_DIR, `${safe}.json`);
      await fs.writeFile(file, JSON.stringify(result, null, 2), "utf8");
    } catch (cacheErr) {
      console.warn("[/api/identify] cache write error:", cacheErr?.message);
    }

    return res.json(result);
  } catch (err) {
    console.error("[/api/identify] error:", err?.message);

    // Timeout / Gateway error fallback
    if (err?.code === "ETIMEDOUT" || err?.code === "ECONNABORTED") {
      // Check cache first
      try {
        const safe = `identify_${trimmedSmiles.replace(/[^a-z0-9._-]/gi, "_").toLowerCase()}`;
        const file = path.join(CACHE_DIR, `${safe}.json`);
        const raw = await fs.readFile(file, "utf8");
        const cached = JSON.parse(raw);
        console.log("[/api/identify] served from cache for:", trimmedSmiles);
        return res.json({ source: "cache", ...cached });
      } catch {}

      return res.status(504).json({
        error: "PubChem service request timed out. Please try again shortly.",
        code: err?.code,
      });
    }

    if (err?.response?.status === 429 || err?.response?.status === 503) {
      return res.status(503).json({
        error: "PubChem service is temporarily busy (rate limited). Please wait a moment and try again.",
        status: err?.response?.status,
      });
    }

    return res.status(500).json({
      error: "Failed to identify structure",
      details: err?.message,
      code: err?.code,
    });
  }
});

app.listen(5000, () => console.log("Server running on http://localhost:5000"));