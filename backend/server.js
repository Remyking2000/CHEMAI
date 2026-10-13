import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import OCL from "openchemlib";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const AXIOS_TIMEOUT = 10000; // ms
const GEMINI_TIMEOUT = 25000; // ms
const CACHE_DIR = path.resolve("./cache/pubchem_json");

const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const DEFAULT_OPENROUTER_MODEL = "liquid/lfm-2.5-2.6b:free";

/**
 * Safely read AI configuration (OpenRouter or Gemini) from environment variables.
 * Never logs or exposes API keys.
 */
function getAIConfig() {
  const openRouterKey = typeof process.env.OPENROUTER_API_KEY === "string" ? process.env.OPENROUTER_API_KEY.trim() : "";
  const isOpenRouterConfigured =
    Boolean(openRouterKey) &&
    !openRouterKey.startsWith("your_") &&
    openRouterKey !== "YOUR_OPENROUTER_API_KEY";

  const geminiKey = typeof process.env.GEMINI_API_KEY === "string" ? process.env.GEMINI_API_KEY.trim() : "";
  const isGeminiConfigured =
    Boolean(geminiKey) &&
    !geminiKey.startsWith("your_") &&
    geminiKey !== "YOUR_GEMINI_API_KEY";

  const requestedProvider = (process.env.AI_PROVIDER || "").toLowerCase().trim();
  let provider = "openrouter";
  if (requestedProvider === "gemini") {
    provider = "gemini";
  } else if (requestedProvider === "openrouter") {
    provider = "openrouter";
  } else {
    // Auto-detect: if openrouter is configured prefer it, else gemini
    provider = isOpenRouterConfigured ? "openrouter" : "gemini";
  }

  const openRouterModel = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
  const geminiModel = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;

  const isConfigured = provider === "openrouter" ? isOpenRouterConfigured : isGeminiConfigured;
  const activeModel = provider === "openrouter" ? openRouterModel : geminiModel;
  const activeKey = provider === "openrouter" ? (isOpenRouterConfigured ? openRouterKey : null) : (isGeminiConfigured ? geminiKey : null);

  return {
    provider,
    isConfigured,
    activeModel,
    activeKey,
    openRouter: {
      isConfigured: isOpenRouterConfigured,
      apiKey: isOpenRouterConfigured ? openRouterKey : null,
      model: openRouterModel,
    },
    gemini: {
      isConfigured: isGeminiConfigured,
      apiKey: isGeminiConfigured ? geminiKey : null,
      model: geminiModel,
    },
  };
}

/**
 * Strip any potential API keys from error messages before logging or returning.
 */
function sanitizeErrorMessage(msg) {
  if (!msg || typeof msg !== "string") return "Unknown service error";
  let cleaned = msg;
  const rawGemini = process.env.GEMINI_API_KEY;
  if (rawGemini && typeof rawGemini === "string" && rawGemini.trim().length > 4) {
    cleaned = cleaned.split(rawGemini.trim()).join("[REDACTED]");
  }
  const rawOpenRouter = process.env.OPENROUTER_API_KEY;
  if (rawOpenRouter && typeof rawOpenRouter === "string" && rawOpenRouter.trim().length > 4) {
    cleaned = cleaned.split(rawOpenRouter.trim()).join("[REDACTED]");
  }
  cleaned = cleaned.replace(/AIza[0-9A-Za-z\-_]{20,}/g, "[REDACTED_KEY]");
  cleaned = cleaned.replace(/sk-or-v1-[0-9a-zA-Z]{20,}/g, "[REDACTED_KEY]");
  return cleaned;
}

/**
 * Send request to OpenRouter API with automatic fallbacks and flexible schema
 */
async function callOpenRouter({
  apiKey,
  model,
  systemInstruction,
  schemaInstruction,
  prompt,
  timeoutMs,
  maxTokens = 3000,
  temperature = 0.1,
}) {
  const modelsToAttempt = [model];
  if (model !== "liquid/lfm-2.5-2.6b:free") {
    modelsToAttempt.push("liquid/lfm-2.5-2.6b:free");
  }
  if (!modelsToAttempt.includes("openrouter/free")) {
    modelsToAttempt.push("openrouter/free");
  }

  let lastError = null;
  const defaultSchema =
    "You must return a valid JSON object matching the requested schema with keys: whatItIs, formulaAndStructure, functionalGroups, bondingAndCharacteristics, whyItMatters, uncertaintyAndVerificationNote.";
  const finalSchema = schemaInstruction || defaultSchema;

  for (const candidateModel of modelsToAttempt) {
    try {
      const response = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: candidateModel,
          messages: [
            {
              role: "system",
              content: `${systemInstruction}\n\n${finalSchema}`,
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          response_format: { type: "json_object" },
          temperature,
          max_tokens: maxTokens,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:5173",
            "X-Title": "ChemAI",
          },
          timeout: timeoutMs,
        }
      );

      const choice = response.data?.choices?.[0];
      let rawText = choice?.message?.content?.trim() || "";

      // Fallback: If a reasoning model put the JSON draft inside its reasoning field
      if (!rawText && choice?.message?.reasoning) {
        const match = choice.message.reasoning.match(/\{[\s\S]*\}/);
        if (match) {
          rawText = match[0].trim();
        }
      }

      if (rawText) {
        return {
          text: rawText,
          model: response.data?.model || candidateModel,
        };
      }
    } catch (err) {
      lastError = err;
      console.warn(`[callOpenRouter] candidate model ${candidateModel} failed:`, err?.response?.data || err?.message);
    }
  }

  if (lastError) throw lastError;
  return { text: "", model };
}

/**
 * Send conversational multi-turn chat request to OpenRouter API
 */
async function callOpenRouterChat({
  apiKey,
  model,
  systemInstruction,
  messages,
  timeoutMs,
  maxTokens = 2048,
  temperature = 0.3,
}) {
  const modelsToAttempt = [model];
  if (!modelsToAttempt.includes("liquid/lfm-2.5-2.6b:free")) {
    modelsToAttempt.push("liquid/lfm-2.5-2.6b:free");
  }
  if (!modelsToAttempt.includes("openrouter/free")) {
    modelsToAttempt.push("openrouter/free");
  }

  const formattedMessages = [
    { role: "system", content: systemInstruction },
    ...messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
  ];

  let lastError = null;
  for (const candidateModel of modelsToAttempt) {
    try {
      const response = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: candidateModel,
          messages: formattedMessages,
          temperature,
          max_tokens: maxTokens,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:5173",
            "X-Title": "ChemAI",
          },
          timeout: timeoutMs,
        }
      );

      const choice = response.data?.choices?.[0];
      const rawText = choice?.message?.content?.trim() || "";
      if (rawText) {
        return {
          text: rawText,
          model: response.data?.model || candidateModel,
        };
      }
    } catch (err) {
      lastError = err;
      console.warn(
        `[callOpenRouterChat] candidate model ${candidateModel} failed:`,
        err?.response?.data || err?.message
      );
    }
  }

  if (lastError) throw lastError;
  return { text: "", model };
}

app.get("/api/test", (req, res) => {
  res.json({ message: "Backend is running fine!" });
});

