/**
 * ==============================================================================
 * ChemAI — Cloudflare Pages Functions API Gateway
 * Edge-native serverless functions running on Cloudflare Workers runtime
 * Integrated with Cloudflare D1 SQL Database & AI providers (Gemini / OpenRouter)
 * ==============================================================================
 */

// Helper to return JSON responses with CORS headers
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      ...headers,
    },
  });
}

// Clean and sanitize error text to avoid exposing secrets
function sanitizeError(msg) {
  if (!msg || typeof msg !== "string") return "Internal service notice";
  return msg
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, "[REDACTED_KEY]")
    .replace(/sk-or-v1-[0-9a-zA-Z]{20,}/g, "[REDACTED_KEY]");
}

// Handle CORS Preflight Requests
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

// Main Catch-all Router for /api/*
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method;

  try {
    // 1. Health Check: GET /api/health
    if (pathname.endsWith("/health") && method === "GET") {
      let d1Status = "unbound";
      if (env.DB) {
        try {
          const check = await env.DB.prepare("SELECT 1 as alive").first();
          d1Status = check?.alive === 1 ? "connected" : "error";
        } catch (dbErr) {
          d1Status = `error: ${dbErr.message}`;
        }
      }

      return jsonResponse({
        status: "ok",
        platform: "cloudflare-pages",
        d1_database: d1Status,
        ai_provider: env.AI_PROVIDER || "openrouter",
        timestamp: new Date().toISOString(),
      });
    }

    // 2. Identify Molecule: POST /api/identify
    if (pathname.endsWith("/identify") && method === "POST") {
      return await handleIdentify(request, env);
    }

    // 3. Reverse Structure Lookup: POST /api/lookup-structure
    if (pathname.endsWith("/lookup-structure") && method === "POST") {
      return await handleLookupStructure(request, env);
    }

    // 4. Compound Analyzer: POST /api/analyze
    if (pathname.endsWith("/analyze") && method === "POST") {
      return await handleAnalyze(request, env);
    }

    // 5. Educational Chemistry Explanation: POST /api/explain-structure
    if (pathname.endsWith("/explain-structure") && method === "POST") {
      return await handleExplainStructure(request, env);
    }

    // 6. Conversational AI Chat: POST /api/chat
    if (pathname.endsWith("/chat") && method === "POST") {
      return await handleChat(request, env);
    }

    // 7. AI-Assisted Structure Generation: POST /api/generate-structure
    if (pathname.endsWith("/generate-structure") && method === "POST") {
      return await handleGenerateStructure(request, env);
    }

    // 7. Saved Compounds List: GET /api/compounds
    if (pathname.endsWith("/compounds") && method === "GET") {
      return await handleGetCompounds(request, env);
    }

    // 8. Chat History: GET /api/history
    if (pathname.endsWith("/history") && method === "GET") {
      return await handleGetHistory(request, env, url);
    }

    return jsonResponse({ error: "Endpoint not found", path: pathname }, 404);
  } catch (err) {
    console.error(`[Cloudflare API Error] on ${pathname}:`, err);
    return jsonResponse(
      { error: "Internal Server Error", details: sanitizeError(err.message) },
      500
    );
  }
}

/**
 * -----------------------------------------------------------------------------
 * 1. IDENTIFY MOLECULE (PUG REST + CLOUDFLARE D1 CACHE)
 * -----------------------------------------------------------------------------
 */
