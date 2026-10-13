-- ============================================================================
-- ChemAI Cloudflare D1 Database Schema
-- Migration: 0001_initial_schema.sql
-- ============================================================================

-- 1. Chemical Compound Cache (PubChem + Wikipedia verified data)
CREATE TABLE IF NOT EXISTS compound_cache (
  cid INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  formula TEXT,
  molecular_weight REAL,
  canonical_smiles TEXT NOT NULL,
  iupac_name TEXT,
  cas_number TEXT,
  wikipedia_extract TEXT,
  wikipedia_thumbnail TEXT,
  wikipedia_url TEXT,
  synonyms TEXT, -- JSON array of string synonyms
  raw_data TEXT, -- Full JSON response from PubChem
  cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_compound_smiles ON compound_cache(canonical_smiles);
CREATE INDEX IF NOT EXISTS idx_compound_name ON compound_cache(name);
CREATE INDEX IF NOT EXISTS idx_compound_formula ON compound_cache(formula);

-- 2. Reverse Structure Lookup Cache (Search by Name or Molecular Formula)
CREATE TABLE IF NOT EXISTS lookup_cache (
  query_type TEXT NOT NULL, -- 'name' | 'formula' | 'auto'
  query_key TEXT NOT NULL,  -- normalized lowercase query
  count INTEGER DEFAULT 0,
  candidates_json TEXT NOT NULL, -- JSON array of candidate structures
  cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (query_type, query_key)
);

-- 3. AI Chemistry Explanation Cache (Indexed by Compound CID + Model)
CREATE TABLE IF NOT EXISTS explanation_cache (
  cid INTEGER NOT NULL,
  model_key TEXT NOT NULL, -- e.g. 'gemini-2.5-flash', 'openrouter_free'
  explanation_json TEXT NOT NULL, -- JSON structured educational analysis
  reference_data_json TEXT,
  cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cid, model_key)
);

-- 4. Conversational Chat Sessions
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Chemistry Inquiry',
  compound_cid INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (compound_cid) REFERENCES compound_cache(cid) ON DELETE SET NULL
);

-- 5. Conversational Chat Messages (Persisted History)
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sender TEXT NOT NULL CHECK(sender IN ('user', 'assistant', 'system')),
  message TEXT NOT NULL,
  compound_context TEXT, -- JSON snapshot of compound attached during message
  provider TEXT,
  model TEXT,
  is_error INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at ASC);