async function readCacheForCompound(name) {
  try {
    const safe = name.replace(/[^a-z0-9._-]/gi, "_").toLowerCase();
    const file = path.join(CACHE_DIR, `${safe}.json`);
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readIdentifyCache(trimmedSmiles) {
  try {
    const safe = `identify_${trimmedSmiles.replace(/[^a-z0-9._-]/gi, "_").toLowerCase()}`;
    const file = path.join(CACHE_DIR, `${safe}.json`);
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeIdentifyCache(trimmedSmiles, result) {
  try {
    const safe = `identify_${trimmedSmiles.replace(/[^a-z0-9._-]/gi, "_").toLowerCase()}`;
    const file = path.join(CACHE_DIR, `${safe}.json`);
    await fs.writeFile(file, JSON.stringify(result, null, 2), "utf8");
  } catch (cacheErr) {
    console.warn("[cache] identify cache write error:", cacheErr?.message);
  }
}

async function readExplainCache(cid, model) {
  try {
    const safeModel = model.replace(/[^a-z0-9._-]/gi, "_").toLowerCase();
    const file = path.join(CACHE_DIR, `explain_cid_${cid}_${safeModel}.json`);
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeExplainCache(cid, model, payload) {
  try {
    const safeModel = model.replace(/[^a-z0-9._-]/gi, "_").toLowerCase();
    const file = path.join(CACHE_DIR, `explain_cid_${cid}_${safeModel}.json`);
    await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
  } catch (cacheErr) {
    console.warn("[cache] explain cache write error:", cacheErr?.message);
  }
}

async function readLookupCache(type, query) {
  try {
    const safe = `lookup_${type}_${query.replace(/[^a-z0-9._-]/gi, "_").toLowerCase()}`;
    const file = path.join(CACHE_DIR, `${safe}.json`);
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeLookupCache(type, query, payload) {
  try {
    const safe = `lookup_${type}_${query.replace(/[^a-z0-9._-]/gi, "_").toLowerCase()}`;
    const file = path.join(CACHE_DIR, `${safe}.json`);
    await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
  } catch (cacheErr) {
    console.warn("[cache] lookup cache write error:", cacheErr?.message);
  }
}

async function readGenerationCache(query) {
  try {
    const safe = `gen_${query.replace(/[^a-z0-9._-]/gi, "_").toLowerCase()}`;
    const file = path.join(CACHE_DIR, `${safe}.json`);
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeGenerationCache(query, payload) {
  try {
    const safe = `gen_${query.replace(/[^a-z0-9._-]/gi, "_").toLowerCase()}`;
    const file = path.join(CACHE_DIR, `${safe}.json`);
    await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
  } catch (cacheErr) {
    console.warn("[cache] generation cache write error:", cacheErr?.message);
  }
}

async function readWikiCache(name) {
  try {
    const safe = `wiki_${name.replace(/[^a-z0-9._-]/gi, "_").toLowerCase()}`;
    const file = path.join(CACHE_DIR, `${safe}.json`);
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeWikiCache(name, payload) {
  try {
    const safe = `wiki_${name.replace(/[^a-z0-9._-]/gi, "_").toLowerCase()}`;
    const file = path.join(CACHE_DIR, `${safe}.json`);
    await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
  } catch (err) {
    console.warn("[cache] wiki cache write error:", err?.message);
  }
}

/**
 * Live external knowledge retrieval from Wikipedia REST API.
 * Retrieves encyclopedic summary, real-world context, description, and thumbnail image.
 */
async function fetchWikipediaSummary(name, synonyms = []) {
  if (!name || typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed) return null;

  const cached = await readWikiCache(trimmed);
  if (cached) return cached;

  const candidates = [trimmed, ...synonyms].filter(Boolean).slice(0, 5);

  // 1. Direct page summary attempt
  for (const candidate of candidates) {
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(candidate)}`;
      const resp = await axios.get(url, {
        headers: { "User-Agent": "ChemAI/1.0 (educational chemistry app; contact@chemai.local)" },
        timeout: 4000,
      });
      if (resp.data && (resp.data.type === "standard" || resp.data.extract)) {
        const payload = {
          title: resp.data.title,
          description: resp.data.description || null,
          extract: resp.data.extract,
          url:
            resp.data.content_urls?.desktop?.page ||
            `https://en.wikipedia.org/wiki/${encodeURIComponent(resp.data.title)}`,
          thumbnail: resp.data.thumbnail?.source || null,
        };
        await writeWikiCache(trimmed, payload);
        return payload;
      }
    } catch {}
  }

  // 2. Fallback: Search Wikipedia for "<name> chemical compound"
  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      trimmed + " chemical compound"
    )}&format=json`;
    const sResp = await axios.get(searchUrl, {
      headers: { "User-Agent": "ChemAI/1.0 (educational chemistry app)" },
      timeout: 4000,
    });
    const firstHit = sResp.data?.query?.search?.[0];
    if (firstHit?.title) {
      const pageUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(firstHit.title)}`;
      const pResp = await axios.get(pageUrl, {
        headers: { "User-Agent": "ChemAI/1.0 (educational chemistry app)" },
        timeout: 4000,
      });
      if (pResp.data?.extract) {
        const payload = {
          title: pResp.data.title,
          description: pResp.data.description || null,
          extract: pResp.data.extract,
          url:
            pResp.data.content_urls?.desktop?.page ||
            `https://en.wikipedia.org/wiki/${encodeURIComponent(pResp.data.title)}`,
          thumbnail: pResp.data.thumbnail?.source || null,
        };
        await writeWikiCache(trimmed, payload);
        return payload;
      }
    }
  } catch (err) {
    console.warn("[wikipedia] search fallback error:", err?.message);
  }

  return null;
}

/**
 * Shared helper to validate SMILES/Molfile and identify the compound via PubChem PUG REST.
 * Used by both POST /api/identify and POST /api/explain-structure.
 */
async function identifyStructureWithPubChem({ smiles, molfile, preferCache = false }) {
  let resolvedSmiles = smiles;

  // 1. Resolve SMILES from molfile if needed
  if (
    (!resolvedSmiles || typeof resolvedSmiles !== "string" || !resolvedSmiles.trim()) &&
    molfile &&
    typeof molfile === "string"
  ) {
    try {
      const OCL = (await import("openchemlib")).default;
      const mol = OCL.Molecule.fromMolfile(molfile);
      if (mol.getAllAtoms() > 0) {
        resolvedSmiles = mol.toSmiles();
      }
    } catch (molErr) {
      console.warn("[identifyHelper] OCL molfile conversion error:", molErr?.message);
    }
  }

  // 2. Validate non-empty structure
  if (!resolvedSmiles || typeof resolvedSmiles !== "string" || !resolvedSmiles.trim()) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "No molecular structure provided. Please draw a molecule before identifying.",
      },
    };
  }

  const trimmedSmiles = resolvedSmiles.trim();

  // Optional fast-path cache check when explaining an already-identified structure
  if (preferCache) {
    const cached = await readIdentifyCache(trimmedSmiles);
    if (cached && cached.cid) {
      return {
        ok: true,
        status: 200,
        data: { ...cached, source: "cache" },
      };
    }
  }

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
        return {
          ok: false,
          status: 400,
          body: {
            error: "Invalid or unparseable chemical structure.",
            details: postErr.response?.data?.Fault?.Message || "Standardization failed",
          },
        };
      }
      // Handle 404 (Not found in PubChem)
      if (
        postErr.response?.status === 404 ||
        postErr.response?.data?.Fault?.Code === "PUGREST.NotFound"
      ) {
        return {
          ok: false,
          status: 404,
          body: {
            error: "No matching compound found in PubChem for this structure.",
            found: false,
            smiles: trimmedSmiles,
          },
        };
      }
      throw postErr;
    }

    const cids = cidResp.data?.IdentifierList?.CID || [];
    // If PubChem returns [0] or empty list, it means no match was found
    if (!cids.length || cids[0] === 0) {
      return {
        ok: false,
        status: 404,
        body: {
          error: "No matching compound found in PubChem for this structure.",
          found: false,
          smiles: trimmedSmiles,
        },
      };
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

    const props =
      propsSettled.status === "fulfilled"
        ? propsSettled.value.data?.PropertyTable?.Properties?.[0] || {}
        : {};

    const synonyms =
      synSettled.status === "fulfilled"
        ? synSettled.value.data?.InformationList?.Information?.[0]?.Synonym || []
        : [];

    // Preferred common compound name: Title -> first synonym -> IUPAC name -> Unnamed
    const preferredName =
      props.Title ||
      (synonyms.length > 0 ? synonyms[0] : null) ||
      props.IUPACName ||
      `Compound CID ${cid}`;

    // Extract CAS Registry Number if present in synonyms
    const casPattern = /^\d{2,7}-\d{2}-\d$/;
    const casNumber = synonyms.find((s) => casPattern.test(s)) || null;

    // Retrieve real-world Wikipedia context
    let wikipedia = null;
    try {
      wikipedia = await fetchWikipediaSummary(preferredName, synonyms);
    } catch (wikiErr) {
      console.warn("[/api/identify] wikipedia fetch notice:", wikiErr?.message);
    }

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
      casNumber,
      wikipedia,
      ambiguous: isAmbiguous,
      matchCount: cids.length,
      allCids,
    };

    await writeIdentifyCache(trimmedSmiles, result);

    return {
      ok: true,
      status: 200,
      data: result,
    };
  } catch (err) {
    console.error("[/api/identify] error:", err?.message);

    // Timeout / Rate limit fallback to local cache if available
    if (
      err?.code === "ETIMEDOUT" ||
      err?.code === "ECONNABORTED" ||
      err?.response?.status === 429 ||
      err?.response?.status === 503
    ) {
      const cached = await readIdentifyCache(trimmedSmiles);
      if (cached) {
        console.log("[/api/identify] served from cache for:", trimmedSmiles);
        return {
          ok: true,
          status: 200,
          data: { source: "cache", ...cached },
        };
      }
    }

    if (err?.code === "ETIMEDOUT" || err?.code === "ECONNABORTED") {
      return {
        ok: false,
        status: 504,
        body: {
          error: "PubChem service request timed out. Please try again shortly.",
          code: err?.code,
        },
      };
    }

    if (err?.response?.status === 429 || err?.response?.status === 503) {
      return {
        ok: false,
        status: 503,
        body: {
          error: "PubChem service is temporarily busy (rate limited). Please wait a moment and try again.",
          status: err?.response?.status,
        },
      };
    }

    return {
      ok: false,
      status: 500,
      body: {
        error: "Failed to identify structure",
        details: sanitizeErrorMessage(err?.message),
        code: err?.code,
      },
    };
  }
}

