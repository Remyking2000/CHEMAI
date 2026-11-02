/**
 * ==============================================================================
 * ChemAI — Controlled Molecular Editor Bridge (Phase 2A)
 * ------------------------------------------------------------------------------
 * Programmatic interface allowing trusted frontend code to inspect and manipulate
 * the active molecular editor (Desktop and Mobile) safely and consistently.
 *
 * Core capabilities:
 *   1. read_editor_structure: returns current SMILES, formula, atom/bond counts,
 *      molecular graph, and whether a molecule is present.
 *   2. load_structure_into_editor: validates SMILES before loading, enforces
 *      an explicit user approval boundary when replacing non-empty structures,
 *      updates shared molecular state across desktop/mobile, and frames the canvas.
 *   3. fit_canvas_view: centers and fits the current structure to the active viewport
 *      without modifying the molecule.
 *   4. get_editor_capabilities: inspects active editor mode, supported actions,
 *      and readiness status.
 *
 * Result convention:
 *   { ok: boolean, action: string, data?: object, error?: string, needsApproval?: boolean }
 *
 * Safety boundaries:
 *   - Reading is strictly read-only (no state change).
 *   - Viewport fitting never alters molecular data.
 *   - Structure replacement on a non-empty canvas requires explicit user approval.
 *   - Only allowlisted actions are executed; arbitrary script evaluation is rejected.
 * ==============================================================================
 */

import {
  EMPTY_MOL,
  exportStructure,
  molFromSmiles,
  computeViewportTransform,
  isValidEntityId,
  cloneMolecule,
  proposeBondOrderChange,
} from "./moleculeEngine.js";

export const ALLOWED_BRIDGE_ACTIONS = Object.freeze([
  "read_editor_structure",
  "load_structure_into_editor",
  "fit_canvas_view",
  "get_editor_capabilities",
  "change_bond_order",
  "mutate_editor_structure",
]);

export const ALLOWED_MUTATION_OPERATIONS = Object.freeze([
  "change_bond_order",
]);

export const BRIDGE_ERROR_TYPES = Object.freeze({
  EDITOR_UNAVAILABLE: "editor_unavailable",
  INVALID_STRUCTURE: "invalid_structure",
  REPLACEMENT_REJECTED: "replacement_rejected",
  EDITOR_OPERATION_FAILED: "editor_operation_failed",
});

export const MUTATION_FAILURE_CODES = Object.freeze({
  MISSING_ACTION_ID: "missing_action_id",
  MISSING_OPERATION: "missing_operation",
  UNKNOWN_OPERATION: "unknown_operation",
  MALFORMED_ARGUMENTS: "malformed_arguments",
  INVALID_ATOM_ID: "invalid_atom_id",
  UNKNOWN_ATOM_ID: "unknown_atom_id",
  INVALID_BOND_ID: "invalid_bond_id",
  UNKNOWN_BOND_ID: "unknown_bond_id",
  BOND_ENDPOINT_MISMATCH: "bond_endpoint_mismatch",
  INVALID_BOND_ORDER: "invalid_bond_order",
  SELF_BOND: "self_bond",
  DUPLICATE_BOND: "duplicate_bond",
  VALENCE_VIOLATION: "valence_violation",
  STALE_REVISION: "stale_revision",
  DUPLICATE_ACTION: "duplicate_action",
  ACTION_IN_PROGRESS: "action_in_progress",
  EDITOR_UNAVAILABLE: "editor_unavailable",
  APPROVAL_REJECTED: "approval_rejected",
  EXECUTION_INTERRUPTED: "execution_interrupted",
  EMPTY_CANVAS: "empty_canvas",
});

const ALLOWED_REQUEST_KEYS = new Set([
  "actionId",
  "operation",
  "arguments",
  "target",
  "expectedRevision",
  "requireApproval",
  "approved",
  "source",
  "bondId",
  "atomId1",
  "atomId2",
  "a",
  "b",
  "a1",
  "a2",
  "order",
  "createBond",
]);

const ALLOWED_CHANGE_BOND_ORDER_ARG_KEYS = new Set([
  "bondId",
  "atomId1",
  "atomId2",
  "a",
  "b",
  "a1",
  "a2",
  "order",
  "expectedRevision",
  "requireApproval",
  "approved",
  "source",
  "actionId",
  "createBond",
]);

function serializeGraph(mol) {
  const atoms = Array.isArray(mol?.atoms) ? mol.atoms : [];
  const bonds = Array.isArray(mol?.bonds) ? mol.bonds : [];
  return {
    atoms: atoms.map((a) => ({
      id: a.id,
      el: a.el || a.element || "C",
      element: a.el || a.element || "C",
      x: a.x,
      y: a.y,
      charge: a.charge || 0,
    })),
    bonds: bonds.map((b) => ({
      id: b.id,
      a: b.a ?? b.a1,
      b: b.b ?? b.a2,
      a1: b.a ?? b.a1,
      a2: b.b ?? b.a2,
      order: b.order,
    })),
  };
}

/**
 * Validates the schema and parameters of a structured mutation request before execution.
 */
