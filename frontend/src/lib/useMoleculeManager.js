import { useState, useRef, useCallback } from "react";
import {
  EMPTY_MOL,
  molFromSmiles,
  molFromMolfile,
  exportStructure,
  reseedIds,
  createMoleculeStateManager,
} from "./moleculeEngine.js";

export { createMoleculeStateManager };

/**
 * useMoleculeManager
 * Authoritative shared React hook managing molecule data, undo/redo history,
 * monotonic structure revision, and SMILES/Molfile loading and exporting
 * across Desktop and Mobile views.
 */
export function useMoleculeManager(initialMol = null, initialSmiles = null) {
  const [mol, setMolState] = useState(() => {
    if (initialMol && Array.isArray(initialMol.atoms) && initialMol.atoms.length > 0) {
      reseedIds(initialMol);
      return initialMol;
    }
    if (initialSmiles && typeof initialSmiles === "string" && initialSmiles.trim()) {
      try {
        return molFromSmiles(initialSmiles.trim());
      } catch (e) {
        console.warn("Could not parse initialSmiles in useMoleculeManager:", e);
      }
    }
    // Start with a clean, empty canvas by default
    return EMPTY_MOL;
  });

  const molRef = useRef(mol);

  const setMol = useCallback((next) => {
    const resolved = typeof next === "function" ? next(molRef.current) : next;
    molRef.current = resolved;
    setMolState(resolved);
  }, []);

  const [history, setHistory] = useState({ past: [], future: [] });
  const historyRef = useRef(history);

  const [revision, setRevision] = useState(1);
  const revisionRef = useRef(revision);

  const [loadVersion, setLoadVersion] = useState(0);

  const pushState = useCallback((newMol) => {
    if (!newMol || typeof newMol !== "object" || !Array.isArray(newMol.atoms) || !Array.isArray(newMol.bonds)) {
      return molRef.current;
    }
    const current = molRef.current;
    if (current === newMol) return current;
    reseedIds(newMol);
    const nextHistory = {
      past: [...historyRef.current.past.slice(-35), current],
      future: [],
    };
    historyRef.current = nextHistory;
    molRef.current = newMol;
    revisionRef.current += 1;
    setMolState(newMol);
    setHistory(nextHistory);
    setRevision(revisionRef.current);
    return newMol;
  }, []);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.past.length === 0) return false;
    const previous = h.past[h.past.length - 1];
    const newPast = h.past.slice(0, -1);
    const nextHistory = { past: newPast, future: [molRef.current, ...h.future] };
    historyRef.current = nextHistory;
    molRef.current = previous;
    revisionRef.current += 1;
    setMolState(previous);
    setHistory(nextHistory);
    setRevision(revisionRef.current);
    return true;
  }, []);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.future.length === 0) return false;
    const next = h.future[0];
    const newFuture = h.future.slice(1);
    const nextHistory = { past: [...h.past, molRef.current], future: newFuture };
    historyRef.current = nextHistory;
    molRef.current = next;
    revisionRef.current += 1;
    setMolState(next);
    setHistory(nextHistory);
    setRevision(revisionRef.current);
    return true;
  }, []);

  const clear = useCallback(() => {
    pushState(EMPTY_MOL);
    setLoadVersion((v) => v + 1);
  }, [pushState]);

  const loadSmiles = useCallback((smiles) => {
    if (!smiles || !smiles.trim()) {
      pushState(EMPTY_MOL);
      setLoadVersion((v) => v + 1);
      return;
    }
    const newM = molFromSmiles(smiles.trim());
    pushState(newM);
    setLoadVersion((v) => v + 1);
  }, [pushState]);

  const loadMolfile = useCallback((molfile) => {
    if (!molfile || !molfile.trim()) {
      pushState(EMPTY_MOL);
      setLoadVersion((v) => v + 1);
      return;
    }
    const newM = molFromMolfile(molfile.trim());
    pushState(newM);
    setLoadVersion((v) => v + 1);
  }, [pushState]);

  const exportCurrent = useCallback(() => {
    if (!molRef.current || !molRef.current.atoms || !molRef.current.atoms.length) {
      return { smiles: "", molfile: "", formula: "", weight: "", atomCount: 0, bondCount: 0 };
    }
    try {
      const exp = exportStructure(molRef.current);
      return {
        ...exp,
        atomCount: molRef.current.atoms.length,
        bondCount: molRef.current.bonds.length,
      };
    } catch (e) {
      console.warn("Export error in useMoleculeManager:", e);
      return { smiles: "", molfile: "", formula: "", weight: "", atomCount: molRef.current.atoms.length, bondCount: molRef.current.bonds.length };
    }
  }, []);

  return {
    mol,
    setMol,
    molRef,
    history,
    historyRef,
    revision,
    revisionRef,
    loadVersion,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    pushState,
    undo,
    redo,
    clear,
    loadSmiles,
    loadMolfile,
    exportCurrent,
  };
}