async function handleIdentify(request, env) {
  const body = await request.json().catch(() => ({}));
  const smiles = (body.smiles || "").trim();

  if (!smiles) {
    return jsonResponse({ error: "Missing or empty SMILES string" }, 400);
  }

  // 1. Check Cloudflare D1 Cache
  if (env.DB) {
    try {
      const cached = await env.DB.prepare(
        "SELECT * FROM compound_cache WHERE canonical_smiles = ? LIMIT 1"
      )
        .bind(smiles)
        .first();

      if (cached) {
        return jsonResponse({
          cid: cached.cid,
          name: cached.name,
          molecularFormula: cached.formula,
          molecularWeight: cached.molecular_weight,
          canonicalSmiles: cached.canonical_smiles,
          iupacName: cached.iupac_name,
          casNumber: cached.cas_number,
          synonyms: cached.synonyms ? JSON.parse(cached.synonyms) : [],
          wikipedia: cached.wikipedia_extract
            ? {
                extract: cached.wikipedia_extract,
                thumbnail: cached.wikipedia_thumbnail,
                url: cached.wikipedia_url,
              }
            : null,
          source: "cloudflare-d1",
        });
      }
    } catch (d1Err) {
      console.warn("[D1 Cache Check Notice]:", d1Err.message);
    }
  }

  // 2. Query PubChem PUG REST
  const pubchemUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/smiles/${encodeURIComponent(
    smiles
  )}/property/MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES,Title/JSON`;

  const pubchemRes = await fetch(pubchemUrl, {
    headers: { "User-Agent": "ChemAI/1.0 (Cloudflare Pages)" },
  });

  if (!pubchemRes.ok) {
    if (pubchemRes.status === 404) {
      return jsonResponse(
        {
          error: "No matching compound was found in PubChem for this structure.",
          smiles,
        },
        404
      );
    }
    return jsonResponse(
      { error: "PubChem identification service temporarily unavailable" },
      pubchemRes.status
    );
  }

  const pubchemJson = await pubchemRes.json();
  const prop = pubchemJson?.PropertyTable?.Properties?.[0];
  if (!prop) {
    return jsonResponse({ error: "Unrecognized compound structure" }, 404);
  }

  const cid = prop.CID;
  const name = prop.Title || prop.IUPACName || "Identified Molecule";
  const formula = prop.MolecularFormula || "";
  const weight = prop.MolecularWeight ? parseFloat(prop.MolecularWeight) : null;
  const canonicalSmiles = prop.CanonicalSMILES || smiles;
  const iupacName = prop.IUPACName || "";

  // 3. Fetch Wikipedia Encyclopedic Context (best effort)
  let wikiData = null;
  try {
    const wikiRes = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`,
      { headers: { "User-Agent": "ChemAI/1.0 (Cloudflare Pages)" } }
    );
    if (wikiRes.ok) {
      const wJson = await wikiRes.json();
      if (wJson.type === "standard" || wJson.extract) {
        wikiData = {
          extract: wJson.extract,
          thumbnail: wJson.thumbnail?.source || null,
          url: wJson.content_urls?.desktop?.page || null,
        };
      }
    }
  } catch (wErr) {
    console.warn("[Wikipedia Fetch Notice]:", wErr.message);
  }

  // 4. Save to Cloudflare D1 Database
  if (env.DB) {
    try {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO compound_cache (
          cid, name, formula, molecular_weight, canonical_smiles, iupac_name,
          wikipedia_extract, wikipedia_thumbnail, wikipedia_url, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      )
        .bind(
          cid,
          name,
          formula,
          weight,
          canonicalSmiles,
          iupacName,
          wikiData?.extract || null,
          wikiData?.thumbnail || null,
          wikiData?.url || null
        )
        .run();
    } catch (saveErr) {
      console.warn("[D1 Cache Save Notice]:", saveErr.message);
    }
  }

  return jsonResponse({
    cid,
    name,
    molecularFormula: formula,
    molecularWeight: weight,
    canonicalSmiles,
    iupacName,
    wikipedia: wikiData,
    source: "pubchem",
  });
}

/**
 * -----------------------------------------------------------------------------
 * 2. REVERSE STRUCTURE LOOKUP (NAME OR FORMULA SEARCH)
 * -----------------------------------------------------------------------------
 */
