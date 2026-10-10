import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const AXIOS_TIMEOUT = 10000; // ms
const GEMINI_TIMEOUT = 25000; // ms
const CACHE_DIR = path.resolve("./cache/pubchem_json");

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

/**
 * Safely read Gemini configuration from environment variables.
 * Never logs or exposes the API key.
 */
function getGeminiConfig() {
  const rawKey = process.env.GEMINI_API_KEY;
  const apiKey = typeof rawKey === "string" ? rawKey.trim() : "";
  const isPlaceholder =
    !apiKey ||
    apiKey === "your_gemini_api_key_here" ||
    apiKey === "YOUR_GEMINI_API_KEY" ||
    apiKey.toLowerCase().startsWith("your_");

  const rawModel = process.env.GEMINI_MODEL;
  const model =
    typeof rawModel === "string" && rawModel.trim()
      ? rawModel.trim()
      : DEFAULT_GEMINI_MODEL;

  return {
    isConfigured: !isPlaceholder,
    apiKey: isPlaceholder ? null : apiKey,
    model,
  };
}

/**
 * Strip any potential API keys from error messages before logging or returning.
 */
function sanitizeErrorMessage(msg) {
  if (!msg || typeof msg !== "string") return "Unknown service error";
  let cleaned = msg;
  const rawKey = process.env.GEMINI_API_KEY;
  if (rawKey && typeof rawKey === "string" && rawKey.trim().length > 4) {
    cleaned = cleaned.split(rawKey.trim()).join("[REDACTED]");
  }
  cleaned = cleaned.replace(/AIza[0-9A-Za-z\-_]{20,}/g, "[REDACTED_KEY]");
  return cleaned;
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
  };

  // 3. Check Gemini API Key configuration securely
  const geminiConfig = getGeminiConfig();
  if (!geminiConfig.isConfigured) {
    console.warn("[/api/explain-structure] GEMINI_API_KEY is not configured.");
    return res.status(503).json({
      error: "Gemini API key is not configured on the backend server.",
      details:
        "Add a valid GEMINI_API_KEY to backend/.env (see backend/.env.example) and restart the backend server to enable AI chemistry explanations.",
      code: "GEMINI_CONFIG_MISSING",
      configError: true,
      referenceData,
    });
  }

  // 4. Check explanation cache to avoid unnecessary repeated Gemini calls
  const cachedExplanation = await readExplainCache(compound.cid, geminiConfig.model);
  if (cachedExplanation && cachedExplanation.explanation) {
    console.log(
      `[/api/explain-structure] served cached explanation for CID ${compound.cid} (${compound.name})`
    );
    return res.json({
      ...cachedExplanation,
      source: "gemini-cache",
      referenceData,
    });
  }

  // 5. Build prompt using strictly server-derived PubChem reference properties
  const prompt = `Explain the following verified chemical compound for a chemistry student:

VERIFIED PUBCHEM REFERENCE DATA (Server-Derived):
- Preferred Name: ${referenceData.name}
- PubChem CID: ${referenceData.cid}
- IUPAC Name: ${referenceData.iupacName || "Not listed"}
- Molecular Formula: ${referenceData.molecularFormula || "Not listed"}
- Molecular Weight: ${referenceData.molecularWeight ? `${referenceData.molecularWeight} g/mol` : "Not listed"}
- Canonical SMILES: ${referenceData.canonicalSmiles}
- Submitted SMILES: ${referenceData.inputSmiles}
- Common Synonyms: ${referenceData.synonyms.length > 0 ? referenceData.synonyms.join(", ") : "None listed"}

Provide a concise, accurate educational explanation covering:
1. What the compound is (whatItIs).
2. Its molecular formula and basic structural features (formulaAndStructure).
3. Functional groups present in this structure and their roles — do not invent groups that are absent (functionalGroups).
4. Relevant bonding or structural characteristics such as rings, conjugation, aromaticity, or bond types (bondingAndCharacteristics).
5. A beginner-friendly explanation of why these structural features matter (whyItMatters).
6. A note distinguishing the verified PubChem facts above from AI chemical interpretation and noting any uncertainties (uncertaintyAndVerificationNote).`;

  try {
    const ai = new GoogleGenAI({ apiKey: geminiConfig.apiKey });

    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const err = new Error("Gemini API request timed out");
        err.code = "ETIMEDOUT";
        reject(err);
      }, GEMINI_TIMEOUT);
    });

    const generationPromise = ai.models.generateContent({
      model: geminiConfig.model,
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

    const rawText = response?.text ? response.text.trim() : "";
    if (!rawText) {
      return res.status(502).json({
        error: "Gemini returned an empty explanation response. Please try again.",
        code: "EMPTY_MODEL_RESPONSE",
        referenceData,
      });
    }

    let parsedExplanation;
    try {
      parsedExplanation = JSON.parse(rawText);
    } catch {
      // Fallback if model returned markdown-fenced JSON or plain text
      const cleanedJson = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      try {
        parsedExplanation = JSON.parse(cleanedJson);
      } catch {
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
    }

    const payload = {
      source: "gemini",
      model: geminiConfig.model,
      referenceData,
      explanation: {
        whatItIs: parsedExplanation.whatItIs || "",
        formulaAndStructure: parsedExplanation.formulaAndStructure || "",
        functionalGroups: parsedExplanation.functionalGroups || "",
        bondingAndCharacteristics: parsedExplanation.bondingAndCharacteristics || "",
        whyItMatters: parsedExplanation.whyItMatters || "",
        uncertaintyAndVerificationNote:
          parsedExplanation.uncertaintyAndVerificationNote ||
          "AI-generated chemical interpretations are for educational guidance and should be verified independently.",
      },
      disclaimer:
        "Reference data (Compound Name, CID, IUPAC Name, Formula, Molecular Weight, and Canonical SMILES) is retrieved directly from PubChem. The structural walk-through and functional group explanations are generated by Gemini AI and may require independent verification.",
      generatedAt: new Date().toISOString(),
    };

    await writeExplainCache(compound.cid, geminiConfig.model, payload);

    return res.json(payload);
  } catch (err) {
    const safeMsg = sanitizeErrorMessage(err?.message);
    const status = err?.status || err?.response?.status;
    console.error("[/api/explain-structure] Gemini error:", {
      status,
      code: err?.code,
      message: safeMsg,
    });

    if (err?.code === "ETIMEDOUT" || err?.name === "AbortError") {
      return res.status(504).json({
        error: "The Gemini explanation request timed out. Please try again shortly.",
        code: "GEMINI_TIMEOUT",
        referenceData,
      });
    }

    if (status === 429 || safeMsg.toLowerCase().includes("quota") || safeMsg.toLowerCase().includes("rate limit")) {
      return res.status(429).json({
        error: "Gemini API rate limit or quota reached. Please wait a moment before requesting another explanation.",
        code: "GEMINI_RATE_LIMIT",
        referenceData,
      });
    }

    if (
      status === 400 ||
      status === 401 ||
      status === 403 ||
      safeMsg.toLowerCase().includes("api_key_invalid") ||
      safeMsg.toLowerCase().includes("api key not valid")
    ) {
      return res.status(503).json({
        error: "Gemini API configuration or authentication error.",
        details:
          "Please verify that GEMINI_API_KEY and GEMINI_MODEL in backend/.env are valid and active.",
        code: "GEMINI_AUTH_ERROR",
        configError: true,
        referenceData,
      });
    }

    return res.status(502).json({
      error: "Unable to generate chemistry explanation from Gemini at this time.",
      details: safeMsg,
      code: "GEMINI_UPSTREAM_ERROR",
      referenceData,
    });
  }
});

app.listen(5000, () => console.log("Server running on http://localhost:5000"));