app.post("/api/analyze", async (req, res) => {
  const { compound } = req.body || {};
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
    if (
      err?.code === "ETIMEDOUT" ||
      err?.code === "ECONNABORTED" ||
      err?.response?.status === 503 ||
      err?.response?.status === 429
    ) {
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
        console.error(
          "[/api/analyze] upstream data (truncated):",
          JSON.stringify(err.response.data).slice(0, 2000)
        );
      } catch {}
    }

    return res.status(500).json({
      error: "Failed to fetch compound data",
      details: sanitizeErrorMessage(err?.message),
      code: err?.code,
      url: err?.config?.url,
      upstreamStatus: err?.response?.status,
    });
  }
});

app.post("/api/identify", async (req, res) => {
  const { smiles, molfile } = req.body || {};
  console.log("[/api/identify] request body:", { smiles, molfileLen: molfile?.length });

  const outcome = await identifyStructureWithPubChem({
    smiles,
    molfile,
    preferCache: false,
  });

  if (!outcome.ok) {
    return res.status(outcome.status).json(outcome.body);
  }

  return res.json(outcome.data);
});

/**
 * Real-time external encyclopedic knowledge endpoint (Wikipedia API).
 * Returns verified real-world context, commercial applications, description, and Wikipedia article link.
 */
app.get("/api/compound-knowledge", async (req, res) => {
  const { name } = req.query || {};
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Please provide a compound name query.", code: "EMPTY_QUERY" });
  }

  const queryName = name.trim();
  try {
    const wikiData = await fetchWikipediaSummary(queryName);
    return res.json({
      compound: queryName,
      wikipedia: wikiData,
      source: "wikipedia",
    });
  } catch (err) {
    console.error("[/api/compound-knowledge] error:", err?.message);
    return res.status(500).json({
      error: "Failed to fetch compound knowledge from Wikipedia.",
      details: sanitizeErrorMessage(err?.message),
    });
  }
});

/**
 * Reverse structure lookup by chemical formula using PubChem fastformula endpoint.
 * Returns up to 12 candidates sharing the formula.
 */