async function handleLookupStructure(request, env) {
  const body = await request.json().catch(() => ({}));
  const query = (body.query || "").trim();
  const type = body.type || "auto";

  if (!query) {
    return jsonResponse({ error: "Search query required" }, 400);
  }

  const queryKey = query.toLowerCase();

  // 1. Check Cloudflare D1 Cache
  if (env.DB) {
    try {
      const cached = await env.DB.prepare(
        "SELECT candidates_json FROM lookup_cache WHERE query_type = ? AND query_key = ? LIMIT 1"
      )
        .bind(type, queryKey)
        .first();

      if (cached && cached.candidates_json) {
        return jsonResponse({
          query,
          queryType: type,
          candidates: JSON.parse(cached.candidates_json),
          source: "cloudflare-d1",
        });
      }
    } catch (d1Err) {
      console.warn("[D1 Lookup Cache Notice]:", d1Err.message);
    }
  }

  // 2. Query PubChem
  const isFormula = type === "formula" || (type === "auto" && /^[A-Z][a-z]?\d*/.test(query));
  const pubchemEndpoint = isFormula
    ? `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/fastformula/${encodeURIComponent(query)}/property/MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES,Title/JSON?MaxRecords=6`
    : `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(query)}/property/MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES,Title/JSON?MaxRecords=6`;

  const pRes = await fetch(pubchemEndpoint, {
    headers: { "User-Agent": "ChemAI/1.0 (Cloudflare Pages)" },
  });

  if (!pRes.ok) {
    return jsonResponse(
      { error: `No compounds found matching "${query}"`, query },
      404
    );
  }

  const pJson = await pRes.json();
  const properties = pJson?.PropertyTable?.Properties || [];

  const candidates = properties.map((p) => ({
    cid: p.CID,
    name: p.Title || p.IUPACName || `Compound ${p.CID}`,
    molecularFormula: p.MolecularFormula,
    molecularWeight: p.MolecularWeight ? parseFloat(p.MolecularWeight) : null,
    smiles: p.CanonicalSMILES,
    iupacName: p.IUPACName,
  }));

  // 3. Save Candidates to D1 Cache
  if (env.DB && candidates.length > 0) {
    try {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO lookup_cache (query_type, query_key, count, candidates_json) VALUES (?, ?, ?, ?)"
      )
        .bind(type, queryKey, candidates.length, JSON.stringify(candidates))
        .run();
    } catch (saveErr) {
      console.warn("[D1 Save Lookup Notice]:", saveErr.message);
    }
  }

  return jsonResponse({
    query,
    queryType: isFormula ? "formula" : "name",
    candidates,
    source: "pubchem",
  });
}

/**
 * -----------------------------------------------------------------------------
 * 3. COMPOUND ANALYZER (COMPATIBILITY WRAPPER)
 * -----------------------------------------------------------------------------
 */
async function handleAnalyze(request, env) {
  const body = await request.json().catch(() => ({}));
  const compound = (body.compound || "").trim();

  if (!compound) {
    return jsonResponse({ error: "Compound query required" }, 400);
  }

  const pUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(
    compound
  )}/property/MolecularFormula,MolecularWeight,CanonicalSMILES,Title/JSON`;

  const res = await fetch(pUrl);
  if (!res.ok) {
    return jsonResponse({ error: `Compound "${compound}" not found in PubChem` }, 404);
  }

  const json = await res.json();
  const prop = json?.PropertyTable?.Properties?.[0];
  if (!prop) {
    return jsonResponse({ error: "No properties returned" }, 404);
  }

  return jsonResponse({
    compound: prop.Title || compound,
    molecularFormula: prop.MolecularFormula,
    molecularWeight: prop.MolecularWeight,
    cid: prop.CID,
    isomericSmiles: prop.CanonicalSMILES,
    source: "pubchem",
  });
}

/**
 * -----------------------------------------------------------------------------
 * 4. CHEMISTRY EXPLANATION (GEMINI / OPENROUTER + D1 CACHE)
 * -----------------------------------------------------------------------------
 */
async function handleExplainStructure(request, env) {
  const body = await request.json().catch(() => ({}));
  const smiles = (body.smiles || "").trim();

  if (!smiles) {
    return jsonResponse({ error: "SMILES string required" }, 400);
  }

  // 1. Identify first to obtain verified CID and reference facts
  const identRes = await handleIdentify(
    new Request("http://internal/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ smiles }),
    }),
    env
  );

  const identData = await identRes.json();
  if (!identRes.ok || !identData.cid) {
    return jsonResponse(identData, identRes.status);
  }

  const cid = identData.cid;
  const modelKey = env.OPENROUTER_MODEL || "gemini-2.5-flash";

  // 2. Check Cloudflare D1 Explanation Cache
  if (env.DB) {
    try {
      const cached = await env.DB.prepare(
        "SELECT explanation_json FROM explanation_cache WHERE cid = ? AND model_key = ? LIMIT 1"
      )
        .bind(cid, modelKey)
        .first();

      if (cached && cached.explanation_json) {
        return jsonResponse({
          compound: identData,
          explanation: JSON.parse(cached.explanation_json),
          source: "cloudflare-d1-cache",
        });
      }
    } catch (d1Err) {
      console.warn("[D1 Explain Cache Notice]:", d1Err.message);
    }
  }

  // 3. Prompt Formulation for Chemistry Explanation
  const prompt = `You are ChemAI, an educational chemistry co-pilot.
