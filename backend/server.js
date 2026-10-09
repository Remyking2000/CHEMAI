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

    return res.json({
      source: "pubchem",
      compound,
      cid,
      molecularFormula: props.MolecularFormula,
      molecularWeight: props.MolecularWeight,
      isomericSmiles: props.IsomericSMILES,
    });
  } catch (err) {
    console.error("[/api/analyze] err.message:", err?.message);
    console.error("[/api/analyze] err.code:", err?.code);
    console.error("[/api/analyze] err.config?.url:", err?.config?.url);

    // Try cache fallback for network/timeouts
    if (err?.code === "ETIMEDOUT" || err?.code === "ECONNABORTED") {
      console.log("[/api/analyze] network timeout — attempting cache fallback for:", compound);
      const cached = await readCacheForCompound(compound);
      if (cached) {
        console.log("[/api/analyze] served from cache for:", compound);
        return res.json({ source: "cache", ...cached });
      } else {
        console.log("[/api/analyze] no cache available for:", compound);
      }
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

app.listen(5000, () => console.log("Server running on http://localhost:5000"));