/**
 * ChemAI Shared Molecular Editing Engine
 * Authoritative data model and chemical manipulation functions for Desktop and Mobile.
 */
export * from "./mobileMolecule.js";
import {
  EMPTY_MOL,
  molFromSmiles,
  molFromMolfile,
  exportStructure,
  reseedIds,
} from "./mobileMolecule.js";

/**
 * Creates a standalone shared molecule state & history manager with monotonic revision tracking.
 * Used by both `useMoleculeManager` and programmatic/automated tests to guarantee identical
 * history, undo/redo, and revision semantics across Desktop and Mobile.
 */
export function createMoleculeStateManager(initialMol = null, initialSmiles = null) {
  let currentMol = EMPTY_MOL;
  if (initialMol && Array.isArray(initialMol.atoms) && initialMol.atoms.length > 0) {
    reseedIds(initialMol);
    currentMol = initialMol;
  } else if (initialSmiles && typeof initialSmiles === "string" && initialSmiles.trim()) {
    try {
      currentMol = molFromSmiles(initialSmiles.trim());
    } catch (e) {
      console.warn("Could not parse initialSmiles in createMoleculeStateManager:", e);
    }
  }

  let history = { past: [], future: [] };
  let revision = 1;
  let loadVersion = 0;

  const pushState = (newMol) => {
    if (!newMol || typeof newMol !== "object" || !Array.isArray(newMol.atoms) || !Array.isArray(newMol.bonds)) {
      return currentMol;
    }
    if (currentMol === newMol) return currentMol;
    reseedIds(newMol);
    history = {
      past: [...history.past.slice(-35), currentMol],
      future: [],
    };
    currentMol = newMol;
    revision += 1;
    return currentMol;
  };

  const undo = () => {
    if (history.past.length === 0) return false;
    const previous = history.past[history.past.length - 1];
    const newPast = history.past.slice(0, -1);
    history = {
      past: newPast,
      future: [currentMol, ...history.future],
    };
    currentMol = previous;
    revision += 1;
    return true;
  };

  const redo = () => {
    if (history.future.length === 0) return false;
    const next = history.future[0];
    const newFuture = history.future.slice(1);
    history = {
      past: [...history.past, currentMol],
      future: newFuture,
    };
    currentMol = next;
    revision += 1;
    return true;
  };

  const clear = () => {
    pushState(EMPTY_MOL);
    loadVersion += 1;
  };

  const loadSmiles = (smiles) => {
    if (!smiles || !smiles.trim()) {
      pushState(EMPTY_MOL);
      loadVersion += 1;
      return;
    }
    const newM = molFromSmiles(smiles.trim());
    pushState(newM);
    loadVersion += 1;
  };

  const loadMolfile = (molfile) => {
    if (!molfile || !molfile.trim()) {
      pushState(EMPTY_MOL);
      loadVersion += 1;
      return;
    }
    const newM = molFromMolfile(molfile.trim());
    pushState(newM);
    loadVersion += 1;
  };

  const exportCurrent = () => {
    if (!currentMol || !currentMol.atoms || !currentMol.atoms.length) {
      return { smiles: "", molfile: "", formula: "", weight: "", atomCount: 0, bondCount: 0 };
    }
    try {
      const exp = exportStructure(currentMol);
      return {
        ...exp,
        atomCount: currentMol.atoms.length,
        bondCount: currentMol.bonds.length,
      };
    } catch (e) {
      console.warn("Export error in createMoleculeStateManager:", e);
      return {
        smiles: "",
        molfile: "",
        formula: "",
        weight: "",
        atomCount: currentMol.atoms.length,
        bondCount: currentMol.bonds.length,
      };
    }
  };

  return {
    getMolecule: () => currentMol,
    getRevision: () => revision,
    getHistory: () => history,
    getLoadVersion: () => loadVersion,
    canUndo: () => history.past.length > 0,
    canRedo: () => history.future.length > 0,
    pushState,
    commitMolecule: pushState,
    setMolecule: pushState,
    undo,
    redo,
    clear,
    loadSmiles,
    loadMolfile,
    exportCurrent,
  };
}