Analyze this verified chemical compound:
Name: ${identData.name}
Formula: ${identData.molecularFormula}
Molecular Weight: ${identData.molecularWeight} g/mol
Canonical SMILES: ${identData.canonicalSmiles}
IUPAC Name: ${identData.iupacName || "N/A"}

Provide a structured, undergraduate-level chemical analysis covering:
1. What This Compound Is (classification, chemical family)
2. Formula & Structural Features
3. Functional Groups & Their Roles
4. Bonding & Geometric Characteristics
5. Why These Features Matter (applications, reactivity)
6. Uncertainty & Verification Note

Respond strictly in valid JSON format:
{
  "whatItIs": "...",
  "formulaAndStructure": "...",
  "functionalGroups": "...",
  "bondingAndCharacteristics": "...",
  "whyItMatters": "...",
  "uncertaintyAndVerificationNote": "..."
}`;

  const aiReply = await callAI({ prompt, env, systemPrompt: "You are an expert chemical educator." });
  let parsedExplanation;
  try {
    const cleanJson = aiReply.text.replace(/```json/g, "").replace(/```/g, "").trim();
    parsedExplanation = JSON.parse(cleanJson);
  } catch {
    parsedExplanation = {
      whatItIs: aiReply.text,
      formulaAndStructure: `Formula: ${identData.molecularFormula}`,
      functionalGroups: "Derived from molecular structure.",
      bondingAndCharacteristics: "Delocalized and localized bonds as indicated in SMILES.",
      whyItMatters: "Standard chemical reference.",
      uncertaintyAndVerificationNote: "Educational interpretation based on verified PubChem reference.",
    };
  }

  // 4. Save to Cloudflare D1
  if (env.DB) {
    try {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO explanation_cache (cid, model_key, explanation_json) VALUES (?, ?, ?)"
      )
        .bind(cid, modelKey, JSON.stringify(parsedExplanation))
        .run();
    } catch (sErr) {
      console.warn("[D1 Save Explanation Notice]:", sErr.message);
    }
  }

  return jsonResponse({
    compound: identData,
    explanation: parsedExplanation,
    provider: aiReply.provider,
    model: aiReply.model,
    source: "ai-generated",
  });
}

/**
 * -----------------------------------------------------------------------------
 * 5. CONVERSATIONAL AI CHAT (WITH COMPOUND GROUNDING & D1 PERSISTENCE)
 * -----------------------------------------------------------------------------
 */
async function handleChat(request, env) {
  const body = await request.json().catch(() => ({}));
  const message = (body.message || "").trim();
  const history = Array.isArray(body.history) ? body.history : [];
  const compound = body.compound || null;
  const sessionId = body.sessionId || null;

  if (!message) {
    return jsonResponse({ error: "Message is required." }, 400);
  }

  // Build Chemistry System Prompt
  let systemPrompt = `You are ChemAI, an expert chemistry learning assistant for university and research chemistry.
Your role: Explain chemical principles clearly, accurately, and conceptually.
Answer general chemistry inquiries (thermodynamics, mechanisms, stereochemistry, orbitals) thoroughly.`;

  if (compound) {
    systemPrompt += `\n\nATTACHED VERIFIED COMPOUND CONTEXT:
Name: ${compound.name}
Formula: ${compound.formula || "N/A"}
Molecular Weight: ${compound.weight || "N/A"}
PubChem CID: ${compound.cid || "N/A"}
Canonical SMILES: ${compound.smiles || "N/A"}
IUPAC: ${compound.iupac || "N/A"}
Description: ${compound.description || "N/A"}

Anchor your explanations to this molecule when relevant. Distinguish verified facts from general reasoning.`;
  }

  // Call Edge AI
  const aiResult = await callAI({
    prompt: message,
    history,
    systemPrompt,
    env,
  });

  // Persist to Cloudflare D1 Chat History (if session ID provided)
  if (env.DB && sessionId) {
    try {
      const msgIdUser = `msg_${Date.now()}_u`;
      const msgIdAi = `msg_${Date.now()}_a`;

      await env.DB.batch([
        env.DB.prepare(
          "INSERT OR IGNORE INTO chat_sessions (id, title, compound_cid) VALUES (?, ?, ?)"
        ).bind(sessionId, compound ? `Inquiry on ${compound.name}` : "General Chemistry", compound?.cid || null),
        env.DB.prepare(
          "INSERT INTO chat_messages (id, session_id, sender, message, compound_context) VALUES (?, ?, ?, ?, ?)"
        ).bind(msgIdUser, sessionId, "user", message, compound ? JSON.stringify(compound) : null),
        env.DB.prepare(
          "INSERT INTO chat_messages (id, session_id, sender, message, compound_context, provider, model) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(msgIdAi, sessionId, "assistant", aiResult.text, compound ? JSON.stringify(compound) : null, aiResult.provider, aiResult.model),
      ]);
    } catch (d1ChatErr) {
      console.warn("[D1 Chat Persistence Notice]:", d1ChatErr.message);
    }
  }

  return jsonResponse({
    reply: aiResult.text,
    provider: aiResult.provider,
    model: aiResult.model,
  });
}

/**
 * -----------------------------------------------------------------------------
 * 6. AI-ASSISTED STRUCTURE GENERATION (POST /api/generate-structure)
 * -----------------------------------------------------------------------------
 */
async function handleGenerateStructure(request, env) {
  const body = await request.json().catch(() => ({}));
  const query = (body.query || "").trim();

  if (!query) {
    return jsonResponse(
      { error: "Please provide a chemical name or formula.", code: "EMPTY_QUERY" },
      400
    );
  }

  if (query.length > 150) {
    return jsonResponse(
      { error: "Query exceeds maximum permitted length of 150 characters.", code: "QUERY_TOO_LONG" },
      400
    );
  }

  const prompt = `Propose a single plausible molecular structure representation for the chemical name or formula: "${query}".
Return ONLY a valid JSON object with this exact structure:
{
  "input": "${query}",
  "proposedName": "...",
  "smiles": "...",
  "molecularFormula": "...",
  "reasoningSummary": "...",
  "uncertaintyNote": "..."
}`;

  try {
    const aiResult = await callAI({
      prompt,
      env,
      systemPrompt: "You are an expert cheminformatics assistant. Generate chemically plausible SMILES for standard molecules. Output valid JSON only.",
    });

    let parsed;
    try {
      const cleanJson = aiResult.text.replace(/```json/g, "").replace(/```/g, "").trim();
      parsed = JSON.parse(cleanJson);
    } catch {
      return jsonResponse(
        {
          error: "The AI generated an unparseable response.",
          details: aiResult.text,
          code: "AI_INVALID_FORMAT",
        },
        422
      );
    }

    if (!parsed.smiles) {
      return jsonResponse(
        {
          error: "The AI did not propose a valid SMILES string.",
          code: "AI_INVALID_SMILES",
        },
        422
      );
    }

    return jsonResponse({
      source: "ai-generated",
      candidate: {
        input: query,
        proposedName: parsed.proposedName || query,
        smiles: parsed.smiles,
        molecularFormula: parsed.molecularFormula || null,
        reasoningSummary: parsed.reasoningSummary || "",
        uncertaintyNote: parsed.uncertaintyNote || "",
        model: aiResult.model,
      },
    });
  } catch (err) {
    return jsonResponse(
      {
        error: "Failed to generate structure candidate.",
        details: sanitizeError(err.message),
        code: "AI_GENERATION_FAILED",
      },
      500
    );
  }
}

/**
 * -----------------------------------------------------------------------------
 * 7. RETRIEVE RECENT COMPOUNDS FROM D1 (GET /api/compounds)
 * -----------------------------------------------------------------------------
 */
async function handleGetCompounds(request, env) {
  if (!env.DB) {
    return jsonResponse({ compounds: [] });
  }

  try {
    const { results } = await env.DB.prepare(
      "SELECT cid, name, formula, molecular_weight, canonical_smiles, iupac_name, cached_at FROM compound_cache ORDER BY cached_at DESC LIMIT 50"
    ).all();

    return jsonResponse({ compounds: results || [] });
  } catch (err) {
    return jsonResponse({ error: "Failed to read compound cache", details: err.message }, 500);
  }
}

/**
 * -----------------------------------------------------------------------------
 * 7. RETRIEVE CHAT HISTORY FROM D1 (GET /api/history?sessionId=...)
 * -----------------------------------------------------------------------------
 */
async function handleGetHistory(request, env, url) {
  const sessionId = url.searchParams.get("sessionId");
  if (!env.DB || !sessionId) {
    return jsonResponse({ messages: [] });
  }

  try {
    const { results } = await env.DB.prepare(
      "SELECT id, sender, message, compound_context, model, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC"
    )
      .bind(sessionId)
      .all();

    const formatted = (results || []).map((r) => ({
      id: r.id,
      sender: r.sender,
      text: r.message,
      compoundContext: r.compound_context ? JSON.parse(r.compound_context) : null,
      model: r.model,
      timestamp: new Date(r.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    }));

    return jsonResponse({ messages: formatted });
  } catch (err) {
    return jsonResponse({ error: "Failed to read history", details: err.message }, 500);
  }
}

/**
 * -----------------------------------------------------------------------------
 * AI CLIENT GATEWAY (OpenRouter / Gemini REST on Edge)
 * -----------------------------------------------------------------------------
 */
async function callAI({ prompt, history = [], systemPrompt = "", env }) {
  const openRouterKey = env.OPENROUTER_API_KEY;
  const geminiKey = env.GEMINI_API_KEY;

  const preferGemini = env.AI_PROVIDER === "gemini" && Boolean(geminiKey);

  // 1. Route to Google Gemini REST API if specified or available
  if (preferGemini || (geminiKey && !openRouterKey)) {
    const model = env.GEMINI_MODEL || "gemini-2.5-flash";
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;

    const contents = [];
    if (systemPrompt) {
      contents.push({ role: "user", parts: [{ text: `[System Instruction: ${systemPrompt}]` }] });
      contents.push({ role: "model", parts: [{ text: "Understood. I will follow these chemistry guidelines." }] });
    }

    for (const h of history) {
      contents.push({
        role: h.role === "assistant" ? "model" : "user",
        parts: [{ text: h.content }],
      });
    }

    contents.push({ role: "user", parts: [{ text: prompt }] });

    const gRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents }),
    });

    if (!gRes.ok) {
      const errText = await gRes.text();
      throw new Error(`Gemini API error (${gRes.status}): ${sanitizeError(errText)}`);
    }

    const gData = await gRes.json();
    const replyText = gData?.candidates?.[0]?.content?.parts?.[0]?.text || "No response received.";
    return { text: replyText, provider: "gemini", model };
  }

  // 2. Default Route: OpenRouter API
  if (openRouterKey) {
    const model = env.OPENROUTER_MODEL || "liquid/lfm-2.5-2.6b:free";
    const messages = [];

    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }

    for (const h of history) {
      messages.push({ role: h.role === "assistant" ? "assistant" : "user", content: h.content });
    }

    messages.push({ role: "user", content: prompt });

    const oRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openRouterKey}`,
        "HTTP-Referer": "https://chemai.pages.dev",
        "X-Title": "ChemAI Lab Suite",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
      }),
    });

    if (!oRes.ok) {
      const errText = await oRes.text();
      throw new Error(`OpenRouter API error (${oRes.status}): ${sanitizeError(errText)}`);
    }

    const oData = await oRes.json();
    const replyText = oData?.choices?.[0]?.message?.content || "No response received.";
    return { text: replyText, provider: "openrouter", model };
  }

  // Fallback demo message if no API keys are configured yet on Cloudflare
  return {
    text: `ChemAI is currently running in Cloudflare Pages Edge mode. To activate live AI completions, please configure OPENROUTER_API_KEY or GEMINI_API_KEY in your Cloudflare Pages dashboard under Settings -> Environment Variables.`,
    provider: "chemai-edge-notice",
    model: "edge-unconfigured",
  };
}