export function validateMutationRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return {
      ok: false,
      code: MUTATION_FAILURE_CODES.MALFORMED_ARGUMENTS,
      error: "Mutation request must be a plain JSON object.",
    };
  }

  for (const key of Object.keys(request)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      return {
        ok: false,
        code: MUTATION_FAILURE_CODES.MALFORMED_ARGUMENTS,
        error: `Unexpected property "${key}" in mutation request.`,
      };
    }
  }

  const rawActionId = request.actionId ?? request.arguments?.actionId;
  if (typeof rawActionId !== "string" || !rawActionId.trim()) {
    return {
      ok: false,
      code: MUTATION_FAILURE_CODES.MISSING_ACTION_ID,
      error: "Mutation request requires a non-empty string 'actionId'.",
    };
  }
  const actionId = rawActionId.trim();

  const rawOperation = request.operation;
  if (typeof rawOperation !== "string" || !rawOperation.trim()) {
    return {
      ok: false,
      code: MUTATION_FAILURE_CODES.MISSING_OPERATION,
      error: "Mutation request requires a non-empty string 'operation'.",
    };
  }
  const operation = rawOperation.trim();

  if (!ALLOWED_MUTATION_OPERATIONS.includes(operation)) {
    return {
      ok: false,
      code: MUTATION_FAILURE_CODES.UNKNOWN_OPERATION,
      error: `Unsupported mutation operation "${operation}". Allowed operations: ${ALLOWED_MUTATION_OPERATIONS.join(", ")}.`,
    };
  }

  if (
    request.arguments !== undefined &&
    (request.arguments === null || typeof request.arguments !== "object" || Array.isArray(request.arguments))
  ) {
    return {
      ok: false,
      code: MUTATION_FAILURE_CODES.MALFORMED_ARGUMENTS,
      error: "Mutation 'arguments' must be a plain JSON object.",
    };
  }

  if (
    request.target !== undefined &&
    (request.target === null || typeof request.target !== "object" || Array.isArray(request.target))
  ) {
    return {
      ok: false,
      code: MUTATION_FAILURE_CODES.MALFORMED_ARGUMENTS,
      error: "Mutation 'target' must be a plain JSON object.",
    };
  }

  const argsObj = request.arguments || {};
  const targetObj = request.target || {};

  for (const key of Object.keys(argsObj)) {
    if (!ALLOWED_CHANGE_BOND_ORDER_ARG_KEYS.has(key)) {
      return {
        ok: false,
        code: MUTATION_FAILURE_CODES.MALFORMED_ARGUMENTS,
        error: `Unexpected argument "${key}" for operation "${operation}".`,
      };
    }
  }

  for (const key of Object.keys(targetObj)) {
    if (!ALLOWED_CHANGE_BOND_ORDER_ARG_KEYS.has(key)) {
      return {
        ok: false,
        code: MUTATION_FAILURE_CODES.MALFORMED_ARGUMENTS,
        error: `Unexpected target property "${key}" for operation "${operation}".`,
      };
    }
  }

  const expectedRevision =
    request.expectedRevision !== undefined ? request.expectedRevision : argsObj.expectedRevision;
  if (expectedRevision !== undefined && expectedRevision !== null) {
    if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
      return {
        ok: false,
        code: MUTATION_FAILURE_CODES.MALFORMED_ARGUMENTS,
        error: `Invalid expectedRevision "${String(expectedRevision)}": must be a positive integer.`,
      };
    }
  }

  const requireApproval =
    request.requireApproval !== undefined
      ? Boolean(request.requireApproval)
      : argsObj.requireApproval !== undefined
      ? Boolean(argsObj.requireApproval)
      : false;
  const approved =
    request.approved !== undefined
      ? Boolean(request.approved)
      : argsObj.approved !== undefined
      ? Boolean(argsObj.approved)
      : false;
  const source = request.source || argsObj.source || "ai_agent";

  if (operation === "change_bond_order") {
    const bondId = targetObj.bondId ?? argsObj.bondId ?? request.bondId;
    const atomId1 =
      targetObj.atomId1 ??
      targetObj.a ??
      targetObj.a1 ??
      argsObj.atomId1 ??
      argsObj.a ??
      argsObj.a1 ??
      request.atomId1 ??
      request.a ??
      request.a1;
    const atomId2 =
      targetObj.atomId2 ??
      targetObj.b ??
      targetObj.a2 ??
      argsObj.atomId2 ??
      argsObj.b ??
      argsObj.a2 ??
      request.atomId2 ??
      request.b ??
      request.a2;
    const order = argsObj.order !== undefined ? argsObj.order : request.order;
    const createBond = argsObj.createBond ?? request.createBond ?? false;

    const hasBondId = bondId !== undefined && bondId !== null;
    const hasAtom1 = atomId1 !== undefined && atomId1 !== null;
    const hasAtom2 = atomId2 !== undefined && atomId2 !== null;

    if (hasBondId && !isValidEntityId(bondId)) {
      return {
        ok: false,
        code: MUTATION_FAILURE_CODES.INVALID_BOND_ID,
        error: `Invalid bondId "${String(bondId)}": bond ID must be a positive integer.`,
      };
    }

    if (hasAtom1 && !isValidEntityId(atomId1)) {
      return {
        ok: false,
        code: MUTATION_FAILURE_CODES.INVALID_ATOM_ID,
        error: `Invalid atomId1 "${String(atomId1)}": atom ID must be a positive integer.`,
      };
    }

    if (hasAtom2 && !isValidEntityId(atomId2)) {
      return {
        ok: false,
        code: MUTATION_FAILURE_CODES.INVALID_ATOM_ID,
        error: `Invalid atomId2 "${String(atomId2)}": atom ID must be a positive integer.`,
      };
    }

    if ((hasAtom1 && !hasAtom2) || (!hasAtom1 && hasAtom2)) {
      return {
        ok: false,
        code: MUTATION_FAILURE_CODES.MALFORMED_ARGUMENTS,
        error: "Both 'atomId1' and 'atomId2' must be provided when specifying bond endpoint atoms.",
      };
    }

    if (!hasBondId && !hasAtom1 && !hasAtom2) {
      return {
        ok: false,
        code: MUTATION_FAILURE_CODES.MALFORMED_ARGUMENTS,
        error: "change_bond_order requires either 'bondId' or both 'atomId1' and 'atomId2'.",
      };
    }

    if (hasAtom1 && hasAtom2 && atomId1 === atomId2) {
      return {
        ok: false,
        code: MUTATION_FAILURE_CODES.SELF_BOND,
        error: `Self-bond attempt rejected: atomId1 and atomId2 cannot refer to the same atom (${atomId1}).`,
      };
    }

    if (order === undefined || order === null) {
      return {
        ok: false,
        code: MUTATION_FAILURE_CODES.INVALID_BOND_ORDER,
        error: "Missing required 'order' argument for change_bond_order (must be 1, 2, or 3).",
      };
    }

    if (typeof order !== "number" || !Number.isInteger(order) || ![1, 2, 3].includes(order)) {
      return {
        ok: false,
        code: MUTATION_FAILURE_CODES.INVALID_BOND_ORDER,
        error: `Invalid bond order "${String(order)}": bond order must be 1 (single), 2 (double), or 3 (triple).`,
      };
    }

    return {
      ok: true,
      normalized: {
        actionId,
        operation,
        bondId: hasBondId ? bondId : undefined,
        atomId1: hasAtom1 ? atomId1 : undefined,
        atomId2: hasAtom2 ? atomId2 : undefined,
        order,
        createBond: Boolean(createBond),
        expectedRevision: expectedRevision ?? undefined,
        requireApproval,
        approved,
        source,
      },
    };
  }

  return {
    ok: false,
    code: MUTATION_FAILURE_CODES.UNKNOWN_OPERATION,
    error: `Unhandled mutation operation "${operation}".`,
  };
}

/**
 * Creates a unified editor bridge wrapping the provided editor target.
 *
 * @param {object} target - Adapter object exposing methods to interact with editor state:
 *   - getMolecule(): returns the current molecular graph { atoms, bonds }
 *   - loadSmiles(smiles): loads SMILES into shared molecule manager
 *   - fitView(): optional function to trigger fit/center on active canvas; returns viewport or null
 *   - getViewport(): optional function returning current { zoom, pan }
 *   - getViewMode(): returns 'desktop' | 'mobile'
 *   - isReady(): boolean indicating whether editor is mounted and ready
 *   - requestApproval(info): optional async function prompting user for replacement confirmation
 */