async function lookupByFormula(formula) {
  try {
    const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/fastformula/${encodeURIComponent(
      formula
    )}/property/Title,IUPACName,MolecularFormula,MolecularWeight,CanonicalSMILES,IsomericSMILES/JSON?MaxRecords=12`;

    const resp = await axios.get(url, { timeout: AXIOS_TIMEOUT });
    const properties = resp.data?.PropertyTable?.Properties || [];

    if (!properties.length) {
      return {
        ok: false,
        status: 404,
        body: {
          error: `No compounds found matching formula "${formula}" in PubChem.`,
          code: "NOT_FOUND",
          query: formula,
          queryType: "formula",
        },
      };
    }

    const candidates = properties
      .map((p) => {
        const smiles = p.CanonicalSMILES || p.IsomericSMILES || p.SMILES || "";
        return {
          cid: p.CID,
          name: p.Title || p.IUPACName || `Compound CID ${p.CID}`,
          iupacName: p.IUPACName || null,
          molecularFormula: p.MolecularFormula || formula,
          molecularWeight: p.MolecularWeight ? String(p.MolecularWeight) : null,
          smiles,
        };
      })
      .filter((c) => Boolean(c.smiles));

    if (!candidates.length) {
      return {
        ok: false,
        status: 404,
        body: {
          error: `No compounds with usable structural representations found for formula "${formula}".`,
          code: "NOT_FOUND",
          query: formula,
          queryType: "formula",
        },
      };
    }

    return {
      ok: true,
      status: 200,
      data: {
        source: "pubchem",
        query: formula,
        queryType: "formula",
        count: candidates.length,
        candidates,
      },
    };
  } catch (err) {
    if (err.response?.status === 404) {
      return {
        ok: false,
        status: 404,
        body: {
          error: `No compounds found matching formula "${formula}" in PubChem.`,
          code: "NOT_FOUND",
          query: formula,
          queryType: "formula",
        },
      };
    }

    if (err.response?.status === 500 || err.response?.status === 400) {
      return {
        ok: false,
        status: 400,
        body: {
          error: `Invalid chemical formula format: "${formula}".`,
          details: "Please check your formula syntax (e.g., C2H6O, C6H6, H2O, NaCl).",
          code: "INVALID_FORMULA",
          query: formula,
          queryType: "formula",
        },
      };
    }

    if (err.code === "ETIMEDOUT" || err.code === "ECONNABORTED") {
      return {
        ok: false,
        status: 504,
        body: {
          error: "PubChem service request timed out while searching formula. Please try again.",
          code: "PUBCHEM_TIMEOUT",
        },
      };
    }

    if (err.response?.status === 503 || err.response?.status === 429) {
      return {
        ok: false,
        status: 503,
        body: {
          error: "PubChem service is temporarily busy (rate limited). Please try again shortly.",
          code: "PUBCHEM_RATE_LIMIT",
        },
      };
    }

    return {
      ok: false,
      status: 500,
      body: {
        error: "Failed to search formula in PubChem.",
        details: sanitizeErrorMessage(err?.message),
        code: "PUBCHEM_ERROR",
      },
    };
  }
}

/**
 * Reverse structure lookup by chemical compound name using PubChem name and CID properties.
 */
async function lookupByName(name) {
  try {
    const cidUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(
      name
    )}/cids/JSON`;

    const cidResp = await axios.get(cidUrl, { timeout: AXIOS_TIMEOUT });
    const cids = cidResp.data?.IdentifierList?.CID || [];

    if (!cids.length || cids[0] === 0) {
      return {
        ok: false,
        status: 404,
        body: {
          error: `No compounds found matching name "${name}" in PubChem.`,
          code: "NOT_FOUND",
          query: name,
          queryType: "name",
        },
      };
    }

    const targetCids = cids.slice(0, 10);
    const propsUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${targetCids.join(
      ","
    )}/property/Title,IUPACName,MolecularFormula,MolecularWeight,CanonicalSMILES,IsomericSMILES/JSON`;

    const propsResp = await axios.get(propsUrl, { timeout: AXIOS_TIMEOUT });
    const properties = propsResp.data?.PropertyTable?.Properties || [];

    const candidates = properties
      .map((p) => {
        const smiles = p.CanonicalSMILES || p.IsomericSMILES || p.SMILES || "";
        return {
          cid: p.CID,
          name: p.Title || p.IUPACName || name,
          iupacName: p.IUPACName || null,
          molecularFormula: p.MolecularFormula || null,
          molecularWeight: p.MolecularWeight ? String(p.MolecularWeight) : null,
          smiles,
        };
      })
      .filter((c) => Boolean(c.smiles));

    if (!candidates.length) {
      return {
        ok: false,
        status: 404,
        body: {
          error: `No compounds with usable structural representations found for name "${name}".`,
          code: "NOT_FOUND",
          query: name,
          queryType: "name",
        },
      };
    }

    return {
      ok: true,
      status: 200,
      data: {
        source: "pubchem",
        query: name,
        queryType: "name",
        count: candidates.length,
        candidates,
      },
    };
  } catch (err) {
    if (err.response?.status === 404) {
      return {
        ok: false,
        status: 404,
        body: {
          error: `No compounds found matching name "${name}" in PubChem.`,
          code: "NOT_FOUND",
          query: name,
          queryType: "name",
        },
      };
    }

    if (err.code === "ETIMEDOUT" || err.code === "ECONNABORTED") {
      return {
        ok: false,
        status: 504,
        body: {
          error: "PubChem service request timed out while searching compound name. Please try again.",
          code: "PUBCHEM_TIMEOUT",
        },
      };
    }

    if (err.response?.status === 503 || err.response?.status === 429) {
      return {
        ok: false,
        status: 503,
        body: {
          error: "PubChem service is temporarily busy (rate limited). Please try again shortly.",
          code: "PUBCHEM_RATE_LIMIT",
        },
      };
    }

    return {
      ok: false,
      status: 500,
      body: {
        error: "Failed to search compound name in PubChem.",
        details: sanitizeErrorMessage(err?.message),
        code: "PUBCHEM_ERROR",
      },
    };
  }
}

/**
 * Phase 3A: Reverse Structure Lookup Endpoint
 * Supports search by compound name or molecular formula.
 */
app.post("/api/lookup-structure", async (req, res) => {
  const { query, type = "auto" } = req.body || {};

  if (!query || typeof query !== "string" || !query.trim()) {
    return res.status(400).json({
      error: "Please provide a compound name or molecular formula.",
      code: "EMPTY_QUERY",
    });
  }

  const trimmedQuery = query.trim();
  console.log(`[/api/lookup-structure] query="${trimmedQuery}", type="${type}"`);

  // Detect whether query looks like a molecular formula
  // Basic Hill system / chemical formula pattern: e.g. C2H6O, H2O, C6H6, NaCl, CH4
  const formulaRegex = /^(?:[A-Z][a-z]?\d*)+$/;
  const isLikelyFormula = formulaRegex.test(trimmedQuery);

  let searchType = type;
  if (searchType === "auto") {
    searchType = isLikelyFormula ? "formula" : "name";
  }

  try {
    // 1. Check lookup cache
    const cached = await readLookupCache(searchType, trimmedQuery);
    if (cached) {
      console.log(`[/api/lookup-structure] served from cache for ${searchType}: ${trimmedQuery}`);
      return res.json({ source: "cache", ...cached });
    }

    if (searchType === "formula") {
      const result = await lookupByFormula(trimmedQuery);
      if (result.ok) {
        await writeLookupCache("formula", trimmedQuery, result.data);
        return res.json(result.data);
      }

      // If auto-detect tried formula but got 404, fallback to name
      if (type === "auto" && result.status === 404) {
        console.log(`[/api/lookup-structure] formula lookup returned 404 for "${trimmedQuery}", trying name fallback...`);
        const nameFallback = await lookupByName(trimmedQuery);
        if (nameFallback.ok) {
          await writeLookupCache("name", trimmedQuery, nameFallback.data);
          return res.json(nameFallback.data);
        }
      }

      return res.status(result.status).json(result.body);
    } else {
      // Name lookup
      const result = await lookupByName(trimmedQuery);
      if (result.ok) {
        await writeLookupCache("name", trimmedQuery, result.data);
        return res.json(result.data);
      }

      // If auto-detect tried name but got 404 and pattern looks like formula, fallback to formula
      if (type === "auto" && result.status === 404 && isLikelyFormula) {
        console.log(`[/api/lookup-structure] name lookup returned 404 for "${trimmedQuery}", trying formula fallback...`);
        const formulaFallback = await lookupByFormula(trimmedQuery);
        if (formulaFallback.ok) {
          await writeLookupCache("formula", trimmedQuery, formulaFallback.data);
          return res.json(formulaFallback.data);
        }
      }

      return res.status(result.status).json(result.body);
    }
  } catch (err) {
    console.error("[/api/lookup-structure] unexpected error:", err);
    return res.status(500).json({
      error: "Unexpected server error during structure lookup.",
      details: sanitizeErrorMessage(err?.message),
    });
  }
});

const GENERATION_SYSTEM_INSTRUCTION = `You are the CHEMAI Chemical Structure Assistant.
Your task is to propose ONE plausible, chemically valid molecular structure representation (SMILES) for a given compound name or molecular formula that could not be found in PubChem.

STRICT ACCURACY & HONESTY GUIDELINES:
1. Provide a single representative chemical candidate for the user's input.
2. Return a syntactically valid SMILES string that can be parsed into a molecular graph.
3. If the input is a molecular formula, remember that many constitutional and stereoisomers exist. Propose ONE representative isomer, and clearly state in reasoningSummary and uncertaintyNote that this is one of several possible isomers.
4. CRITICAL: Do NOT invent PubChem CIDs, fictional CAS registry numbers, fake citations, experimental laboratory data, or claims of official verification.
5. Do NOT claim the structure is verified or unique unless proven. State clearly that this is an AI-generated structural hypothesis.
6. Keep reasoningSummary under 35 words. Keep uncertaintyNote under 30 words.
7. Return ONLY a valid JSON object matching the requested schema. No Markdown codeblocks, no text before or after.`;

const GENERATION_SCHEMA_INSTRUCTION = `You must return a valid JSON object with EXACTLY the following keys:
- "input": string (the exact requested user input)
- "proposedName": string (the common or IUPAC chemical name of the proposed structure)
- "smiles": string (a syntactically valid SMILES string)
- "molecularFormula": string (the proposed molecular formula, e.g. C7H15NO2)
- "reasoningSummary": string (concise explanation of why this structure matches the input)
- "uncertaintyNote": string (explicit note regarding isomerism, tautomers, or unverified hypothesis status)`;

const GENERATION_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    input: { type: Type.STRING },
    proposedName: { type: Type.STRING },
    smiles: { type: Type.STRING },
    molecularFormula: { type: Type.STRING },
    reasoningSummary: { type: Type.STRING },
    uncertaintyNote: { type: Type.STRING },
  },
  required: [
    "input",
    "proposedName",
    "smiles",
    "reasoningSummary",
    "uncertaintyNote",
  ],
};

/**
 * Phase 3B: AI-Assisted Structure Generation Endpoint
 * Generates a plausible chemical structure hypothesis using OpenRouter (or Gemini fallback)
 * when PubChem does not index the compound.
 */
app.post("/api/generate-structure", async (req, res) => {
  const { query } = req.body || {};

  if (!query || typeof query !== "string" || !query.trim()) {
    return res.status(400).json({
      error: "Please provide a chemical name or molecular formula to generate a structure.",
      code: "EMPTY_QUERY",
    });
  }

  const trimmedQuery = query.trim();
  if (trimmedQuery.length > 150) {
    return res.status(400).json({
      error: "Query exceeds maximum permitted length of 150 characters.",
      code: "QUERY_TOO_LONG",
    });
  }

  console.log(`[/api/generate-structure] request for query="${trimmedQuery}"`);

  // 1. Check AI configuration securely
  const aiConfig = getAIConfig();
  if (!aiConfig.isConfigured) {
    console.warn(`[/api/generate-structure] ${aiConfig.provider} API key is not configured.`);
    return res.status(503).json({
      error: `${aiConfig.provider === "openrouter" ? "OpenRouter" : "Gemini"} API key is not configured on the backend server.`,
      details: `Add a valid ${aiConfig.provider === "openrouter" ? "OPENROUTER_API_KEY" : "GEMINI_API_KEY"} to backend/.env and restart the backend server.`,
      code: "AI_CONFIG_MISSING",
      configError: true,
    });
  }

  // 2. Check cache
  const cached = await readGenerationCache(trimmedQuery);
  if (cached && cached.candidate) {
    console.log(`[/api/generate-structure] served from cache for "${trimmedQuery}"`);
    return res.json({ source: `${aiConfig.provider}-cache`, ...cached });
  }

  // 3. Build prompt
  const prompt = `Propose a single plausible molecular structure representation for the chemical name or formula: "${trimmedQuery}".
Return ONLY the requested JSON object containing input, proposedName, smiles, molecularFormula, reasoningSummary, uncertaintyNote.`;

  try {
    let rawText = "";
    let usedModel = aiConfig.activeModel;

    if (aiConfig.provider === "openrouter") {
      const openRouterResult = await callOpenRouter({
        apiKey: aiConfig.activeKey,
        model: aiConfig.activeModel,
        systemInstruction: GENERATION_SYSTEM_INSTRUCTION,
        schemaInstruction: GENERATION_SCHEMA_INSTRUCTION,
        prompt,
        timeoutMs: GEMINI_TIMEOUT,
        maxTokens: 2500,
        temperature: 0.1,
      });
      rawText = openRouterResult.text;
      usedModel = openRouterResult.model;
    } else {
      const ai = new GoogleGenAI({ apiKey: aiConfig.activeKey });

      let timeoutHandle;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const err = new Error("Gemini API request timed out");
          err.code = "ETIMEDOUT";
          reject(err);
        }, GEMINI_TIMEOUT);
      });

      const generationPromise = ai.models.generateContent({
        model: aiConfig.activeModel,
        contents: prompt,
        config: {
          systemInstruction: GENERATION_SYSTEM_INSTRUCTION,
          temperature: 0.2,
          maxOutputTokens: 1024,
          responseMimeType: "application/json",
          responseSchema: GENERATION_RESPONSE_SCHEMA,
        },
      });

      const response = await Promise.race([generationPromise, timeoutPromise]);
      clearTimeout(timeoutHandle);
      rawText = response?.text ? response.text.trim() : "";
    }

    if (!rawText) {
      return res.status(502).json({
        error: "AI service returned an empty response. Please try again.",
        code: "EMPTY_MODEL_RESPONSE",
      });
    }

    // 4. Parse JSON safely
    let parsed = null;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      const cleanedJson = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      try {
        parsed = JSON.parse(cleanedJson);
      } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            parsed = JSON.parse(jsonMatch[0]);
          } catch {
            parsed = null;
          }
        }
      }
    }

    if (!parsed || !parsed.smiles || typeof parsed.smiles !== "string" || !parsed.smiles.trim()) {
      console.warn("[/api/generate-structure] malformed output:", rawText.slice(0, 300));
      return res.status(502).json({
        error: "AI model did not return a parseable JSON response with a structure SMILES.",
        details: "The model output could not be parsed into the required schema.",
        code: "AI_MALFORMED_RESPONSE",
      });
    }

    const proposedSmiles = parsed.smiles.trim();

    // 5. Validate SMILES using OpenChemLib on backend
    let atomCount = 0;
    let calculatedFormula = null;
    let calculatedMw = null;
    let canonicalSmiles = proposedSmiles;

    try {
      const mol = OCL.Molecule.fromSmiles(proposedSmiles);
      atomCount = mol.getAllAtoms();
      if (atomCount === 0) {
        throw new Error("Molecule contains 0 atoms.");
      }
      const mf = mol.getMolecularFormula();
      calculatedFormula = mf.formula;
      calculatedMw = mf.absoluteWeight ? mf.absoluteWeight.toFixed(2) : null;
      canonicalSmiles = mol.toSmiles() || proposedSmiles;
    } catch (oclErr) {
      console.warn("[/api/generate-structure] OpenChemLib parse error on generated SMILES:", oclErr?.message);
      return res.status(422).json({
        error: "AI proposed an unparseable molecular structure (invalid SMILES syntax).",
        details: sanitizeErrorMessage(oclErr?.message || "Invalid SMILES"),
        code: "AI_INVALID_SMILES",
        proposedSmiles,
        proposedName: parsed.proposedName || trimmedQuery,
      });
    }

    // 6. Optional PubChem check for extra context
    let pubchemVerification = {
      checked: true,
      matched: false,
      note: "Hypothesis not independently verified in PubChem",
    };
    try {
      const checkOutcome = await identifyStructureWithPubChem({
        smiles: canonicalSmiles,
        preferCache: true,
      });
      if (checkOutcome.ok && checkOutcome.data?.cid) {
        pubchemVerification = {
          checked: true,
          matched: true,
          cid: checkOutcome.data.cid,
          pubchemName: checkOutcome.data.name,
          note: `Matched existing PubChem entry: ${checkOutcome.data.name} (CID ${checkOutcome.data.cid})`,
        };
      }
    } catch (checkErr) {
      console.log("[/api/generate-structure] optional PubChem verification check skipped/failed:", checkErr?.message);
    }

    const payload = {
      source: aiConfig.provider,
      model: usedModel,
      isAiGenerated: true,
      verified: Boolean(pubchemVerification.matched),
      candidate: {
        input: trimmedQuery,
        proposedName: parsed.proposedName || trimmedQuery,
        smiles: canonicalSmiles,
        originalSmiles: proposedSmiles,
        molecularFormula: calculatedFormula || parsed.molecularFormula || null,
        molecularWeight: calculatedMw,
        atomCount,
        reasoningSummary: parsed.reasoningSummary || "AI-generated molecular structure hypothesis.",
        uncertaintyNote:
          parsed.uncertaintyNote ||
          "This structure is an unverified hypothesis and may represent one of multiple constitutional isomers.",
        pubchemVerification,
      },
      disclaimer:
        "AI-generated molecular hypothesis — not independently verified. Verify against chemical literature before use.",
      generatedAt: new Date().toISOString(),
    };

    await writeGenerationCache(trimmedQuery, payload);

    return res.json(payload);
  } catch (err) {
    const errorData = err?.response?.data?.error;
    const rawErrorMsg = typeof errorData === "string" ? errorData : errorData?.message || err?.message;
    const safeMsg = sanitizeErrorMessage(rawErrorMsg);
    const status = err?.status || err?.response?.status;

    console.error(`[/api/generate-structure] ${aiConfig.provider} error:`, {
      status,
      code: err?.code,
      message: safeMsg,
    });

    if (err?.code === "ETIMEDOUT" || err?.name === "AbortError" || err?.code === "ECONNABORTED") {
      return res.status(504).json({
        error: `The ${aiConfig.provider === "openrouter" ? "OpenRouter" : "Gemini"} structure generation request timed out. Please try again.`,
        code: "AI_TIMEOUT",
      });
    }

    if (
      status === 402 ||
      safeMsg.toLowerCase().includes("prepayment") ||
      safeMsg.toLowerCase().includes("credits") ||
      safeMsg.toLowerCase().includes("balance")
    ) {
      return res.status(402).json({
        error: `${aiConfig.provider === "openrouter" ? "OpenRouter" : "Gemini"} credits or balance depleted.`,
        details: safeMsg,
        code: "AI_CREDITS_DEPLETED",
        configError: true,
      });
    }

    if (
      status === 429 ||
      safeMsg.toLowerCase().includes("quota") ||
      safeMsg.toLowerCase().includes("rate limit") ||
      safeMsg.toLowerCase().includes("resource_exhausted")
    ) {
      return res.status(429).json({
        error: `${aiConfig.provider === "openrouter" ? "OpenRouter" : "Gemini"} rate limit reached. Please wait a moment before requesting another generation.`,
        details: safeMsg,
        code: "AI_RATE_LIMIT",
      });
    }

    if (
      status === 400 ||
      status === 401 ||
      status === 403 ||
      safeMsg.toLowerCase().includes("api_key_invalid") ||
      safeMsg.toLowerCase().includes("api key not valid") ||
      safeMsg.toLowerCase().includes("unauthorized")
    ) {
      return res.status(503).json({
        error: `${aiConfig.provider === "openrouter" ? "OpenRouter" : "Gemini"} authentication or configuration error.`,
        details: `Please verify that your ${aiConfig.provider === "openrouter" ? "OPENROUTER_API_KEY" : "GEMINI_API_KEY"} in backend/.env is valid and active. (${safeMsg})`,
        code: "AI_AUTH_ERROR",
        configError: true,
      });
    }

    return res.status(502).json({
      error: `Unable to generate structure with ${aiConfig.provider === "openrouter" ? "OpenRouter" : "Gemini"} at this time.`,
      details: safeMsg,
      code: "AI_UPSTREAM_ERROR",
    });
  }
});

const EXPLANATION_SYSTEM_INSTRUCTION = `You are the CHEMAI Educational Chemistry Assistant.
Your task is to provide a clear, accurate, beginner-friendly chemistry explanation of a verified molecular structure.

STRICT GUIDELINES:
1. Rely strictly on the server-verified PubChem reference data provided in the prompt for compound identity, molecular formula, molecular weight, and IUPAC name.
2. Never invent or guess experimental physical constants (e.g., melting/boiling points, pKa, density), literature citations, chemical reactions, synthesis pathways, biological toxicity, or safety classifications.
3. Only identify functional groups and bonding features that are genuinely present in the provided SMILES and structure. If a compound is a simple hydrocarbon without heteroatom functional groups (such as benzene, c1ccccc1), explicitly state that it is an aromatic hydrocarbon ring with no oxygen/nitrogen/halogen functional groups rather than inventing any.
4. Clearly distinguish established structural facts from educational chemical interpretations.
5. If any structural feature or interpretation is uncertain or ambiguous, explicitly state that uncertainty.`;

const EXPLANATION_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    whatItIs: {
      type: Type.STRING,
      description:
        "Concise overview of what the compound is, its chemical class, and its general context based on verified identity.",
    },
    formulaAndStructure: {
      type: Type.STRING,
      description:
        "Explanation of its molecular formula, atom composition, and basic structural architecture (rings, chains, connectivity).",
    },
    functionalGroups: {
      type: Type.STRING,
      description:
        "Identification of functional groups present in the molecule and their chemical roles (or explicit note if only hydrocarbon framework is present).",
    },
    bondingAndCharacteristics: {
      type: Type.STRING,
      description:
        "Description of relevant bonding or structural characteristics (e.g., single/double/triple bonds, aromaticity, conjugation, planarity, or polarity).",
    },
    whyItMatters: {
      type: Type.STRING,
      description:
        "Beginner-friendly explanation of why these structural features and functional groups matter for understanding how the molecule behaves.",
    },
    uncertaintyAndVerificationNote: {
      type: Type.STRING,
      description:
        "Clear note distinguishing verified PubChem reference facts from AI-generated structural interpretations that should be verified with standard chemistry textbooks or references.",
    },
  },
  required: [
    "whatItIs",
    "formulaAndStructure",
    "functionalGroups",
    "bondingAndCharacteristics",
    "whyItMatters",
    "uncertaintyAndVerificationNote",
  ],
};

app.post("/api/explain-structure", async (req, res) => {
  const { smiles, molfile } = req.body || {};
  console.log("[/api/explain-structure] request received:", {
    smiles: typeof smiles === "string" ? smiles.slice(0, 120) : undefined,
    hasMolfile: Boolean(molfile),
  });

  // 1. Validate non-empty input
  if (
    (!smiles || typeof smiles !== "string" || !smiles.trim()) &&
    (!molfile || typeof molfile !== "string" || !molfile.trim())
  ) {
    return res.status(400).json({
      error: "A non-empty molecular SMILES string is required to explain a structure.",
      code: "EMPTY_STRUCTURE",
    });
  }

  // 2. Establish compound identity and trusted reference properties on the server via PubChem
  const identified = await identifyStructureWithPubChem({
    smiles,
    molfile,
    preferCache: true,
  });

  if (!identified.ok) {
    if (identified.status === 404) {
      return res.status(404).json({
        error:
          "This structure could not be matched to a known compound in PubChem. Phase 2 supports chemistry explanations for identified compounds only.",
        details:
          "CHEMAI does not fabricate compound identities or guess properties for unverified structures.",
        found: false,
        code: "UNIDENTIFIED_COMPOUND",
        smiles: identified.body?.smiles || (typeof smiles === "string" ? smiles.trim() : ""),
      });
    }
    return res.status(identified.status).json(identified.body);
  }

  const compound = identified.data;
  const referenceData = {
    source: "PubChem PUG REST (Verified Reference)",
    cid: compound.cid,
    name: compound.name,
    iupacName: compound.iupacName,
    molecularFormula: compound.molecularFormula,
    molecularWeight: compound.molecularWeight,
    canonicalSmiles: compound.canonicalSmiles,
    inputSmiles: compound.inputSmiles,
    synonyms: (compound.synonyms || []).slice(0, 6),
    casNumber: compound.casNumber || null,
    wikipedia: compound.wikipedia || null,
  };

  // 3. Check AI configuration securely
  const aiConfig = getAIConfig();
  if (!aiConfig.isConfigured) {
    console.warn(`[/api/explain-structure] ${aiConfig.provider} API key is not configured.`);
    return res.status(503).json({
      error: `${aiConfig.provider === "openrouter" ? "OpenRouter" : "Gemini"} API key is not configured on the backend server.`,
      details:
        `Add a valid ${aiConfig.provider === "openrouter" ? "OPENROUTER_API_KEY" : "GEMINI_API_KEY"} to backend/.env (see backend/.env.example) and restart the backend server.`,
      code: "AI_CONFIG_MISSING",
      configError: true,
      referenceData,
    });
  }

function stringifyExplanationField(val, fallback = "") {
  if (val === undefined || val === null) return fallback;
  if (typeof val === "string") return val.trim();
  if (Array.isArray(val)) {
    return val
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          if (item.name && item.description) return `${item.name}: ${item.description}`;
          if (item.name) return item.name;
          return Object.entries(item).map(([k, v]) => `${k}: ${v}`).join("\n");
        }
        return String(item);
      })
      .join("\n\n");
  }
  if (typeof val === "object") {
    return Object.entries(val).map(([k, v]) => `${k}: ${v}`).join("\n\n");
  }
  return String(val);
}

  // 4. Check explanation cache
  const cacheKey = `${aiConfig.provider}_${aiConfig.activeModel}`;
  const cachedExplanation = await readExplainCache(compound.cid, cacheKey);
  if (cachedExplanation && cachedExplanation.explanation) {
    console.log(
      `[/api/explain-structure] served cached explanation for CID ${compound.cid} (${compound.name}) via ${aiConfig.provider}`
    );
    const normalizedExplanation = {
      whatItIs: stringifyExplanationField(cachedExplanation.explanation.whatItIs),
      formulaAndStructure: stringifyExplanationField(cachedExplanation.explanation.formulaAndStructure),
      functionalGroups: stringifyExplanationField(cachedExplanation.explanation.functionalGroups),
      bondingAndCharacteristics: stringifyExplanationField(cachedExplanation.explanation.bondingAndCharacteristics),
      whyItMatters: stringifyExplanationField(cachedExplanation.explanation.whyItMatters),
      uncertaintyAndVerificationNote: stringifyExplanationField(
        cachedExplanation.explanation.uncertaintyAndVerificationNote,
        "AI-generated chemical interpretations are for educational guidance and should be verified independently."
      ),
    };
    return res.json({
      ...cachedExplanation,
      explanation: normalizedExplanation,
      source: `${aiConfig.provider}-cache`,
      referenceData,
    });
  }

  // 5. Build prompt using strictly server-derived PubChem reference properties and verified Wikipedia knowledge
  const casLine = referenceData.casNumber ? `\n- CAS Registry Number: ${referenceData.casNumber}` : "";
  const wikiLine = referenceData.wikipedia?.extract
    ? `\n- Real-World Knowledge & Uses (Wikipedia): ${referenceData.wikipedia.extract.slice(0, 350)}`
    : "";

  const prompt = `Explain the following verified chemical compound for a chemistry student:

VERIFIED PUBCHEM & ENCYCLOPEDIC REFERENCE DATA (Server-Derived):
- Preferred Name: ${referenceData.name}
- PubChem CID: ${referenceData.cid}${casLine}
- IUPAC Name: ${referenceData.iupACName || referenceData.iupacName || "Not listed"}
- Molecular Formula: ${referenceData.molecularFormula || "Not listed"}
- Molecular Weight: ${referenceData.molecularWeight ? `${referenceData.molecularWeight} g/mol` : "Not listed"}
- Canonical SMILES: ${referenceData.canonicalSmiles}
- Submitted SMILES: ${referenceData.inputSmiles}
- Common Synonyms: ${referenceData.synonyms.length > 0 ? referenceData.synonyms.join(", ") : "None listed"}${wikiLine}

Provide a concise, accurate educational explanation covering:
1. What the compound is (whatItIs).
2. Its molecular formula and basic structural features (formulaAndStructure).
3. Functional groups present in this structure and their roles — do not invent groups that are absent (functionalGroups).
4. Relevant bonding or structural characteristics such as rings, conjugation, aromaticity, or bond types (bondingAndCharacteristics).
5. A beginner-friendly explanation of why these structural features matter, including real-world applications (whyItMatters).
6. A note distinguishing the verified PubChem & encyclopedic facts above from AI chemical interpretation and noting any uncertainties (uncertaintyAndVerificationNote).`;

  try {
    let rawText = "";
    let usedModel = aiConfig.activeModel;

    if (aiConfig.provider === "openrouter") {
      const openRouterResult = await callOpenRouter({
        apiKey: aiConfig.activeKey,
        model: aiConfig.activeModel,
        systemInstruction: EXPLANATION_SYSTEM_INSTRUCTION,
        prompt,
        timeoutMs: GEMINI_TIMEOUT,
      });
      rawText = openRouterResult.text;
      usedModel = openRouterResult.model;
    } else {
      const ai = new GoogleGenAI({ apiKey: aiConfig.activeKey });

      let timeoutHandle;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const err = new Error("Gemini API request timed out");
          err.code = "ETIMEDOUT";
          reject(err);
        }, GEMINI_TIMEOUT);
      });

      const generationPromise = ai.models.generateContent({
        model: aiConfig.activeModel,
        contents: prompt,
        config: {
          systemInstruction: EXPLANATION_SYSTEM_INSTRUCTION,
          temperature: 0.2,
          maxOutputTokens: 1024,
          responseMimeType: "application/json",
          responseSchema: EXPLANATION_RESPONSE_SCHEMA,
        },
      });

      const response = await Promise.race([generationPromise, timeoutPromise]);
      clearTimeout(timeoutHandle);

      rawText = response?.text ? response.text.trim() : "";
    }

    if (!rawText) {
      return res.status(502).json({
        error: "AI service returned an empty explanation response. Please try again.",
        code: "EMPTY_MODEL_RESPONSE",
        referenceData,
      });
    }

    let parsedExplanation = null;
    try {
      parsedExplanation = JSON.parse(rawText);
    } catch {
      // Fallback if model returned markdown-fenced JSON or plain text
      const cleanedJson = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      try {
        parsedExplanation = JSON.parse(cleanedJson);
      } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            parsedExplanation = JSON.parse(jsonMatch[0]);
          } catch {
            parsedExplanation = null;
          }
        }
      }
    }

    if (!parsedExplanation) {
      parsedExplanation = {
        whatItIs: rawText,
        formulaAndStructure: `Molecular formula: ${referenceData.molecularFormula || "N/A"} (SMILES: ${referenceData.canonicalSmiles}).`,
        functionalGroups: "See overview above.",
        bondingAndCharacteristics: "See overview above.",
        whyItMatters: "See overview above.",
        uncertaintyAndVerificationNote:
          "AI-generated interpretation. Verify structural details against PubChem and standard chemistry references.",
      };
    }

    const payload = {
      source: aiConfig.provider,
      model: usedModel,
      referenceData,
      explanation: {
        whatItIs: stringifyExplanationField(parsedExplanation.whatItIs),
        formulaAndStructure: stringifyExplanationField(parsedExplanation.formulaAndStructure),
        functionalGroups: stringifyExplanationField(parsedExplanation.functionalGroups),
        bondingAndCharacteristics: stringifyExplanationField(parsedExplanation.bondingAndCharacteristics),
        whyItMatters: stringifyExplanationField(parsedExplanation.whyItMatters),
        uncertaintyAndVerificationNote: stringifyExplanationField(
          parsedExplanation.uncertaintyAndVerificationNote,
          "AI-generated chemical interpretations are for educational guidance and should be verified independently."
        ),
      },
      disclaimer: `Reference data (Compound Name, CID, IUPAC Name, Formula, Molecular Weight, and Canonical SMILES) is retrieved directly from PubChem. The structural walk-through and functional group explanations are generated by ${aiConfig.provider === "openrouter" ? "OpenRouter AI" : "Gemini AI"} and may require independent verification.`,
      generatedAt: new Date().toISOString(),
    };

    await writeExplainCache(compound.cid, cacheKey, payload);

    return res.json(payload);
  } catch (err) {
    const errorData = err?.response?.data?.error;
    const rawErrorMsg = typeof errorData === "string" ? errorData : errorData?.message || err?.message;
    const safeMsg = sanitizeErrorMessage(rawErrorMsg);
    const status = err?.status || err?.response?.status;
    console.error(`[/api/explain-structure] ${aiConfig.provider} error:`, {
      status,
      code: err?.code,
      message: safeMsg,
    });

    if (err?.code === "ETIMEDOUT" || err?.name === "AbortError" || err?.code === "ECONNABORTED") {
      return res.status(504).json({
        error: `The ${aiConfig.provider === "openrouter" ? "OpenRouter" : "Gemini"} explanation request timed out. Please try again shortly.`,
        code: "AI_TIMEOUT",
        referenceData,
      });
    }

    if (
      status === 402 ||
      safeMsg.toLowerCase().includes("prepayment") ||
      safeMsg.toLowerCase().includes("credits") ||
      safeMsg.toLowerCase().includes("balance")
    ) {
      return res.status(402).json({
        error: `${aiConfig.provider === "openrouter" ? "OpenRouter" : "Gemini"} credits or balance depleted.`,
        details: safeMsg,
        code: "AI_CREDITS_DEPLETED",
        configError: true,
        referenceData,
      });
    }

    if (
      status === 429 ||
      safeMsg.toLowerCase().includes("quota") ||
      safeMsg.toLowerCase().includes("rate limit") ||
      safeMsg.toLowerCase().includes("resource_exhausted")
    ) {
      return res.status(429).json({
        error: `${aiConfig.provider === "openrouter" ? "OpenRouter" : "Gemini"} rate limit reached. Please wait a moment before requesting another explanation.`,
        details: safeMsg,
        code: "AI_RATE_LIMIT",
        referenceData,
      });
    }

    if (
      status === 404 ||
      safeMsg.toLowerCase().includes("not_found") ||
      safeMsg.toLowerCase().includes("no longer available")
    ) {
      return res.status(503).json({
        error: `${aiConfig.provider === "openrouter" ? "OpenRouter" : "Gemini"} model is unavailable or not found.`,
        details: safeMsg,
        code: "AI_MODEL_UNAVAILABLE",
        configError: true,
        referenceData,
      });
    }

    if (
      status === 400 ||
      status === 401 ||
      status === 403 ||
      safeMsg.toLowerCase().includes("api_key_invalid") ||
      safeMsg.toLowerCase().includes("api key not valid") ||
      safeMsg.toLowerCase().includes("unauthorized")
    ) {
      return res.status(503).json({
        error: `${aiConfig.provider === "openrouter" ? "OpenRouter" : "Gemini"} authentication or configuration error.`,
        details: `Please verify that your ${aiConfig.provider === "openrouter" ? "OPENROUTER_API_KEY" : "GEMINI_API_KEY"} in backend/.env is valid and active. (${safeMsg})`,
        code: "AI_AUTH_ERROR",
        configError: true,
        referenceData,
      });
    }

    return res.status(502).json({
      error: `Unable to generate chemistry explanation from ${aiConfig.provider === "openrouter" ? "OpenRouter" : "Gemini"} at this time.`,
      details: safeMsg,
      code: "AI_UPSTREAM_ERROR",
      referenceData,
    });
  }
});

const CHAT_SYSTEM_INSTRUCTION = `You are ChemAI, an expert, encouraging, and accurate chemistry learning assistant designed for university students, educators, and researchers.

Core Guidelines:
1. Pedagogical Clarity: Explain concepts clearly, rigorously, and accurately, adapting depth to the user's question (from foundational organic/inorganic principles to advanced molecular theory).
2. Molecular Context Grounding: If verified compound data is provided in the prompt, anchor your explanations to that molecule when relevant. Always distinguish verified supplied compound data (such as formula, IUPAC name, SMILES, CID) from general chemical reasoning.
3. Scientific Integrity & Accuracy: Never fabricate molecular properties, PubChem CIDs, CAS numbers, or empirical data. If information is uncertain, unknown, or not verified, explicitly state your uncertainty.
4. Honest Capabilities: Do not claim to run live laboratory experiments, molecular dynamics simulations, or real-time external database lookups during this conversation.
5. Scope: Provide conversational chemistry explanations, conceptual guidance, functional group analysis, thermodynamic/kinetic reasoning, and educational insights. Do not generate unverifiable reaction yields or proprietary chemical synthesis recipes for dangerous substances.
6. Universal Chemistry: If no compound is selected, answer general chemistry inquiries (e.g., periodic trends, thermodynamics, reaction kinetics, orbital theory, stereochemistry, acid-base equilibria) thoroughly and clearly.
7. Format: Use clean, readable GitHub-flavored Markdown. Format chemical formulas clearly (e.g., C₉H₈O₄ or H2SO4) and highlight key terms, functional groups, and mechanisms.`;

/**
 * Phase 2: Dedicated Conversational AI Endpoint
 * POST /api/chat
 */
app.post("/api/chat", async (req, res) => {
  // 1. Validate payload structure
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({
      error: "Invalid request payload. Expected a JSON object.",
      code: "INVALID_PAYLOAD",
    });
  }

  const { message, history, compound } = req.body;

  // 2. Validate current message
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      error: "Message is required and must be a non-empty string.",
      code: "INVALID_MESSAGE",
    });
  }

  if (message.length > 2500) {
    return res.status(400).json({
      error: "Message exceeds the maximum allowed length of 2,500 characters.",
      code: "MESSAGE_TOO_LONG",
    });
  }

  const trimmedMessage = message.trim();

  // 3. Validate conversation history
  const sanitizedHistory = [];
  if (history !== undefined && history !== null) {
    if (!Array.isArray(history)) {
      return res.status(400).json({
        error: "History must be an array of prior messages.",
        code: "INVALID_HISTORY",
      });
    }

    // Limit history to the most recent 20 messages for context safety & efficiency
    const recentHistory = history.slice(-20);
    for (const item of recentHistory) {
      if (!item || typeof item !== "object") continue;
      const role = item.sender === "user" || item.role === "user" ? "user" : "assistant";
      const text = typeof (item.text || item.content) === "string" ? (item.text || item.content).trim() : "";
      if (text) {
        sanitizedHistory.push({
          role,
          content: text.slice(0, 2500),
        });
      }
    }
  }

  // 4. Validate and sanitize optional compound context
  let sanitizedCompound = null;
  if (compound !== undefined && compound !== null) {
    if (typeof compound !== "object" || Array.isArray(compound)) {
      return res.status(400).json({
        error: "Compound context must be an object if provided.",
        code: "INVALID_COMPOUND",
      });
    }

    sanitizedCompound = {
      name: typeof compound.name === "string" ? compound.name.trim().slice(0, 150) : null,
      formula: typeof compound.formula === "string" ? compound.formula.trim().slice(0, 50) : null,
      weight:
        typeof (compound.weight || compound.molecularWeight) === "string" ||
        typeof (compound.weight || compound.molecularWeight) === "number"
          ? String(compound.weight || compound.molecularWeight).trim().slice(0, 50)
          : null,
      smiles:
        typeof (compound.smiles || compound.canonicalSmiles) === "string"
          ? (compound.smiles || compound.canonicalSmiles).trim().slice(0, 500)
          : null,
      cid:
        compound.cid || compound.pubchemCid
          ? String(compound.cid || compound.pubchemCid).trim().slice(0, 30)
          : null,
      iupac:
        typeof (compound.iupac || compound.iupacName) === "string"
          ? (compound.iupac || compound.iupacName).trim().slice(0, 250)
          : null,
      category: typeof compound.category === "string" ? compound.category.trim().slice(0, 100) : null,
      description:
        typeof compound.description === "string" ? compound.description.trim().slice(0, 500) : null,
    };

    if (
      !sanitizedCompound.name &&
      !sanitizedCompound.formula &&
      !sanitizedCompound.smiles &&
      !sanitizedCompound.cid
    ) {
      sanitizedCompound = null;
    }
  }

  // 5. Construct compound context block for prompt grounding
  let compoundContextBlock = "";
  if (sanitizedCompound) {
    const details = [];
    if (sanitizedCompound.name) details.push(`- Compound Name: ${sanitizedCompound.name}`);
    if (sanitizedCompound.formula) details.push(`- Chemical Formula: ${sanitizedCompound.formula}`);
    if (sanitizedCompound.weight) details.push(`- Molecular Weight: ${sanitizedCompound.weight}`);
    if (sanitizedCompound.iupac) details.push(`- IUPAC Name: ${sanitizedCompound.iupac}`);
    if (sanitizedCompound.cid) details.push(`- PubChem CID: ${sanitizedCompound.cid}`);
    if (sanitizedCompound.smiles) details.push(`- Canonical SMILES: ${sanitizedCompound.smiles}`);
    if (sanitizedCompound.category) details.push(`- Classification/Category: ${sanitizedCompound.category}`);
    if (sanitizedCompound.description) details.push(`- Verified Lab Summary: ${sanitizedCompound.description}`);

    compoundContextBlock = `[VERIFIED COMPOUND CONTEXT ATTACHED FROM LAB WORKSPACE]
The student/researcher is actively inspecting the following compound:
${details.join("\n")}

Guidelines for this compound-focused dialogue:
- Directly incorporate and reference these verified molecular properties when relevant.
- Clearly distinguish the supplied verified structural facts from theoretical reasoning.
- Do NOT fabricate non-existent physical properties, fake PubChem CIDs, or unverified constants.
- If the user asks about reaction pathways, functional groups, or properties, relate them specifically to ${sanitizedCompound.name || "this structure"}.`;
  }

  // 6. Check AI configuration
  const aiConfig = getAIConfig();
  if (!aiConfig.isConfigured && !aiConfig.openRouter.isConfigured && !aiConfig.gemini.isConfigured) {
    return res.status(503).json({
      error: "AI service is not configured. Please set GEMINI_API_KEY or OPENROUTER_API_KEY in backend/.env.",
      code: "AI_NOT_CONFIGURED",
    });
  }

  let finalSystemInstruction = CHAT_SYSTEM_INSTRUCTION;
  if (compoundContextBlock) {
    finalSystemInstruction += `\n\n${compoundContextBlock}`;
  }

  // 7. Dispatch to configured AI provider with seamless fallback
  try {
    let replyText = "";
    let usedProvider = aiConfig.provider;
    let usedModel = aiConfig.activeModel;

    if (aiConfig.provider === "gemini" && aiConfig.gemini.isConfigured) {
      try {
        const ai = new GoogleGenAI({ apiKey: aiConfig.gemini.apiKey });

        const contents = [];
        for (const item of sanitizedHistory) {
          contents.push({
            role: item.role === "assistant" ? "model" : "user",
            parts: [{ text: item.content }],
          });
        }
        contents.push({
          role: "user",
          parts: [{ text: trimmedMessage }],
        });

        let timeoutHandle;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            const err = new Error("Gemini API request timed out");
            err.code = "ETIMEDOUT";
            reject(err);
          }, GEMINI_TIMEOUT);
        });

        const generationPromise = ai.models.generateContent({
          model: aiConfig.gemini.model,
          contents,
          config: {
            systemInstruction: finalSystemInstruction,
            temperature: 0.3,
            maxOutputTokens: 2048,
          },
        });

        const response = await Promise.race([generationPromise, timeoutPromise]);
        clearTimeout(timeoutHandle);

        replyText = response?.text ? response.text.trim() : "";
        usedProvider = "gemini";
        usedModel = aiConfig.gemini.model;
      } catch (geminiErr) {
        // If Gemini has depleted credits or errors, fall back to OpenRouter if available
        if (aiConfig.openRouter.isConfigured) {
          console.warn("[chat] Gemini provider failed, falling back to OpenRouter:", sanitizeErrorMessage(geminiErr.message));
          const openRouterResult = await callOpenRouterChat({
            apiKey: aiConfig.openRouter.apiKey,
            model: aiConfig.openRouter.model,
            systemInstruction: finalSystemInstruction,
            messages: [
              ...sanitizedHistory,
              { role: "user", content: trimmedMessage },
            ],
            timeoutMs: GEMINI_TIMEOUT,
            maxTokens: 2048,
            temperature: 0.3,
          });
          replyText = openRouterResult.text;
          usedProvider = "openrouter";
          usedModel = openRouterResult.model;
        } else {
          throw geminiErr;
        }
      }
    } else {
      // Default to OpenRouter
      const openRouterResult = await callOpenRouterChat({
        apiKey: aiConfig.openRouter.apiKey,
        model: aiConfig.openRouter.model,
        systemInstruction: finalSystemInstruction,
        messages: [
          ...sanitizedHistory,
          { role: "user", content: trimmedMessage },
        ],
        timeoutMs: GEMINI_TIMEOUT,
        maxTokens: 2048,
        temperature: 0.3,
      });
      replyText = openRouterResult.text;
      usedProvider = "openrouter";
      usedModel = openRouterResult.model;
    }

    if (!replyText) {
      return res.status(502).json({
        error: "AI service returned an empty response. Please try rephrasing your question.",
        code: "EMPTY_MODEL_RESPONSE",
      });
    }

    return res.json({
      reply: replyText,
      provider: usedProvider,
      model: usedModel,
      compoundContextApplied: Boolean(sanitizedCompound),
    });
  } catch (err) {
    const rawMsg = err?.response?.data?.error?.message || err?.message || "Unknown error";
    const safeMsg = sanitizeErrorMessage(rawMsg);
    const status = err?.response?.status || err?.status;

    console.error("[chat] Error communicating with AI provider:", safeMsg);

    if (err.code === "ETIMEDOUT" || safeMsg.toLowerCase().includes("timeout")) {
      return res.status(504).json({
        error: "AI service timed out while generating chemistry response. Please try again.",
        code: "AI_TIMEOUT",
      });
    }

    if (status === 429 || safeMsg.toLowerCase().includes("rate limit") || safeMsg.toLowerCase().includes("quota")) {
      return res.status(429).json({
        error: "AI service rate limit or quota exceeded. Please wait a moment before trying again.",
        details: safeMsg,
        code: "AI_RATE_LIMIT",
      });
    }

    if (
      status === 401 ||
      status === 402 ||
      status === 403 ||
      safeMsg.toLowerCase().includes("api key") ||
      safeMsg.toLowerCase().includes("unauthorized") ||
      safeMsg.toLowerCase().includes("credits are depleted")
    ) {
      return res.status(503).json({
        error: "AI service authentication or billing issue. Please check your API key in backend/.env.",
        details: safeMsg,
        code: "AI_AUTH_ERROR",
      });
    }

    return res.status(502).json({
      error: "Unable to process chemistry chat request at this time.",
      details: safeMsg,
      code: "AI_UPSTREAM_ERROR",
    });
  }
});

app.listen(5000, () => console.log("Server running on http://localhost:5000"));