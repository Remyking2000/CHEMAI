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
} from "./moleculeEngine.js";

export const ALLOWED_BRIDGE_ACTIONS = Object.freeze([
  "read_editor_structure",
  "load_structure_into_editor",
  "fit_canvas_view",
  "get_editor_capabilities",
]);

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
export function createEditorBridge(target) {
  if (!target || typeof target !== "object") {
    throw new Error("createEditorBridge requires a valid target adapter object.");
  }

  const getViewMode = () => (typeof target.getViewMode === "function" ? target.getViewMode() : "unknown");
  const isReady = () => (typeof target.isReady === "function" ? Boolean(target.isReady()) : true);

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
          error: "Editor is not currently ready or mounted.",
        };
      }

      const mol = typeof target.getMolecule === "function" ? target.getMolecule() : null;
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
          isEmpty: false,
          hasMolecule: true,
          graph: {
            atoms: atoms.map((a) => ({ id: a.id, element: a.element, x: a.x, y: a.y, charge: a.charge || 0 })),
            bonds: bonds.map((b) => ({ id: b.id, a1: b.a1, a2: b.a2, order: b.order })),
          },
          conversionError: exportError,
          viewMode: getViewMode(),
        },
      };
    } catch (err) {
      return {
        ok: false,
        action: "read_editor_structure",
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
            error: "The provided SMILES produced an empty structure with 0 atoms.",
            data: { candidateSmiles: rawSmiles },
          };
        }
      } catch (err) {
        return {
          ok: false,
          action: "load_structure_into_editor",
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
              error: `Approval request failed: ${apprErr?.message}`,
              needsApproval: true,
              data: { candidateSmiles: rawSmiles, currentAtomCount },
            };
          }

          if (!userApproved) {
            return {
              ok: false,
              action: "load_structure_into_editor",
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
            needsApproval: true,
            error: "Replacing an existing drawn molecule requires explicit user approval.",
            data: { candidateSmiles: rawSmiles, currentAtomCount },
          };
        }
      }

      // 3. Apply structure to shared editor state
      if (typeof target.loadSmiles === "function") {
        target.loadSmiles(rawSmiles);
      } else if (typeof target.setMolecule === "function") {
        target.setMolecule(parsedMol);
      } else {
        return {
          ok: false,
          action: "load_structure_into_editor",
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
          viewMode: getViewMode(),
          viewport: viewportResult,
        },
      };
    } catch (err) {
      return {
        ok: false,
        action: "load_structure_into_editor",
        error: err?.message || "Unexpected error while loading structure into editor.",
      };
    }
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
        canRead: typeof target.getMolecule === "function" || typeof target.exportCurrent === "function",
        canLoad: typeof target.loadSmiles === "function" || typeof target.setMolecule === "function",
        canFitView: typeof target.fitView === "function",
        requiresApprovalOnReplace: true,
        supportedActions: [...ALLOWED_BRIDGE_ACTIONS],
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
    executeAction,
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