export function createEditorBridge(target, options = {}) {
  if (!target || typeof target !== "object") {
    throw new Error("createEditorBridge requires a valid target adapter object.");
  }

  const getViewMode = () => (typeof target.getViewMode === "function" ? target.getViewMode() : "unknown");
  const isReady = () => (typeof target.isReady === "function" ? Boolean(target.isReady()) : true);

  let bridgeRevision = 1;
  let lastSeenMol = typeof target.getMolecule === "function" ? target.getMolecule() : null;
  let fallbackHistory = { past: [], future: [] };
  let autoActionCounter = 0;

  // Action ID idempotency ledger:
  // actionId -> { state: "in_progress" | "completed" | "rejected" | "failed", result, revision, timestamp }
  const actionLedger = options?.actionLedger instanceof Map ? options.actionLedger : new Map();

  function getRevision() {
    if (typeof target.getRevision === "function") {
      const targetRev = target.getRevision();
      if (typeof targetRev === "number" && Number.isInteger(targetRev) && targetRev >= 1) {
        bridgeRevision = targetRev;
        return targetRev;
      }
    }
    if (typeof target.getMolecule === "function") {
      const current = target.getMolecule();
      if (current !== lastSeenMol) {
        lastSeenMol = current;
        bridgeRevision += 1;
      }
    }
    return bridgeRevision;
  }

  function getActionStatus(actionId) {
    if (typeof actionId !== "string" || !actionId.trim()) return "invalid";
    const entry = actionLedger.get(actionId.trim());
    return entry ? entry.state : "new";
  }

  function commitMoleculeToTarget(nextMol, { viaLoadSmiles = null } = {}) {
    const prevMol = typeof target.getMolecule === "function" ? target.getMolecule() : EMPTY_MOL;
    const hasNativeHistory = typeof target.undo === "function" && typeof target.redo === "function";

    if (viaLoadSmiles !== null && typeof target.loadSmiles === "function") {
      target.loadSmiles(viaLoadSmiles);
    } else if (typeof target.commitMolecule === "function") {
      target.commitMolecule(nextMol);
    } else if (typeof target.setMolecule === "function") {
      target.setMolecule(nextMol);
    } else if (typeof target.loadSmiles === "function") {
      const exp = exportStructure(nextMol);
      target.loadSmiles(exp.smiles);
    } else {
      throw new Error("Editor target does not support committing molecular structures.");
    }

    if (!hasNativeHistory && prevMol !== nextMol) {
      fallbackHistory = {
        past: [...fallbackHistory.past.slice(-35), prevMol],
        future: [],
      };
    }

    const updated = typeof target.getMolecule === "function" ? target.getMolecule() : nextMol;
    if (updated !== lastSeenMol) {
      lastSeenMol = updated;
      bridgeRevision += 1;
    }
    if (typeof target.getRevision === "function") {
      const tRev = target.getRevision();
      if (typeof tRev === "number" && tRev > bridgeRevision) {
        bridgeRevision = tRev;
      }
    }
  }

  function undo() {
    if (!isReady()) return false;
    if (typeof target.undo === "function") {
      const beforeMol = typeof target.getMolecule === "function" ? target.getMolecule() : null;
      const res = target.undo();
      const afterMol = typeof target.getMolecule === "function" ? target.getMolecule() : null;
      if (afterMol !== beforeMol) {
        lastSeenMol = afterMol;
        bridgeRevision += 1;
        if (typeof target.getRevision === "function") {
          const tRev = target.getRevision();
          if (typeof tRev === "number" && tRev > bridgeRevision) bridgeRevision = tRev;
        }
        return true;
      }
      return Boolean(res);
    }
    if (fallbackHistory.past.length === 0) return false;
    const current = typeof target.getMolecule === "function" ? target.getMolecule() : EMPTY_MOL;
    const previous = fallbackHistory.past[fallbackHistory.past.length - 1];
    fallbackHistory = {
      past: fallbackHistory.past.slice(0, -1),
      future: [current, ...fallbackHistory.future],
    };
    if (typeof target.setMolecule === "function") {
      target.setMolecule(previous);
    }
    lastSeenMol = previous;
    bridgeRevision += 1;
    return true;
  }

  function redo() {
    if (!isReady()) return false;
    if (typeof target.redo === "function") {
      const beforeMol = typeof target.getMolecule === "function" ? target.getMolecule() : null;
      const res = target.redo();
      const afterMol = typeof target.getMolecule === "function" ? target.getMolecule() : null;
      if (afterMol !== beforeMol) {
        lastSeenMol = afterMol;
        bridgeRevision += 1;
        if (typeof target.getRevision === "function") {
          const tRev = target.getRevision();
          if (typeof tRev === "number" && tRev > bridgeRevision) bridgeRevision = tRev;
        }
        return true;
      }
      return Boolean(res);
    }
    if (fallbackHistory.future.length === 0) return false;
    const current = typeof target.getMolecule === "function" ? target.getMolecule() : EMPTY_MOL;
    const next = fallbackHistory.future[0];
    fallbackHistory = {
      past: [...fallbackHistory.past, current],
      future: fallbackHistory.future.slice(1),
    };
    if (typeof target.setMolecule === "function") {
      target.setMolecule(next);
    }
    lastSeenMol = next;
    bridgeRevision += 1;
    return true;
  }

  function getHistory() {
    if (typeof target.getHistory === "function") {
      return target.getHistory();
    }
    return fallbackHistory;
  }

  function canUndo() {
    if (typeof target.canUndo === "function") return Boolean(target.canUndo());
    const h = getHistory();
    return Array.isArray(h?.past) && h.past.length > 0;
  }

  function canRedo() {
    if (typeof target.canRedo === "function") return Boolean(target.canRedo());
    const h = getHistory();
    return Array.isArray(h?.future) && h.future.length > 0;
  }

  function buildMutationResponse({
    ok,
    action = "mutate_editor_structure",
    operation = null,
    actionId = null,
    status,
    rejected = false,
    needsApproval = false,
    cancelled = false,
    unavailable = false,
    validationFailed = false,
    interrupted = false,
    duplicate = false,
    actionState = null,
    revision = null,
    previousRevision = null,
    summary = "",
    validationErrors = [],
    error = undefined,
    errorType = undefined,
    failureCode = undefined,
    data = undefined,
    previousResult = undefined,
  }) {
    return {
      ok: Boolean(ok),
      action,
      operation,
      actionId,
      status,
      rejected: Boolean(rejected),
      needsApproval: Boolean(needsApproval),
      cancelled: Boolean(cancelled),
      unavailable: Boolean(unavailable),
      validationFailed: Boolean(validationFailed),
      interrupted: Boolean(interrupted),
      ...(duplicate ? { duplicate: true } : {}),
      ...(actionState ? { actionState } : {}),
      revision,
      previousRevision,
      summary,
      validationErrors: Array.isArray(validationErrors) ? validationErrors : [],
      ...(data !== undefined ? { data } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(errorType !== undefined ? { errorType } : {}),
      ...(failureCode !== undefined ? { failureCode } : {}),
      ...(previousResult !== undefined ? { previousResult } : {}),
    };
  }

  /**
   * Reads the current structure from the active editor.
   * Read-only: never modifies the editor state.
   */
  async function read_editor_structure() {
    try {
      if (!isReady()) {
        return {
          ok: false,
          action: "read_editor_structure",
          errorType: BRIDGE_ERROR_TYPES.EDITOR_UNAVAILABLE,
          error: "Editor is not currently ready or mounted.",
        };
      }

      const mol = typeof target.getMolecule === "function" ? target.getMolecule() : null;
      const rev = getRevision();
      const atoms = Array.isArray(mol?.atoms) ? mol.atoms : [];
      const bonds = Array.isArray(mol?.bonds) ? mol.bonds : [];
      const atomCount = atoms.length;
      const bondCount = bonds.length;
      const isEmpty = atomCount === 0;

      if (isEmpty) {
        return {
          ok: true,
          action: "read_editor_structure",
          data: {
            smiles: "",
            molfile: "",
            formula: "",
            weight: "",
            atomCount: 0,
            bondCount: 0,
            revision: rev,
            isEmpty: true,
            hasMolecule: false,
            graph: { atoms: [], bonds: [] },
            viewMode: getViewMode(),
          },
        };
      }

      // Non-empty structure: export SMILES, formula, and weight
      let exp = { smiles: "", molfile: "", formula: "", weight: "" };
      let exportError = null;

      try {
        if (typeof target.exportCurrent === "function") {
          exp = target.exportCurrent();
        } else {
          exp = exportStructure(mol);
        }
      } catch (err) {
        exportError = err?.message || "Failed to convert structure to SMILES.";
      }

      return {
        ok: true,
        action: "read_editor_structure",
        data: {
          smiles: exp.smiles || "",
          molfile: exp.molfile || "",
          formula: exp.formula || "",
          weight: exp.weight || "",
          atomCount,
          bondCount,
          revision: rev,
          isEmpty: false,
          hasMolecule: true,
          graph: serializeGraph(mol),
          conversionError: exportError,
          viewMode: getViewMode(),
        },
      };
    } catch (err) {
      return {
        ok: false,
        action: "read_editor_structure",
        errorType: BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED,
        error: err?.message || "Unexpected error while reading editor structure.",
      };
    }
  }

  /**
   * Loads a validated structure into the active editor.
   * Enforces validation before mutation and an explicit approval boundary
   * when replacing non-empty structures from external/AI callers.
   */
  async function load_structure_into_editor(input) {
    try {
      if (!isReady()) {
        return {
          ok: false,
          action: "load_structure_into_editor",
          errorType: BRIDGE_ERROR_TYPES.EDITOR_UNAVAILABLE,
          error: "Editor is not currently ready or mounted.",
        };
      }

      const params = typeof input === "string" ? { smiles: input } : (input || {});
      const rawSmiles = typeof params.smiles === "string" ? params.smiles.trim() : "";
      const source = params.source || "external";
      const requireApproval = params.requireApproval !== false;
      const preApproved = Boolean(params.approved);

      if (!rawSmiles) {
        return {
          ok: false,
          action: "load_structure_into_editor",
          errorType: BRIDGE_ERROR_TYPES.INVALID_STRUCTURE,
          error: "A non-empty SMILES string is required to load a structure.",
        };
      }

      // 1. Validate conversion using chemistry engine BEFORE modifying editor
      let parsedMol;
      try {
        parsedMol = molFromSmiles(rawSmiles);
        if (!parsedMol || !Array.isArray(parsedMol.atoms) || parsedMol.atoms.length === 0) {
          return {
            ok: false,
            action: "load_structure_into_editor",
            errorType: BRIDGE_ERROR_TYPES.INVALID_STRUCTURE,
            error: "The provided SMILES produced an empty structure with 0 atoms.",
            data: { candidateSmiles: rawSmiles },
          };
        }
      } catch (err) {
        return {
          ok: false,
          action: "load_structure_into_editor",
          errorType: BRIDGE_ERROR_TYPES.INVALID_STRUCTURE,
          error: `Invalid SMILES syntax: ${err?.message || "Failed to parse structure."}`,
          data: { candidateSmiles: rawSmiles },
        };
      }

      // 2. Safe Editing Boundary: check if canvas is currently non-empty
      const currentMol = typeof target.getMolecule === "function" ? target.getMolecule() : null;
      const currentAtomCount = Array.isArray(currentMol?.atoms) ? currentMol.atoms.length : 0;
      const isReplacingNonEmpty = currentAtomCount > 0;

      if (isReplacingNonEmpty && requireApproval && !preApproved) {
        // If an approval callback is provided on the target, solicit user confirmation
        if (typeof target.requestApproval === "function") {
          let userApproved = false;
          try {
            userApproved = await target.requestApproval({
              candidateSmiles: rawSmiles,
              currentAtomCount,
              source,
              parsedAtomCount: parsedMol.atoms.length,
            });
          } catch (apprErr) {
            return {
              ok: false,
              action: "load_structure_into_editor",
              errorType: BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED,
              error: `Approval request failed: ${apprErr?.message}`,
              needsApproval: true,
              data: { candidateSmiles: rawSmiles, currentAtomCount },
            };
          }

          if (!userApproved) {
            return {
              ok: false,
              action: "load_structure_into_editor",
              errorType: BRIDGE_ERROR_TYPES.REPLACEMENT_REJECTED,
              cancelled: true,
              needsApproval: true,
              error: "Structure replacement was declined by user.",
              data: { candidateSmiles: rawSmiles, currentAtomCount },
            };
          }
        } else {
          // No interactive approval callback available and not pre-approved: reject replacement safely
          return {
            ok: false,
            action: "load_structure_into_editor",
            errorType: BRIDGE_ERROR_TYPES.REPLACEMENT_REJECTED,
            needsApproval: true,
            error: "Replacing an existing drawn molecule requires explicit user approval.",
            data: { candidateSmiles: rawSmiles, currentAtomCount },
          };
        }
      }

      // 3. Apply structure to shared editor state
      if (typeof target.loadSmiles === "function" || typeof target.setMolecule === "function" || typeof target.commitMolecule === "function") {
        commitMoleculeToTarget(parsedMol, { viaLoadSmiles: typeof target.loadSmiles === "function" ? rawSmiles : null });
      } else {
        return {
          ok: false,
          action: "load_structure_into_editor",
          errorType: BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED,
          error: "Editor target does not support loading structures.",
        };
      }

      // 4. Center and frame the canvas
      let viewportResult = null;
      if (params.fitView !== false && typeof target.fitView === "function") {
        try {
          viewportResult = target.fitView();
        } catch {
          // best-effort viewport framing
        }
      }

      // 5. Verify and return structured result
      let exp = { smiles: rawSmiles, formula: "", weight: "" };
      try {
        exp = exportStructure(parsedMol);
      } catch {
        // fallback to input
      }

      return {
        ok: true,
        action: "load_structure_into_editor",
        data: {
          smiles: exp.smiles || rawSmiles,
          formula: exp.formula,
          weight: exp.weight,
          atomCount: parsedMol.atoms.length,
          bondCount: parsedMol.bonds.length,
          revision: getRevision(),
          viewMode: getViewMode(),
          viewport: viewportResult,
        },
      };
    } catch (err) {
      return {
        ok: false,
        action: "load_structure_into_editor",
        errorType: BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED,
        error: err?.message || "Unexpected error while loading structure into editor.",
      };
    }
  }

  /**
   * Controlled Transactional Structure Mutation Pipeline (Phase 3A).
   *
   * Execution sequence:
   *   1. Receive the mutation request.
   *   2. Check actionId idempotency & validate the request schema.
   *   3. Confirm that the editor is available.
   *   4. Confirm the expected structure revision.
   *   5. Resolve the target atoms or bonds.
   *   6. Create a safe proposed modification using the molecular engine.
   *   7. Validate the proposed molecular graph.
   *   8. Check chemical constraints (valence & OpenChemLib).
   *   9. Check user approval requirements if applicable.
   *  10. Commit the change through the shared molecular state manager & confirm readback.
   *  11. Return the verified result to the AI agent.
   */
  async function mutate_editor_structure(rawRequest, actionLabel = "mutate_editor_structure") {
    const candidateActionId =
      rawRequest && typeof rawRequest === "object"
        ? typeof rawRequest.actionId === "string" && rawRequest.actionId.trim()
          ? rawRequest.actionId.trim()
          : typeof rawRequest.arguments?.actionId === "string" && rawRequest.arguments.actionId.trim()
          ? rawRequest.arguments.actionId.trim()
          : null
        : null;
    const candidateOperation =
      rawRequest && typeof rawRequest === "object" && typeof rawRequest.operation === "string"
        ? rawRequest.operation.trim() || null
        : null;

    try {
      // Idempotency check if actionId is already known in the ledger
      if (candidateActionId && actionLedger.has(candidateActionId)) {
        const existing = actionLedger.get(candidateActionId);
        const curRev = isReady() ? getRevision() : existing.revision;

        if (existing.state === "in_progress") {
          return buildMutationResponse({
            ok: false,
            action: actionLabel,
            operation: candidateOperation,
            actionId: candidateActionId,
            status: "in_progress",
            actionState: "in_progress",
            duplicate: true,
            rejected: true,
            revision: curRev,
            previousRevision: curRev,
            summary: `Action "${candidateActionId}" is currently being processed.`,
            error: `Duplicate request rejected: action "${candidateActionId}" is already in progress.`,
            errorType: BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED,
            failureCode: MUTATION_FAILURE_CODES.ACTION_IN_PROGRESS,
          });
        }

        if (existing.state === "completed") {
          return buildMutationResponse({
            ok: false,
            action: actionLabel,
            operation: candidateOperation || existing.result?.operation,
            actionId: candidateActionId,
            status: "duplicate_completed",
            actionState: "completed",
            duplicate: true,
            rejected: true,
            revision: curRev,
            previousRevision: existing.revision,
            summary: `Action "${candidateActionId}" was already completed; duplicate execution prevented.`,
            error: `Duplicate request rejected: action "${candidateActionId}" was already executed and committed at revision ${existing.revision}.`,
            errorType: BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED,
            failureCode: MUTATION_FAILURE_CODES.DUPLICATE_ACTION,
            previousResult: existing.result,
          });
        }

        if (existing.state === "rejected") {
          return buildMutationResponse({
            ok: false,
            action: actionLabel,
            operation: candidateOperation || existing.result?.operation,
            actionId: candidateActionId,
            status: "duplicate_rejected",
            actionState: "rejected",
            duplicate: true,
            rejected: true,
            cancelled: Boolean(existing.result?.cancelled),
            needsApproval: Boolean(existing.result?.needsApproval),
            revision: curRev,
            previousRevision: existing.revision,
            summary: `Action "${candidateActionId}" was previously rejected; duplicate execution prevented.`,
            error: `Duplicate request rejected: action "${candidateActionId}" was already declined or rejected.`,
            errorType: BRIDGE_ERROR_TYPES.REPLACEMENT_REJECTED,
            failureCode: MUTATION_FAILURE_CODES.DUPLICATE_ACTION,
            previousResult: existing.result,
          });
        }

        return buildMutationResponse({
          ok: false,
          action: actionLabel,
          operation: candidateOperation || existing.result?.operation,
          actionId: candidateActionId,
          status: "duplicate_failed",
          actionState: "failed",
          duplicate: true,
          rejected: true,
          validationFailed: Boolean(existing.result?.validationFailed),
          revision: curRev,
          previousRevision: existing.revision,
          summary: `Action "${candidateActionId}" previously failed; duplicate execution prevented.`,
          validationErrors: existing.result?.validationErrors || [],
          error: `Duplicate request rejected: action "${candidateActionId}" previously failed (${existing.result?.error || "error"}).`,
          errorType: existing.result?.errorType || BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED,
          failureCode: MUTATION_FAILURE_CODES.DUPLICATE_ACTION,
          previousResult: existing.result,
        });
      }

      // Step 2: Validate mutation request schema
      const validationCheck = validateMutationRequest(rawRequest);
      if (!validationCheck.ok) {
        const curRev = isReady() ? getRevision() : null;
        const isChemValFailure = [
          MUTATION_FAILURE_CODES.INVALID_BOND_ORDER,
          MUTATION_FAILURE_CODES.SELF_BOND,
          MUTATION_FAILURE_CODES.DUPLICATE_BOND,
        ].includes(validationCheck.code);
        const failRes = buildMutationResponse({
          ok: false,
          action: actionLabel,
          operation: candidateOperation,
          actionId: candidateActionId,
          status: isChemValFailure ? "validation_failed" : "rejected",
          rejected: true,
          validationFailed: isChemValFailure,
          revision: curRev,
          previousRevision: curRev,
          summary: `Mutation request rejected: ${validationCheck.error}`,
          validationErrors: [validationCheck.error],
          error: validationCheck.error,
          errorType: isChemValFailure
            ? BRIDGE_ERROR_TYPES.INVALID_STRUCTURE
            : BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED,
          failureCode: validationCheck.code,
        });
        if (candidateActionId) {
          actionLedger.set(candidateActionId, {
            state: "failed",
            result: failRes,
            revision: curRev,
            timestamp: Date.now(),
          });
        }
        return failRes;
      }

      const req = validationCheck.normalized;

      // Step 3: Confirm editor availability
      if (!isReady() || typeof target.getMolecule !== "function") {
        return buildMutationResponse({
          ok: false,
          action: actionLabel,
          operation: req.operation,
          actionId: req.actionId,
          status: "editor_unavailable",
          unavailable: true,
          rejected: false,
          revision: null,
          previousRevision: null,
          summary: "Editor is not currently available or mounted.",
          validationErrors: [],
          error: "Editor is not currently ready or mounted.",
          errorType: BRIDGE_ERROR_TYPES.EDITOR_UNAVAILABLE,
          failureCode: MUTATION_FAILURE_CODES.EDITOR_UNAVAILABLE,
        });
      }

      // Step 4: Confirm expected structure revision
      const currentMol = target.getMolecule();
      const currentRevision = getRevision();

      if (req.expectedRevision !== undefined && req.expectedRevision !== currentRevision) {
        const staleMsg = `Stale structure revision: expected revision ${req.expectedRevision}, but current editor structure is at revision ${currentRevision}. Re-read the editor structure before mutating.`;
        const staleRes = buildMutationResponse({
          ok: false,
          action: actionLabel,
          operation: req.operation,
          actionId: req.actionId,
          status: "rejected",
          rejected: true,
          revision: currentRevision,
          previousRevision: currentRevision,
          summary: staleMsg,
          validationErrors: [staleMsg],
          error: staleMsg,
          errorType: BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED,
          failureCode: MUTATION_FAILURE_CODES.STALE_REVISION,
        });
        actionLedger.set(req.actionId, {
          state: "failed",
          result: staleRes,
          revision: currentRevision,
          timestamp: Date.now(),
        });
        return staleRes;
      }

      if (!currentMol || !Array.isArray(currentMol.atoms) || currentMol.atoms.length === 0) {
        const emptyMsg = "Cannot modify structure: the editor canvas is currently empty (0 atoms).";
        const emptyRes = buildMutationResponse({
          ok: false,
          action: actionLabel,
          operation: req.operation,
          actionId: req.actionId,
          status: "rejected",
          rejected: true,
          revision: currentRevision,
          previousRevision: currentRevision,
          summary: emptyMsg,
          validationErrors: [emptyMsg],
          error: emptyMsg,
          errorType: BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED,
          failureCode: MUTATION_FAILURE_CODES.EMPTY_CANVAS,
        });
        actionLedger.set(req.actionId, {
          state: "failed",
          result: emptyRes,
          revision: currentRevision,
          timestamp: Date.now(),
        });
        return emptyRes;
      }

      // Mark action as in_progress in the ledger before proposal & async approval
      actionLedger.set(req.actionId, {
        state: "in_progress",
        revision: currentRevision,
        timestamp: Date.now(),
      });

      // Keep a deep non-destructive snapshot of the current molecule
      const snapshotBefore = cloneMolecule(currentMol);

      // Steps 5, 6, 7 & 8: Resolve identities, propose graph edit via engine, and validate structure + valence
      let proposal = null;
      if (req.operation === "change_bond_order") {
        proposal = proposeBondOrderChange(snapshotBefore, req);
      }

      if (!proposal || !proposal.ok) {
        const errCode = proposal?.code || MUTATION_FAILURE_CODES.MALFORMED_ARGUMENTS;
        const isChemValidation = Boolean(
          proposal?.validationFailed ||
            [
              MUTATION_FAILURE_CODES.VALENCE_VIOLATION,
              MUTATION_FAILURE_CODES.SELF_BOND,
              MUTATION_FAILURE_CODES.DUPLICATE_BOND,
              MUTATION_FAILURE_CODES.INVALID_BOND_ORDER,
              "ocl_validation_failed",
              "ocl_conversion_failed",
            ].includes(errCode)
        );
        const errMsg = proposal?.error || "Proposed molecular modification failed validation.";
        const failRes = buildMutationResponse({
          ok: false,
          action: actionLabel,
          operation: req.operation,
          actionId: req.actionId,
          status: isChemValidation ? "validation_failed" : "rejected",
          rejected: true,
          validationFailed: isChemValidation,
          revision: currentRevision,
          previousRevision: currentRevision,
          summary: `Mutation failed: ${errMsg}`,
          validationErrors: proposal?.validationErrors || [errMsg],
          error: errMsg,
          errorType: isChemValidation
            ? BRIDGE_ERROR_TYPES.INVALID_STRUCTURE
            : BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED,
          failureCode: errCode,
        });
        actionLedger.set(req.actionId, {
          state: "failed",
          result: failRes,
          revision: currentRevision,
          timestamp: Date.now(),
        });
        return failRes;
      }

      // Step 8b: Approval check (when requireApproval is requested)
      if (req.requireApproval && !req.approved) {
        if (typeof target.requestApproval === "function") {
          let userApproved = false;
          try {
            userApproved = await target.requestApproval({
              actionId: req.actionId,
              operation: req.operation,
              summary: proposal.summary,
              candidateSmiles: proposal.validation.smiles,
              currentAtomCount: snapshotBefore.atoms.length,
              parsedAtomCount: proposal.proposedMol.atoms.length,
              source: req.source,
            });
          } catch (apprErr) {
            const intMsg = `Approval request was interrupted: ${apprErr?.message || "approval error"}`;
            const intRes = buildMutationResponse({
              ok: false,
              action: actionLabel,
              operation: req.operation,
              actionId: req.actionId,
              status: "interrupted",
              interrupted: true,
              needsApproval: true,
              revision: getRevision(),
              previousRevision: currentRevision,
              summary: intMsg,
              validationErrors: [],
              error: intMsg,
              errorType: BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED,
              failureCode: MUTATION_FAILURE_CODES.EXECUTION_INTERRUPTED,
            });
            actionLedger.set(req.actionId, {
              state: "failed",
              result: intRes,
              revision: getRevision(),
              timestamp: Date.now(),
            });
            return intRes;
          }

          if (!userApproved) {
            const declMsg = "Molecular modification was declined by user.";
            const rejRes = buildMutationResponse({
              ok: false,
              action: actionLabel,
              operation: req.operation,
              actionId: req.actionId,
              status: "rejected",
              rejected: true,
              cancelled: true,
              needsApproval: true,
              revision: getRevision(),
              previousRevision: currentRevision,
              summary: declMsg,
              validationErrors: [],
              error: declMsg,
              errorType: BRIDGE_ERROR_TYPES.REPLACEMENT_REJECTED,
              failureCode: MUTATION_FAILURE_CODES.APPROVAL_REJECTED,
            });
            actionLedger.set(req.actionId, {
              state: "rejected",
              result: rejRes,
              revision: getRevision(),
              timestamp: Date.now(),
            });
            return rejRes;
          }
        } else {
          const needApprMsg = "This molecular modification requires explicit user approval.";
          const rejRes = buildMutationResponse({
            ok: false,
            action: actionLabel,
            operation: req.operation,
            actionId: req.actionId,
            status: "rejected",
            rejected: true,
            needsApproval: true,
            revision: currentRevision,
            previousRevision: currentRevision,
            summary: needApprMsg,
            validationErrors: [],
            error: needApprMsg,
            errorType: BRIDGE_ERROR_TYPES.REPLACEMENT_REJECTED,
            failureCode: MUTATION_FAILURE_CODES.APPROVAL_REJECTED,
          });
          actionLedger.set(req.actionId, {
            state: "rejected",
            result: rejRes,
            revision: currentRevision,
            timestamp: Date.now(),
          });
          return rejRes;
        }
      }

      // Verify editor remained ready and revision did not drift while awaiting approval
      if (!isReady()) {
        const unavailAfterRes = buildMutationResponse({
          ok: false,
          action: actionLabel,
          operation: req.operation,
          actionId: req.actionId,
          status: "interrupted",
          interrupted: true,
          unavailable: true,
          revision: currentRevision,
          previousRevision: currentRevision,
          summary: "Editor became unavailable before the mutation could be committed.",
          validationErrors: [],
          error: "Editor became unavailable before the mutation could be committed.",
          errorType: BRIDGE_ERROR_TYPES.EDITOR_UNAVAILABLE,
          failureCode: MUTATION_FAILURE_CODES.EXECUTION_INTERRUPTED,
        });
        actionLedger.set(req.actionId, {
          state: "failed",
          result: unavailAfterRes,
          revision: currentRevision,
          timestamp: Date.now(),
        });
        return unavailAfterRes;
      }

      if (getRevision() !== currentRevision) {
        const driftMsg = "Canvas structure changed while awaiting confirmation; mutation aborted to prevent overwriting concurrent edits.";
        const driftRes = buildMutationResponse({
          ok: false,
          action: actionLabel,
          operation: req.operation,
          actionId: req.actionId,
          status: "interrupted",
          interrupted: true,
          rejected: true,
          revision: getRevision(),
          previousRevision: currentRevision,
          summary: driftMsg,
          validationErrors: [driftMsg],
          error: driftMsg,
          errorType: BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED,
          failureCode: MUTATION_FAILURE_CODES.STALE_REVISION,
        });
        actionLedger.set(req.actionId, {
          state: "failed",
          result: driftRes,
          revision: getRevision(),
          timestamp: Date.now(),
        });
        return driftRes;
      }

      // Step 9: Commit the validated structure through the shared state manager
      try {
        commitMoleculeToTarget(proposal.proposedMol);
      } catch (commitErr) {
        const commitMsg = `Failed to commit molecular modification: ${commitErr?.message || "commit error"}`;
        const intRes = buildMutationResponse({
          ok: false,
          action: actionLabel,
          operation: req.operation,
          actionId: req.actionId,
          status: "interrupted",
          interrupted: true,
          revision: getRevision(),
          previousRevision: currentRevision,
          summary: commitMsg,
          validationErrors: [],
          error: commitMsg,
          errorType: BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED,
          failureCode: MUTATION_FAILURE_CODES.EXECUTION_INTERRUPTED,
        });
        actionLedger.set(req.actionId, {
          state: "failed",
          result: intRes,
          revision: getRevision(),
          timestamp: Date.now(),
        });
        return intRes;
      }

      // Step 10: Read back and verify the committed structure from the editor
      const committedMol = target.getMolecule();
      const newRevision = getRevision();
      const committedBond = Array.isArray(committedMol?.bonds)
        ? committedMol.bonds.find((b) => b.id === proposal.mutatedBond.id)
        : null;

      if (
        !committedMol ||
        !committedBond ||
        committedBond.order !== proposal.mutatedBond.order ||
        committedMol.atoms.length !== proposal.proposedMol.atoms.length
      ) {
        // Rollback to snapshotBefore if readback does not match
        try {
          if (typeof target.setMolecule === "function") target.setMolecule(snapshotBefore);
        } catch {
          // ignore rollback error
        }
        const verifyMsg = "Editor readback verification failed: committed structure did not match the proposed modification.";
        const verifyFailRes = buildMutationResponse({
          ok: false,
          action: actionLabel,
          operation: req.operation,
          actionId: req.actionId,
          status: "interrupted",
          interrupted: true,
          revision: getRevision(),
          previousRevision: currentRevision,
          summary: verifyMsg,
          validationErrors: [verifyMsg],
          error: verifyMsg,
          errorType: BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED,
          failureCode: MUTATION_FAILURE_CODES.EXECUTION_INTERRUPTED,
        });
        actionLedger.set(req.actionId, {
          state: "failed",
          result: verifyFailRes,
          revision: getRevision(),
          timestamp: Date.now(),
        });
        return verifyFailRes;
      }

      // Step 11: Return the verified result
      const verifiedGraph = serializeGraph(committedMol);
      const successData = {
        actionId: req.actionId,
        operation: req.operation,
        revision: newRevision,
        previousRevision: currentRevision,
        summary: proposal.summary,
        smiles: proposal.validation.smiles,
        molfile: proposal.validation.molfile,
        formula: proposal.validation.formula,
        weight: proposal.validation.weight,
        atomCount: committedMol.atoms.length,
        bondCount: committedMol.bonds.length,
        graph: verifiedGraph,
        mutatedBond: proposal.mutatedBond,
        viewMode: getViewMode(),
      };

      const successRes = buildMutationResponse({
        ok: true,
        action: actionLabel,
        operation: req.operation,
        actionId: req.actionId,
        status: "committed",
        rejected: false,
        needsApproval: Boolean(req.requireApproval),
        cancelled: false,
        unavailable: false,
        validationFailed: false,
        interrupted: false,
        revision: newRevision,
        previousRevision: currentRevision,
        summary: proposal.summary,
        validationErrors: [],
        data: successData,
      });

      actionLedger.set(req.actionId, {
        state: "completed",
        result: successRes,
        revision: newRevision,
        timestamp: Date.now(),
      });

      return successRes;
    } catch (err) {
      const curRev = isReady() ? getRevision() : null;
      const unexpectedMsg = err?.message || "Unexpected error while executing molecular mutation.";
      const errRes = buildMutationResponse({
        ok: false,
        action: actionLabel,
        operation: candidateOperation,
        actionId: candidateActionId,
        status: "interrupted",
        interrupted: true,
        revision: curRev,
        previousRevision: curRev,
        summary: unexpectedMsg,
        validationErrors: [],
        error: unexpectedMsg,
        errorType: BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED,
        failureCode: MUTATION_FAILURE_CODES.EXECUTION_INTERRUPTED,
      });
      if (candidateActionId) {
        actionLedger.set(candidateActionId, {
          state: "failed",
          result: errRes,
          revision: curRev,
          timestamp: Date.now(),
        });
      }
      return errRes;
    }
  }

  /**
   * Executes a bond-order mutation (1 = single, 2 = double, 3 = triple) on an existing bond
   * identified by `bondId` or by endpoint atom IDs (`atomId1`, `atomId2`), delegating
   * through the centralized transactional `mutate_editor_structure` pipeline.
   */
  async function change_bond_order(params = {}) {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      return mutate_editor_structure(params, "change_bond_order");
    }
    const hasExplicitActionId = Object.prototype.hasOwnProperty.call(params, "actionId");
    const actionId = hasExplicitActionId ? params.actionId : `cb_auto_${++autoActionCounter}`;
    const operation = Object.prototype.hasOwnProperty.call(params, "operation")
      ? params.operation
      : "change_bond_order";

    return mutate_editor_structure(
      {
        ...params,
        actionId,
        operation,
      },
      "change_bond_order"
    );
  }

  /**
   * Fits and centers the canvas view around the current molecule.
   * Viewport only: never modifies the molecular data.
   */
  async function fit_canvas_view() {
    try {
      if (!isReady()) {
        return {
          ok: false,
          action: "fit_canvas_view",
          errorType: BRIDGE_ERROR_TYPES.EDITOR_UNAVAILABLE,
          error: "Editor is not currently ready or mounted.",
        };
      }

      let viewport = null;
      if (typeof target.fitView === "function") {
        viewport = target.fitView();
      } else if (typeof target.getMolecule === "function") {
        // Fallback computation using computeViewportTransform
        const mol = target.getMolecule();
        viewport = computeViewportTransform(mol, 800, 600);
      }

      return {
        ok: true,
        action: "fit_canvas_view",
        data: {
          viewMode: getViewMode(),
          viewport: viewport || null,
        },
      };
    } catch (err) {
      return {
        ok: false,
        action: "fit_canvas_view",
        errorType: BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED,
        error: err?.message || "Unexpected error while fitting canvas view.",
      };
    }
  }

  /**
   * Inspects and returns the capabilities of the active editor.
   */
  async function get_editor_capabilities() {
    return {
      ok: true,
      action: "get_editor_capabilities",
      data: {
        viewMode: getViewMode(),
        isReady: isReady(),
        revision: isReady() ? getRevision() : null,
        canRead: typeof target.getMolecule === "function" || typeof target.exportCurrent === "function",
        canLoad: typeof target.loadSmiles === "function" || typeof target.setMolecule === "function",
        canMutate:
          typeof target.commitMolecule === "function" ||
          typeof target.setMolecule === "function" ||
          typeof target.loadSmiles === "function",
        canFitView: typeof target.fitView === "function",
        requiresApprovalOnReplace: true,
        supportedActions: [...ALLOWED_BRIDGE_ACTIONS],
        supportedMutations: [...ALLOWED_MUTATION_OPERATIONS],
      },
    };
  }

  /**
   * Unified dispatcher: executes an allowlisted bridge action with parameter validation.
   * Rejects any unlisted action to prevent arbitrary instruction execution.
   */
  async function executeAction(actionName, params = {}) {
    if (typeof actionName !== "string" || !ALLOWED_BRIDGE_ACTIONS.includes(actionName)) {
      return {
        ok: false,
        action: String(actionName || "unknown"),
        errorType: BRIDGE_ERROR_TYPES.EDITOR_OPERATION_FAILED,
        error: `Action "${String(actionName)}" is not a supported editor bridge operation. Supported: ${ALLOWED_BRIDGE_ACTIONS.join(", ")}`,
      };
    }

    switch (actionName) {
      case "read_editor_structure":
        return read_editor_structure();
      case "load_structure_into_editor":
        return load_structure_into_editor(params);
      case "fit_canvas_view":
        return fit_canvas_view();
      case "get_editor_capabilities":
        return get_editor_capabilities();
      case "change_bond_order":
        return change_bond_order(params);
      case "mutate_editor_structure":
        return mutate_editor_structure(params, "mutate_editor_structure");
      default:
        return {
          ok: false,
          action: actionName,
          error: `Unhandled action "${actionName}".`,
        };
    }
  }

  return Object.freeze({
    read_editor_structure,
    load_structure_into_editor,
    fit_canvas_view,
    get_editor_capabilities,
    change_bond_order,
    mutate_editor_structure,
    executeMutation: mutate_editor_structure,
    executeAction,
    getRevision,
    getActionStatus,
    undo,
    redo,
    canUndo,
    canRedo,
    getHistory,
    getViewMode,
    isReady,
  });
}

// -----------------------------------------------------------------------------
// Controlled Active Bridge Registry
// Accessible to trusted frontend components (e.g. Chat, Editor, AI handshake)
// -----------------------------------------------------------------------------

let currentActiveBridge = null;
const listeners = new Set();

/**
 * Registers the active editor bridge instance from the mounted Editor.
 * Returns an unregister function.
 */
export function registerEditorBridge(bridge) {
  currentActiveBridge = bridge;
  listeners.forEach((fn) => {
    try {
      fn(bridge);
    } catch {
      // ignore listener errors
    }
  });

  return () => {
    if (currentActiveBridge === bridge) {
      currentActiveBridge = null;
      listeners.forEach((fn) => {
        try {
          fn(null);
        } catch {
          // ignore
        }
      });
    }
  };
}

/**
 * Returns the currently active editor bridge, or null if no editor is mounted.
 */
export function getActiveEditorBridge() {
  return currentActiveBridge;
}

/**
 * Subscribes to changes in active editor bridge availability.
 */
export function subscribeToEditorBridge(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
