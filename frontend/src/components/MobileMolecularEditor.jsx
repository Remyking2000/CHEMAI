import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import PropTypes from "prop-types";
import {
  BOND_LEN,
  EMPTY_MOL,
  COMMON_ELEMENTS,
  ALL_ELEMENTS,
  ELEMENT_COLORS,
  getAtom,
  findAtomNear,
  distToSegment,
  addAtom,
  setBondOrder,
  setAtomElement,
  removeAtom,
  removeBond,
  moveAtoms,
  addSubstituent,
  drawBondTo,
  previewBondEnd,
  placeRing,
  toOCL,
  exportStructure,
  molFromSmiles,
  valenceMap,
  implicitHydrogens,
  isOvervalent,
} from "../lib/mobileMolecule";
import { ChemAINeuralHexIcon } from "./ChemAIIcons";

/**
 * MobileMolecularEditor
 *
 * Touch-first molecular drawing editor designed specifically for smartphones
 * and narrow viewports (< 768px). Reuses OpenChemLib for structure validation,
 * SMILES export, and formula calculation, seamlessly integrating with CHEMAI's
 * existing PubChem identification and AI analysis workflows.
 */
export default function MobileMolecularEditor({
  initialMol = null,
  initialSmiles = null,
  onIdentify,
  identifyLoading = false,
  onOpenChat,
  onSwitchToDesktop,
  onSearchCandidate,
  onStructureChange,
  className = "",
}) {
  // ---------------------------------------------------------------------------
  // Molecule & History State
  // ---------------------------------------------------------------------------
  const [mol, setMol] = useState(() => {
    if (initialMol && Array.isArray(initialMol.atoms) && initialMol.atoms.length > 0) {
      return initialMol;
    }
    if (initialSmiles && typeof initialSmiles === "string" && initialSmiles.trim()) {
      try {
        return molFromSmiles(initialSmiles.trim());
      } catch (e) {
        console.warn("Could not parse initialSmiles for mobile editor:", e);
      }
    }
    return EMPTY_MOL;
  });

  const [history, setHistory] = useState({ past: [], future: [] });

  // Commit changes to molecule state with history tracking
  const pushState = useCallback(
    (newMol) => {
      setMol((current) => {
        if (current === newMol) return current;
        setHistory((h) => ({
          past: [...h.past.slice(-25), current],
          future: [],
        }));
        if (onStructureChange) {
          try {
            onStructureChange(newMol);
          } catch (err) {
            console.error("onStructureChange error:", err);
          }
        }
        return newMol;
      });
    },
    [onStructureChange]
  );

  // Undo / Redo
  const handleUndo = useCallback(() => {
    setHistory((h) => {
      if (h.past.length === 0) return h;
      const previous = h.past[h.past.length - 1];
      const newPast = h.past.slice(0, -1);
      setMol(previous);
      if (onStructureChange) onStructureChange(previous);
      return {
        past: newPast,
        future: [mol, ...h.future],
      };
    });
  }, [mol, onStructureChange]);

  const handleRedo = useCallback(() => {
    setHistory((h) => {
      if (h.future.length === 0) return h;
      const next = h.future[0];
      const newFuture = h.future.slice(1);
      setMol(next);
      if (onStructureChange) onStructureChange(next);
      return {
        past: [...h.past, mol],
        future: newFuture,
      };
    });
  }, [mol, onStructureChange]);

  // Synchronize when initialSmiles or initialMol changes externally
  useEffect(() => {
    if (initialSmiles && typeof initialSmiles === "string") {
      try {
        const loaded = molFromSmiles(initialSmiles.trim());
        setMol(loaded);
        setHistory({ past: [], future: [] });
      } catch (err) {
        console.warn("Could not load external initialSmiles:", err);
      }
    }
  }, [initialSmiles]);

  // ---------------------------------------------------------------------------
  // Tool Selection & Configuration
  // ---------------------------------------------------------------------------
  // Tools: "bond" | "select" | "erase" | "ring"
  const [activeTool, setActiveTool] = useState("bond");
  const [bondOrder, setBondOrderState] = useState(1); // 1, 2, or 3
  const [activeElement, setActiveElement] = useState("C");
  const [activeRing, setActiveRing] = useState(6); // 3, 4, 5, 6, "benzene"
  const [selectedAtomId, setSelectedAtomId] = useState(null);
  const [selectedBondId, setSelectedBondId] = useState(null);

  // Drawers & Modals
  const [showElementDrawer, setShowElementDrawer] = useState(false);
  const [showRingDrawer, setShowRingDrawer] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [elementSearchQuery, setElementSearchQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState(null);
  const [searchError, setSearchError] = useState(null);

  // Toast / Status banner
  const [toastMsg, setToastMsg] = useState("");
  const toastTimerRef = useRef(null);
  const showToast = (msg) => {
    setToastMsg(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMsg(""), 3000);
  };

  // ---------------------------------------------------------------------------
  // Canvas Viewport (Pan & Zoom)
  // ---------------------------------------------------------------------------
  const svgRef = useRef(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [viewportSize, setViewportSize] = useState({ width: 360, height: 420 });

  // Update viewport dimensions on mount & window resize / orientation change
  useEffect(() => {
    const updateSize = () => {
      if (svgRef.current) {
        const rect = svgRef.current.getBoundingClientRect();
        setViewportSize({
          width: Math.max(rect.width, 280),
          height: Math.max(rect.height, 320),
        });
      }
    };
    updateSize();
    window.addEventListener("resize", updateSize);
    window.addEventListener("orientationchange", updateSize);
    return () => {
      window.removeEventListener("resize", updateSize);
      window.removeEventListener("orientationchange", updateSize);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // Screen (clientX, clientY) -> Molecule World Coordinates
  const screenToWorld = useCallback(
    (clientX, clientY) => {
      if (!svgRef.current) return { x: 0, y: 0 };
      const rect = svgRef.current.getBoundingClientRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      return {
        x: (sx - cx - pan.x) / zoom,
        y: (sy - cy - pan.y) / zoom,
      };
    },
    [pan, zoom]
  );

  // Fit / Recenter molecule to canvas
  const handleFitToScreen = useCallback(() => {
    if (!mol.atoms.length) {
      setPan({ x: 0, y: 0 });
      setZoom(1);
      return;
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const a of mol.atoms) {
      minX = Math.min(minX, a.x);
      maxX = Math.max(maxX, a.x);
      minY = Math.min(minY, a.y);
      maxY = Math.max(maxY, a.y);
    }
    const molWidth = maxX - minX + BOND_LEN * 2;
    const molHeight = maxY - minY + BOND_LEN * 2;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    const availableW = viewportSize.width * 0.85;
    const availableH = viewportSize.height * 0.85;
    const newZoom = Math.min(
      Math.max(0.6, Math.min(availableW / (molWidth || 1), availableH / (molHeight || 1))),
      1.8
    );
    setZoom(newZoom);
    setPan({ x: -centerX * newZoom, y: -centerY * newZoom });
    showToast("Fitted molecule to canvas");
  }, [mol, viewportSize]);

  const handleZoom = (factor) => {
    setZoom((z) => Math.min(2.5, Math.max(0.4, z * factor)));
  };

  // ---------------------------------------------------------------------------
  // Touch & Pointer Gesture Tracking
  // ---------------------------------------------------------------------------
  const gestureRef = useRef({
    activePointers: new Map(), // pointerId -> { clientX, clientY }
    dragType: null, // "move_atom" | "draw_bond" | "pan"
    startAtomId: null,
    dragged: false,
    startWorld: null,
    currentWorld: null,
    initialPan: null,
    initialDistance: 0,
    initialZoom: 1,
  });

  const [dragPreview, setDragPreview] = useState(null); // { from: {x,y}, to: {x,y}, targetAtomId }

  const handlePointerDown = (e) => {
    if (e.target.closest("button") || e.target.closest("input")) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    const g = gestureRef.current;
    g.activePointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

    // Multi-touch: 2 fingers -> Pinch to zoom & pan
    if (g.activePointers.size === 2) {
      const pts = Array.from(g.activePointers.values());
      g.dragType = "pinch";
      g.initialDistance = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
      g.initialZoom = zoom;
      g.initialPan = { ...pan };
      setDragPreview(null);
      return;
    }

    if (g.activePointers.size > 2) return;

    // Single touch interaction
    const world = screenToWorld(e.clientX, e.clientY);
    g.dragged = false;
    g.startWorld = world;
    g.currentWorld = world;

    const hitAtom = findAtomNear(mol, world.x, world.y, BOND_LEN * 0.45);
    let hitBond = null;
    if (!hitAtom) {
      for (const b of mol.bonds) {
        const A = getAtom(mol, b.a);
        const B = getAtom(mol, b.b);
        if (A && B && distToSegment(world.x, world.y, A.x, A.y, B.x, B.y) < BOND_LEN * 0.35) {
          hitBond = b;
          break;
        }
      }
    }

    if (activeTool === "erase") {
      if (hitAtom) {
        pushState(removeAtom(mol, hitAtom.id));
        showToast(`Erased atom ${hitAtom.el}`);
      } else if (hitBond) {
        pushState(removeBond(mol, hitBond.id));
        showToast("Erased bond");
      }
      g.dragType = null;
      return;
    }

    if (activeTool === "ring") {
      if (hitAtom) {
        const isBenzene = activeRing === "benzene";
        pushState(placeRing(mol, isBenzene ? 6 : activeRing, { type: "atom", id: hitAtom.id }, isBenzene));
        showToast(`Attached ${isBenzene ? "benzene ring" : `${activeRing}-membered ring`}`);
      } else if (hitBond) {
        const isBenzene = activeRing === "benzene";
        pushState(placeRing(mol, isBenzene ? 6 : activeRing, { type: "bond", id: hitBond.id }, isBenzene));
        showToast(`Fused ${isBenzene ? "benzene ring" : `${activeRing}-membered ring`}`);
      } else {
        const isBenzene = activeRing === "benzene";
        pushState(placeRing(mol, isBenzene ? 6 : activeRing, { type: "point", x: world.x, y: world.y }, isBenzene));
        showToast(`Placed ${isBenzene ? "benzene ring" : `${activeRing}-membered ring`}`);
      }
      g.dragType = null;
      return;
    }

    if (activeTool === "select") {
      if (hitAtom) {
        setSelectedAtomId(hitAtom.id);
        setSelectedBondId(null);
        g.dragType = "move_atom";
        g.startAtomId = hitAtom.id;
      } else if (hitBond) {
        setSelectedBondId(hitBond.id);
        setSelectedAtomId(null);
        g.dragType = null;
      } else {
        setSelectedAtomId(null);
        setSelectedBondId(null);
        g.dragType = "pan";
        g.initialPan = { ...pan };
      }
      return;
    }

    // Default tool: "bond"
    if (hitAtom) {
      setSelectedAtomId(hitAtom.id);
      g.dragType = "draw_bond";
      g.startAtomId = hitAtom.id;
    } else if (hitBond) {
      // Tap bond in bond tool: cycle bond order (1 -> 2 -> 3 -> 1)
      const nextOrder = hitBond.order === 3 ? 1 : hitBond.order + 1;
      pushState(setBondOrder(mol, hitBond.id, nextOrder));
      showToast(`Changed to ${nextOrder === 1 ? "single" : nextOrder === 2 ? "double" : "triple"} bond`);
      g.dragType = null;
    } else {
      if (mol.atoms.length === 0) {
        // First tap on empty canvas adds a starter atom
        const { mol: nextM, id } = addAtom(mol, world.x, world.y, activeElement);
        pushState(nextM);
        setSelectedAtomId(id);
        showToast(`Added ${activeElement} atom`);
      } else {
        g.dragType = "pan";
        g.initialPan = { ...pan };
      }
    }
  };

  const handlePointerMove = (e) => {
    const g = gestureRef.current;
    if (!g.activePointers.has(e.pointerId)) return;
    g.activePointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

    // Multi-touch pinch zoom & pan
    if (g.dragType === "pinch" && g.activePointers.size === 2) {
      const pts = Array.from(g.activePointers.values());
      const currentDist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
      if (g.initialDistance > 0) {
        const factor = currentDist / g.initialDistance;
        const newZoom = Math.min(2.5, Math.max(0.4, g.initialZoom * factor));
        setZoom(newZoom);
      }
      return;
    }

    const world = screenToWorld(e.clientX, e.clientY);
    g.currentWorld = world;

    if (!g.startWorld) return;
    const distTraveled = Math.hypot(world.x - g.startWorld.x, world.y - g.startWorld.y);
    if (distTraveled > 5 / zoom) {
      g.dragged = true;
    }

    if (g.dragType === "pan" && g.initialPan) {
      const dx = (world.x - g.startWorld.x) * zoom;
      const dy = (world.y - g.startWorld.y) * zoom;
      setPan({ x: g.initialPan.x + dx, y: g.initialPan.y + dy });
    } else if (g.dragType === "move_atom" && g.startAtomId != null) {
      const atom = getAtom(mol, g.startAtomId);
      if (atom) {
        const nextM = moveAtoms(mol, [atom.id], world.x - atom.x, world.y - atom.y);
        setMol(nextM);
      }
    } else if (g.dragType === "draw_bond" && g.startAtomId != null) {
      const atom = getAtom(mol, g.startAtomId);
      if (atom) {
        const snappedEnd = previewBondEnd(mol, atom, world, atom.id);
        const target = findAtomNear(mol, world.x, world.y, BOND_LEN * 0.45, [atom.id]);
        setDragPreview({
          from: { x: atom.x, y: atom.y },
          to: snappedEnd,
          targetAtomId: target ? target.id : null,
        });
      }
    }
  };

  const handlePointerUp = (e) => {
    const g = gestureRef.current;
    if (g.activePointers.has(e.pointerId)) {
      g.activePointers.delete(e.pointerId);
    }

    if (g.dragType === "move_atom" && g.startAtomId != null && g.dragged) {
      pushState(mol);
    } else if (g.dragType === "draw_bond" && g.startAtomId != null) {
      const atom = getAtom(mol, g.startAtomId);
      if (atom) {
        if (g.dragged && g.currentWorld) {
          // Dragged to create bond
          const nextM = drawBondTo(mol, atom.id, atom, g.currentWorld, bondOrder);
          pushState(nextM);
          showToast(`Created ${bondOrder === 1 ? "single" : bondOrder === 2 ? "double" : "triple"} bond`);
        } else {
          // Single tap on atom in bond tool:
          // If activeElement is not "C", change atom's element!
          if (activeElement !== "C" && atom.el !== activeElement) {
            pushState(setAtomElement(mol, atom.id, activeElement));
            showToast(`Changed atom to ${activeElement}`);
          } else {
            // Sprout a new bond in the best open direction (120 degree zig-zag)
            const nextM = addSubstituent(mol, atom.id, activeElement, bondOrder);
            pushState(nextM);
            showToast("Added substituent bond");
          }
        }
      }
    }

    setDragPreview(null);
    if (g.activePointers.size === 0) {
      g.dragType = null;
      g.startAtomId = null;
      g.dragged = false;
    }
  };

  // ---------------------------------------------------------------------------
  // Action Handlers (Clear, Identify, Search)
  // ---------------------------------------------------------------------------
  const handleClearCanvas = () => {
    pushState(EMPTY_MOL);
    setSelectedAtomId(null);
    setSelectedBondId(null);
    setShowClearConfirm(false);
    showToast("Canvas cleared");
  };

  const handleAnalyzeClick = () => {
    if (mol.atoms.length === 0) {
      showToast("Canvas is empty. Draw a structure before analyzing!");
      return;
    }
    if (onIdentify) {
      try {
        const exported = exportStructure(mol);
        onIdentify(exported);
      } catch (err) {
        console.error("Structure export failed:", err);
        showToast("Structure could not be converted: " + (err?.message || err));
      }
    }
  };

  // Element Selection Handler
  const handleSelectElement = (el) => {
    setActiveElement(el);
    if (selectedAtomId != null) {
      pushState(setAtomElement(mol, selectedAtomId, el));
      showToast(`Changed atom to ${el}`);
    }
    setShowElementDrawer(false);
  };

  // Ring Selection Handler
  const handleSelectRing = (ring) => {
    setActiveRing(ring);
    setActiveTool("ring");
    setShowRingDrawer(false);
    showToast(`Ring tool active (${ring === "benzene" ? "Benzene" : `${ring}-ring`}). Tap canvas to place.`);
  };

  // Quick PubChem Search Handler
  const handleSearchSubmit = async (e) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q) return;
    setSearchLoading(true);
    setSearchError(null);
    setSearchResults(null);

    try {
      if (onSearchCandidate) {
        const results = await onSearchCandidate(q);
        setSearchResults(results);
      } else {
        // Fallback search via direct API
        const res = await fetch(`/api/search-structure?query=${encodeURIComponent(q)}&type=auto`);
        const data = await res.json();
        if (!res.ok) {
          setSearchError(data.error || "Compound not found in PubChem");
        } else {
          setSearchResults(data.candidates || []);
        }
      }
    } catch (err) {
      setSearchError(err?.message || "Could not connect to search service");
    } finally {
      setSearchLoading(false);
    }
  };

  const handleLoadCandidateIntoCanvas = (candidate) => {
    if (!candidate || !candidate.smiles) return;
    try {
      const newMol = molFromSmiles(candidate.smiles);
      pushState(newMol);
      setShowSearchModal(false);
      showToast(`Loaded "${candidate.name || "Candidate"}" onto canvas!`);
      setTimeout(handleFitToScreen, 100);
    } catch (err) {
      console.error("Failed to load candidate into mobile canvas:", err);
      showToast("Could not render candidate: " + err.message);
    }
  };

  // Calculated molecular summary for status bar
  const valMap = useMemo(() => valenceMap(mol), [mol]);
  const molSummary = useMemo(() => {
    if (!mol.atoms.length) return null;
    try {
      const oclMol = toOCL(mol);
      const mf = oclMol.getMolecularFormula();
      return {
        formula: mf.formula || "",
        weight: mf.relativeWeight ? Number(mf.relativeWeight).toFixed(2) : "",
        atoms: mol.atoms.length,
        bonds: mol.bonds.length,
      };
    } catch {
      return { atoms: mol.atoms.length, bonds: mol.bonds.length };
    }
  }, [mol]);

  // Filtered periodic table elements
  const filteredElements = useMemo(() => {
    if (!elementSearchQuery.trim()) return ALL_ELEMENTS;
    const q = elementSearchQuery.toLowerCase();
    return ALL_ELEMENTS.filter((el) => el.symbol.toLowerCase().includes(q) || el.name.toLowerCase().includes(q));
  }, [elementSearchQuery]);

  return (
    <div
      className={`flex flex-col h-full w-full bg-slate-900 text-slate-100 select-none overflow-hidden relative ${className}`}
      style={{ touchAction: "none" }}
    >
      {/* ------------------------------------------------------------------ */}
      {/* A. Compact Mobile Header                                           */}
      {/* ------------------------------------------------------------------ */}
      <header className="flex items-center justify-between px-3 py-2 bg-slate-850 border-b border-slate-750 shrink-0 z-30">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <ChemAINeuralHexIcon className="w-5 h-5 text-cyan-400" />
            <span className="font-bold text-sm tracking-tight text-white">CHEMAI</span>
          </div>
          <span className="text-2xs font-semibold px-2 py-0.5 bg-cyan-950/80 text-cyan-300 rounded-full border border-cyan-800">
            Mobile 2D
          </span>
          {molSummary && molSummary.formula && (
            <span className="text-2xs font-mono font-medium text-slate-300 bg-slate-800 px-2 py-0.5 rounded border border-slate-700 hidden xs:inline-block">
              {molSummary.formula}
            </span>
          )}
        </div>

        {/* Undo, Redo, Clear, View Mode */}
        <div className="flex items-center gap-1">
          {/* Undo */}
          <button
            type="button"
            onClick={handleUndo}
            disabled={history.past.length === 0}
            className="w-9 h-9 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg bg-slate-800 border border-slate-700 text-slate-200 active:bg-slate-700 disabled:opacity-30 disabled:pointer-events-none transition-colors"
            title="Undo (Ctrl+Z)"
            aria-label="Undo edit"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a5 5 0 015 5v2m-15-7l4-4m-4 4l4 4" />
            </svg>
          </button>

          {/* Redo */}
          <button
            type="button"
            onClick={handleRedo}
            disabled={history.future.length === 0}
            className="w-9 h-9 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg bg-slate-800 border border-slate-700 text-slate-200 active:bg-slate-700 disabled:opacity-30 disabled:pointer-events-none transition-colors"
            title="Redo (Ctrl+Y)"
            aria-label="Redo edit"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 10H11a5 5 0 00-5 5v2m15-7l-4-4m4 4l-4 4" />
            </svg>
          </button>

          {/* Clear Canvas */}
          <button
            type="button"
            onClick={() => {
              if (mol.atoms.length > 0) {
                setShowClearConfirm(true);
              } else {
                showToast("Canvas is already clear");
              }
            }}
            className="w-9 h-9 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:text-red-400 active:bg-red-950/60 transition-colors"
            title="Clear all atoms and bonds"
            aria-label="Clear canvas"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>

          {/* Desktop Toggle Switch */}
          {onSwitchToDesktop && (
            <button
              type="button"
              onClick={onSwitchToDesktop}
              className="ml-1 px-2.5 py-1.5 min-h-[36px] text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-750 text-cyan-300 border border-slate-700 flex items-center gap-1 transition-colors"
              title="Switch to full desktop Ketcher editor"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <span className="hidden xs:inline">Desktop</span>
            </button>
          )}
        </div>
      </header>

      {/* Toast Notification */}
      {toastMsg && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-40 bg-slate-800/95 border border-cyan-500/50 text-cyan-200 text-xs font-medium px-3.5 py-1.5 rounded-full shadow-lg backdrop-blur-md animate-in fade-in slide-in-from-top-1">
          {toastMsg}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* B. Drawing Canvas (Touch Area)                                     */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex-1 relative w-full h-full bg-slate-950 overflow-hidden cursor-crosshair">
        <svg
          ref={svgRef}
          className="w-full h-full block touch-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          role="region"
          aria-label="Molecular drawing canvas"
        >
          {/* Subtle grid pattern for orientation */}
          <defs>
            <pattern id="grid" width="30" height="30" patternUnits="userSpaceOnUse">
              <circle cx="15" cy="15" r="0.8" fill="#334155" opacity="0.6" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />

          {/* Molecule Container with Pan & Zoom */}
          <g transform={`translate(${viewportSize.width / 2 + pan.x}, ${viewportSize.height / 2 + pan.y}) scale(${zoom})`}>
            {/* 1. Existing Bonds */}
            {mol.bonds.map((b) => {
              const a1 = getAtom(mol, b.a);
              const a2 = getAtom(mol, b.b);
              if (!a1 || !a2) return null;

              const dx = a2.x - a1.x;
              const dy = a2.y - a1.y;
              const len = Math.hypot(dx, dy) || 1;
              const nx = -dy / len;
              const ny = dx / len;
              const isSelected = selectedBondId === b.id;

              return (
                <g key={`bond-${b.id}`}>
                  {/* Invisible wide hit target for easy mobile finger tapping */}
                  <line
                    x1={a1.x}
                    y1={a1.y}
                    x2={a2.x}
                    y2={a2.y}
                    stroke="transparent"
                    strokeWidth="28"
                    strokeLinecap="round"
                  />

                  {/* Highlight aura if selected */}
                  {isSelected && (
                    <line
                      x1={a1.x}
                      y1={a1.y}
                      x2={a2.x}
                      y2={a2.y}
                      stroke="#38bdf8"
                      strokeWidth="10"
                      strokeOpacity="0.4"
                      strokeLinecap="round"
                    />
                  )}

                  {/* Bond graphics based on order */}
                  {b.order === 1 && (
                    <line
                      x1={a1.x}
                      y1={a1.y}
                      x2={a2.x}
                      y2={a2.y}
                      stroke="#e2e8f0"
                      strokeWidth="2.8"
                      strokeLinecap="round"
                    />
                  )}

                  {b.order === 2 && (
                    <>
                      <line
                        x1={a1.x + nx * 3.5}
                        y1={a1.y + ny * 3.5}
                        x2={a2.x + nx * 3.5}
                        y2={a2.y + ny * 3.5}
                        stroke="#e2e8f0"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                      />
                      <line
                        x1={a1.x - nx * 3.5}
                        y1={a1.y - ny * 3.5}
                        x2={a2.x - nx * 3.5}
                        y2={a2.y - ny * 3.5}
                        stroke="#e2e8f0"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                      />
                    </>
                  )}

                  {b.order === 3 && (
                    <>
                      <line
                        x1={a1.x}
                        y1={a1.y}
                        x2={a2.x}
                        y2={a2.y}
                        stroke="#e2e8f0"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                      />
                      <line
                        x1={a1.x + nx * 5}
                        y1={a1.y + ny * 5}
                        x2={a2.x + nx * 5}
                        y2={a2.y + ny * 5}
                        stroke="#e2e8f0"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                      />
                      <line
                        x1={a1.x - nx * 5}
                        y1={a1.y - ny * 5}
                        x2={a2.x - nx * 5}
                        y2={a2.y - ny * 5}
                        stroke="#e2e8f0"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                      />
                    </>
                  )}
                </g>
              );
            })}

            {/* 2. Drag / Sprout Bond Preview */}
            {dragPreview && (
              <g>
                <line
                  x1={dragPreview.from.x}
                  y1={dragPreview.from.y}
                  x2={dragPreview.to.x}
                  y2={dragPreview.to.y}
                  stroke="#38bdf8"
                  strokeWidth="2.5"
                  strokeDasharray="4 4"
                  strokeLinecap="round"
                />
                <circle
                  cx={dragPreview.to.x}
                  cy={dragPreview.to.y}
                  r={dragPreview.targetAtomId ? 10 : 5}
                  fill={dragPreview.targetAtomId ? "none" : "#38bdf8"}
                  stroke="#38bdf8"
                  strokeWidth="2"
                  strokeOpacity={dragPreview.targetAtomId ? 0.9 : 0.6}
                />
              </g>
            )}

            {/* 3. Existing Atoms */}
            {mol.atoms.map((a) => {
              const isSelected = selectedAtomId === a.id;
              const bondSum = valMap.get(a.id) || 0;
              const isCarbon = a.el === "C";
              const isIsolated = bondSum === 0;
              const showText = !isCarbon || isIsolated;
              const color = ELEMENT_COLORS[a.el] || (isCarbon ? "#f8fafc" : "#38bdf8");
              const overvalent = isOvervalent(a, bondSum);
              const numH = implicitHydrogens(a, bondSum);

              let hLabel = "";
              if (showText && numH > 0 && a.el !== "C") {
                hLabel = numH === 1 ? "H" : `H${numH}`;
              }

              return (
                <g key={`atom-${a.id}`} transform={`translate(${a.x}, ${a.y})`}>
                  {/* Invisible wide hit area for fingers (min 44px radius) */}
                  <circle cx="0" cy="0" r="24" fill="transparent" />

                  {/* Selection / Focus Halo */}
                  {isSelected && (
                    <circle
                      cx="0"
                      cy="0"
                      r="18"
                      fill="#38bdf8"
                      fillOpacity="0.2"
                      stroke="#38bdf8"
                      strokeWidth="2"
                      strokeDasharray="3 3"
                    />
                  )}

                  {/* Overvalence Warning Halo */}
                  {overvalent && (
                    <circle
                      cx="0"
                      cy="0"
                      r="20"
                      fill="#ef4444"
                      fillOpacity="0.15"
                      stroke="#ef4444"
                      strokeWidth="2"
                    />
                  )}

                  {/* Atom representation */}
                  {showText ? (
                    <>
                      {/* Opaque dark backing pill so crossing bonds don't cut through letter */}
                      <circle cx="0" cy="0" r="13" fill="#0f172a" />
                      <text
                        x="0"
                        y="0"
                        dy="0.35em"
                        textAnchor="middle"
                        fill={color}
                        fontSize="14"
                        fontWeight="bold"
                        fontFamily="system-ui, -apple-system, sans-serif"
                      >
                        {a.el}
                        {hLabel && (
                          <tspan fontSize="10" dy="0.3em" fill="#94a3b8">
                            {hLabel}
                          </tspan>
                        )}
                      </text>
                    </>
                  ) : (
                    /* Skeletal Carbon Vertex Dot */
                    <circle
                      cx="0"
                      cy="0"
                      r={isSelected ? 4.5 : 3}
                      fill={isSelected ? "#38bdf8" : "#cbd5e1"}
                    />
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Empty State Helpful Hint */}
        {mol.atoms.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center pointer-events-none z-10">
            <div className="w-14 h-14 rounded-2xl bg-slate-800/80 border border-slate-700 flex items-center justify-center text-2xl shadow-xl mb-3 backdrop-blur-sm">
              ✏️
            </div>
            <h3 className="text-base font-bold text-white mb-1">Canvas is Ready</h3>
            <p className="text-xs text-slate-400 max-w-xs leading-relaxed mb-4">
              Tap anywhere to add an atom, or use the ring templates and compound search below to start.
            </p>
            <div className="flex flex-wrap gap-2 pointer-events-auto">
              <button
                type="button"
                onClick={() => {
                  pushState(placeRing(EMPTY_MOL, 6, { type: "point", x: 0, y: 0 }, true));
                  setTimeout(handleFitToScreen, 50);
                }}
                className="px-3.5 py-2 min-h-[44px] text-xs font-semibold bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg shadow-md transition-colors flex items-center gap-1.5"
              >
                <span>⬡</span>
                <span>Benzene</span>
              </button>
              <button
                type="button"
                onClick={() => setShowSearchModal(true)}
                className="px-3.5 py-2 min-h-[44px] text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg shadow-md transition-colors flex items-center gap-1.5"
              >
                <span>🔍</span>
                <span>Search Compound</span>
              </button>
            </div>
          </div>
        )}

        {/* Floating Canvas Controls (Zoom In, Zoom Out, Fit) */}
        <div className="absolute top-3 right-3 flex flex-col gap-1.5 z-20">
          <button
            type="button"
            onClick={() => handleZoom(1.25)}
            className="w-10 h-10 min-w-[40px] min-h-[40px] rounded-xl bg-slate-850/90 border border-slate-700 text-slate-200 active:bg-slate-700 shadow-lg backdrop-blur-md flex items-center justify-center font-bold text-base transition-colors"
            title="Zoom In"
            aria-label="Zoom In"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => handleZoom(0.8)}
            className="w-10 h-10 min-w-[40px] min-h-[40px] rounded-xl bg-slate-850/90 border border-slate-700 text-slate-200 active:bg-slate-700 shadow-lg backdrop-blur-md flex items-center justify-center font-bold text-base transition-colors"
            title="Zoom Out"
            aria-label="Zoom Out"
          >
            −
          </button>
          <button
            type="button"
            onClick={handleFitToScreen}
            className="w-10 h-10 min-w-[40px] min-h-[40px] rounded-xl bg-slate-850/90 border border-slate-700 text-slate-200 active:bg-slate-700 shadow-lg backdrop-blur-md flex items-center justify-center text-xs transition-colors"
            title="Fit to Screen"
            aria-label="Fit to Screen"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* C. Essential Drawing Tools Bar (Bottom)                            */}
      {/* ------------------------------------------------------------------ */}
      <nav aria-label="Drawing tools" className="bg-slate-900 border-t border-slate-800 p-2 shrink-0 z-30 flex flex-col gap-2">
        {/* Row 1: Tool Buttons (min 44x44px touch targets) */}
        <div className="grid grid-cols-5 gap-1.5 max-w-md mx-auto w-full">
          {/* 1. Select / Move Tool */}
          <button
            type="button"
            onClick={() => setActiveTool("select")}
            className={`min-h-[46px] rounded-xl flex flex-col items-center justify-center gap-0.5 text-xs font-medium border transition-all ${
              activeTool === "select"
                ? "bg-cyan-600 border-cyan-400 text-white shadow-md shadow-cyan-900/40"
                : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-750"
            }`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 11.5V14m0-2.5v-6a1.5 1.5 0 113 0m-3 6a1.5 1.5 0 00-3 0v2a7.5 7.5 0 0015 0v-5a1.5 1.5 0 00-3 0m-6-3V11m0-5.5v-1a1.5 1.5 0 013 0v1m0 0V11m0-5.5a1.5 1.5 0 013 0v3m0 0V11" />
            </svg>
            <span className="text-[11px]">Move</span>
          </button>

          {/* 2. Bond Tool (Single / Double / Triple) */}
          <button
            type="button"
            onClick={() => {
              if (activeTool === "bond") {
                // Cycle bond order 1 -> 2 -> 3 -> 1
                setBondOrderState((o) => (o === 3 ? 1 : o + 1));
              } else {
                setActiveTool("bond");
              }
            }}
            className={`min-h-[46px] rounded-xl flex flex-col items-center justify-center gap-0.5 text-xs font-medium border transition-all relative ${
              activeTool === "bond"
                ? "bg-cyan-600 border-cyan-400 text-white shadow-md shadow-cyan-900/40"
                : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-750"
            }`}
          >
            <span className="font-mono text-base font-bold leading-none">
              {bondOrder === 1 ? "—" : bondOrder === 2 ? "═" : "≡"}
            </span>
            <span className="text-[11px]">
              {bondOrder === 1 ? "Single" : bondOrder === 2 ? "Double" : "Triple"}
            </span>
          </button>

          {/* 3. Element Tool (Opens Drawer) */}
          <button
            type="button"
            onClick={() => setShowElementDrawer(true)}
            className="min-h-[46px] rounded-xl flex flex-col items-center justify-center gap-0.5 text-xs font-medium bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-750 active:border-cyan-400 transition-all"
          >
            <div className="flex items-center gap-1 font-bold">
              <span style={{ color: ELEMENT_COLORS[activeElement] || "#38bdf8" }}>{activeElement}</span>
              <span className="text-[10px] text-slate-400">▾</span>
            </div>
            <span className="text-[11px]">Element</span>
          </button>

          {/* 4. Rings Tool (Opens Drawer) */}
          <button
            type="button"
            onClick={() => setShowRingDrawer(true)}
            className={`min-h-[46px] rounded-xl flex flex-col items-center justify-center gap-0.5 text-xs font-medium border transition-all ${
              activeTool === "ring"
                ? "bg-cyan-600 border-cyan-400 text-white shadow-md shadow-cyan-900/40"
                : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-750"
            }`}
          >
            <span className="text-base leading-none">⬡</span>
            <span className="text-[11px]">Rings</span>
          </button>

          {/* 5. Erase Tool */}
          <button
            type="button"
            onClick={() => setActiveTool("erase")}
            className={`min-h-[46px] rounded-xl flex flex-col items-center justify-center gap-0.5 text-xs font-medium border transition-all ${
              activeTool === "erase"
                ? "bg-red-600 border-red-400 text-white shadow-md shadow-red-900/40"
                : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-750"
            }`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            <span className="text-[11px]">Erase</span>
          </button>
        </div>

        {/* Row 2: Primary Actions (Search + Identify Molecule + Ask ChemAI) */}
        <div className="flex items-center gap-2 max-w-md mx-auto w-full">
          {/* Quick Search Button */}
          <button
            type="button"
            onClick={() => setShowSearchModal(true)}
            className="w-12 h-12 min-w-[48px] min-h-[48px] rounded-xl bg-slate-800 hover:bg-slate-750 border border-slate-700 text-slate-200 active:bg-slate-700 flex items-center justify-center transition-colors shrink-0"
            title="Search PubChem compound by name or formula"
            aria-label="Search PubChem"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>

          {/* Primary Action: Identify Molecule / Analyze Structure */}
          <button
            type="button"
            onClick={handleAnalyzeClick}
            disabled={identifyLoading || mol.atoms.length === 0}
            className="flex-1 min-h-[48px] px-4 rounded-xl font-bold text-sm bg-gradient-to-r from-indigo-600 via-indigo-500 to-cyan-600 hover:from-indigo-500 hover:to-cyan-500 active:from-indigo-700 active:to-cyan-700 text-white shadow-lg shadow-indigo-950/50 flex items-center justify-center gap-2 disabled:opacity-40 disabled:pointer-events-none transition-all"
          >
            {identifyLoading ? (
              <>
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                <span>Identifying...</span>
              </>
            ) : (
              <>
                <span>🔬</span>
                <span>Analyze Structure</span>
              </>
            )}
          </button>

          {/* Central AI: Ask ChemAI */}
          {onOpenChat && (
            <button
              type="button"
              onClick={onOpenChat}
              className="w-12 h-12 min-w-[48px] min-h-[48px] rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white shadow-md flex items-center justify-center transition-all shrink-0"
              title="Open ChemAI Conversational Assistant"
              aria-label="Open ChemAI Assistant"
            >
              <ChemAINeuralHexIcon className="w-6 h-6 text-cyan-100" />
            </button>
          )}
        </div>
      </nav>

      {/* ------------------------------------------------------------------ */}
      {/* D. Element Picker Drawer (Modal)                                   */}
      {/* ------------------------------------------------------------------ */}
      {showElementDrawer && (
        <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-sm flex flex-col justify-end animate-in fade-in duration-150">
          <div className="bg-slate-900 border-t border-slate-750 rounded-t-2xl p-4 max-h-[80vh] flex flex-col gap-3 shadow-2xl">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <h4 className="font-bold text-sm text-white">Select Chemical Element</h4>
              <button
                type="button"
                onClick={() => setShowElementDrawer(false)}
                className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center hover:bg-slate-700"
              >
                ✕
              </button>
            </div>

            {/* Quick Common Elements (Organic chemistry) */}
            <div>
              <span className="text-2xs font-semibold uppercase tracking-wider text-slate-400 block mb-2">
                Common Organic Elements
              </span>
              <div className="grid grid-cols-5 gap-2">
                {COMMON_ELEMENTS.map((sym) => (
                  <button
                    key={sym}
                    type="button"
                    onClick={() => handleSelectElement(sym)}
                    className={`min-h-[44px] rounded-xl flex flex-col items-center justify-center border font-bold transition-all ${
                      activeElement === sym
                        ? "bg-cyan-600 border-cyan-400 text-white shadow-md"
                        : "bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-750"
                    }`}
                  >
                    <span className="text-base" style={{ color: activeElement === sym ? "#fff" : ELEMENT_COLORS[sym] || "#fff" }}>
                      {sym}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Searchable Periodic Table for Less Common Elements */}
            <div className="flex-1 flex flex-col min-h-0 pt-2 border-t border-slate-800">
              <input
                type="text"
                placeholder="Search element name or symbol (e.g. Fe, B, Si)..."
                value={elementSearchQuery}
                onChange={(e) => setElementSearchQuery(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-sm text-white placeholder-slate-500 mb-2 focus:outline-none focus:border-cyan-500"
              />
              <div className="overflow-y-auto max-h-48 grid grid-cols-4 gap-1.5 pr-1">
                {filteredElements.map((el) => (
                  <button
                    key={el.symbol}
                    type="button"
                    onClick={() => handleSelectElement(el.symbol)}
                    className="min-h-[40px] px-2 py-1.5 bg-slate-800 hover:bg-slate-750 rounded-lg border border-slate-750 text-left flex items-center justify-between transition-colors"
                  >
                    <span className="font-bold text-sm text-cyan-300">{el.symbol}</span>
                    <span className="text-[10px] text-slate-400 truncate max-w-[50px]">{el.name}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Ring Templates Drawer (Modal)                                      */}
      {/* ------------------------------------------------------------------ */}
      {showRingDrawer && (
        <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-sm flex flex-col justify-end animate-in fade-in duration-150">
          <div className="bg-slate-900 border-t border-slate-750 rounded-t-2xl p-4 flex flex-col gap-3 shadow-2xl">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <h4 className="font-bold text-sm text-white">Ring Templates</h4>
              <button
                type="button"
                onClick={() => setShowRingDrawer(false)}
                className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center hover:bg-slate-700"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-2 xs:grid-cols-3 gap-2.5">
              {/* Benzene */}
              <button
                type="button"
                onClick={() => handleSelectRing("benzene")}
                className="p-3 min-h-[56px] rounded-xl bg-slate-800 border border-slate-700 hover:border-cyan-400 active:bg-slate-700 flex flex-col items-center justify-center gap-1 transition-all"
              >
                <span className="text-xl">⬡</span>
                <span className="text-xs font-semibold text-slate-200">Benzene (Aromatic)</span>
              </button>

              {/* Cyclohexane */}
              <button
                type="button"
                onClick={() => handleSelectRing(6)}
                className="p-3 min-h-[56px] rounded-xl bg-slate-800 border border-slate-700 hover:border-cyan-400 active:bg-slate-700 flex flex-col items-center justify-center gap-1 transition-all"
              >
                <span className="text-xl">⬡</span>
                <span className="text-xs font-semibold text-slate-200">Cyclohexane (6)</span>
              </button>

              {/* Cyclopentane */}
              <button
                type="button"
                onClick={() => handleSelectRing(5)}
                className="p-3 min-h-[56px] rounded-xl bg-slate-800 border border-slate-700 hover:border-cyan-400 active:bg-slate-700 flex flex-col items-center justify-center gap-1 transition-all"
              >
                <span className="text-xl">⬠</span>
                <span className="text-xs font-semibold text-slate-200">Cyclopentane (5)</span>
              </button>

              {/* Cyclobutane */}
              <button
                type="button"
                onClick={() => handleSelectRing(4)}
                className="p-3 min-h-[56px] rounded-xl bg-slate-800 border border-slate-700 hover:border-cyan-400 active:bg-slate-700 flex flex-col items-center justify-center gap-1 transition-all"
              >
                <span className="text-xl">◻</span>
                <span className="text-xs font-semibold text-slate-200">Cyclobutane (4)</span>
              </button>

              {/* Cyclopropane */}
              <button
                type="button"
                onClick={() => handleSelectRing(3)}
                className="p-3 min-h-[56px] rounded-xl bg-slate-800 border border-slate-700 hover:border-cyan-400 active:bg-slate-700 flex flex-col items-center justify-center gap-1 transition-all"
              >
                <span className="text-xl">△</span>
                <span className="text-xs font-semibold text-slate-200">Cyclopropane (3)</span>
              </button>
            </div>
            <p className="text-2xs text-slate-400 text-center">
              Tap a ring template above, then tap anywhere on the canvas, on an atom, or on a bond to fuse it.
            </p>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Clear Confirmation Modal                                          */}
      {/* ------------------------------------------------------------------ */}
      {showClearConfirm && (
        <div className="absolute inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-slate-900 border border-slate-750 rounded-2xl p-5 max-w-sm w-full shadow-2xl flex flex-col gap-3">
            <div className="w-11 h-11 rounded-full bg-red-950/80 border border-red-800 text-red-400 flex items-center justify-center text-xl mx-auto">
              ⚠️
            </div>
            <h4 className="font-bold text-base text-center text-white">Clear Molecule Canvas?</h4>
            <p className="text-xs text-slate-300 text-center leading-relaxed">
              Are you sure you want to delete all atoms and bonds? This will remove your current drawing.
            </p>
            <div className="grid grid-cols-2 gap-2.5 mt-2">
              <button
                type="button"
                onClick={() => setShowClearConfirm(false)}
                className="min-h-[44px] rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-300 text-xs font-semibold border border-slate-700 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleClearCanvas}
                className="min-h-[44px] rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold shadow-lg shadow-red-950/50 transition-colors"
              >
                Clear Canvas
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Quick Compound Search Modal                                        */}
      {/* ------------------------------------------------------------------ */}
      {showSearchModal && (
        <div className="absolute inset-0 z-50 bg-black/70 backdrop-blur-sm flex flex-col justify-end xs:justify-center p-0 xs:p-4 animate-in fade-in duration-150">
          <div className="bg-slate-900 border border-slate-750 rounded-t-2xl xs:rounded-2xl p-4 max-h-[85vh] flex flex-col gap-3 shadow-2xl w-full max-w-lg mx-auto">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <span className="text-cyan-400 font-bold">🔍</span>
                <h4 className="font-bold text-sm text-white">Search Compound</h4>
              </div>
              <button
                type="button"
                onClick={() => setShowSearchModal(false)}
                className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center hover:bg-slate-700"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSearchSubmit} className="flex gap-2">
              <input
                type="text"
                placeholder="Enter name or formula (e.g. aspirin, C6H6)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 px-3.5 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                autoFocus
              />
              <button
                type="submit"
                disabled={searchLoading || !searchQuery.trim()}
                className="px-4 py-2.5 min-h-[44px] rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white font-bold text-xs shadow-md transition-colors shrink-0"
              >
                {searchLoading ? "..." : "Search"}
              </button>
            </form>

            {searchError && (
              <div className="text-xs text-red-300 bg-red-950/60 p-2.5 rounded-lg border border-red-800">
                {searchError}
              </div>
            )}

            {/* Results List */}
            <div className="overflow-y-auto max-h-60 flex flex-col gap-2 pr-1">
              {searchResults && searchResults.length === 0 && (
                <div className="text-xs text-slate-400 text-center py-4">
                  No matching verified structures found.
                </div>
              )}
              {searchResults &&
                searchResults.map((cand) => (
                  <div
                    key={cand.cid || cand.smiles}
                    className="p-3 bg-slate-800/80 rounded-xl border border-slate-700 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <h5 className="font-bold text-xs text-white truncate">{cand.name}</h5>
                      <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono mt-0.5">
                        <span>{cand.formula || cand.molecularFormula}</span>
                        {cand.cid && <span>CID: {cand.cid}</span>}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleLoadCandidateIntoCanvas(cand)}
                      className="px-3 py-1.5 min-h-[36px] bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-semibold shrink-0 transition-colors"
                    >
                      Load
                    </button>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

MobileMolecularEditor.propTypes = {
  initialMol: PropTypes.shape({
    atoms: PropTypes.arrayOf(PropTypes.object),
    bonds: PropTypes.arrayOf(PropTypes.object),
  }),
  initialSmiles: PropTypes.string,
  onIdentify: PropTypes.func,
  identifyLoading: PropTypes.bool,
  onOpenChat: PropTypes.func,
  onSwitchToDesktop: PropTypes.func,
  onSearchCandidate: PropTypes.func,
  onStructureChange: PropTypes.func,
  className: PropTypes.string,
};
