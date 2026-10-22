import { useState, useRef, useCallback } from "react";
import {
  EMPTY_MOL,
  molFromSmiles,
  molFromMolfile,
  exportStructure,
  reseedIds,
} from "./moleculeEngine";

/**
 * useMoleculeManager
 * Authoritative shared React hook managing molecule data, undo/redo history,
 * SMILES/Molfile loading and exporting across Desktop and Mobile views.
 */
export function useMoleculeManager(initialMol = null, initialSmiles = null) {
  const [mol, setMol] = useState(() => {
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
  molRef.current = mol;

  const [history, setHistory] = useState({ past: [], future: [] });
  const [loadVersion, setLoadVersion] = useState(0);

  const pushState = useCallback((newMol) => {
    setMol((current) => {
      if (current === newMol) return current;
      setHistory((h) => ({
        past: [...h.past.slice(-35), current],
        future: [],
      }));
      return newMol;
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.past.length === 0) return h;
      const previous = h.past[h.past.length - 1];
      const newPast = h.past.slice(0, -1);
      setMol(previous);
      return { past: newPast, future: [molRef.current, ...h.future] };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((h) => {
      if (h.future.length === 0) return h;
      const next = h.future[0];
      const newFuture = h.future.slice(1);
      setMol(next);
      return { past: [...h.past, molRef.current], future: newFuture };
    });
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
