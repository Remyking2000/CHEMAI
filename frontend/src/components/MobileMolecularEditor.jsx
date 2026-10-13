import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import PropTypes from "prop-types";
import {
  BOND_LEN,
  EMPTY_MOL,
  COMMON_ELEMENTS,
  ALL_ELEMENTS,
  ELEMENT_COLORS,
  getAtom,
  getBond,
  findAtomNear,
  findBondNear,
  addAtom,
  addBond,
  setBondOrder,
  setAtomElement,
  removeAtom,
  removeBond,
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
 * Highly polished, touch-first molecular drawing workspace for mobile viewports.
 * Built with clean responsive ergonomics, generous touch hit targets,
 * rock-solid gesture disambiguation, and verified chemical correctness.
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

  const molRef = useRef(mol);
  molRef.current = mol;

  const [history, setHistory] = useState({ past: [], future: [] });

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

  const handleUndo = useCallback(() => {
    setHistory((h) => {
      if (h.past.length === 0) return h;
      const previous = h.past[h.past.length - 1];
      const newPast = h.past.slice(0, -1);
      setMol(previous);
      if (onStructureChange) onStructureChange(previous);
      return { past: newPast, future: [mol, ...h.future] };
    });
  }, [mol, onStructureChange]);

  const handleRedo = useCallback(() => {
    setHistory((h) => {
      if (h.future.length === 0) return h;
      const next = h.future[0];
      const newFuture = h.future.slice(1);
      setMol(next);
      if (onStructureChange) onStructureChange(next);
      return { past: [...h.past, mol], future: newFuture };
    });
  }, [mol, onStructureChange]);

  // Synchronize when initialSmiles or initialMol changes externally
  useEffect(() => {
    if (initialSmiles === "") {
      setMol(EMPTY_MOL);
      setHistory({ past: [], future: [] });
    } else if (initialSmiles && typeof initialSmiles === "string" && initialSmiles.trim()) {
      try {
        const loaded = molFromSmiles(initialSmiles.trim());
        setMol(loaded);
        setHistory({ past: [], future: [] });
      } catch (err) {
        console.warn("Could not load external initialSmiles:", err);
      }
    }
  }, [initialSmiles]);

  useEffect(() => {
    if (initialMol) {
      setMol(initialMol);
    }
  }, [initialMol]);

  // ---------------------------------------------------------------------------
  // Tool Selection & Configuration
  // ---------------------------------------------------------------------------
  // Tools: "draw" | "move" | "erase" | "ring"
  const [activeTool, setActiveTool] = useState("draw");
  const [bondOrder, setBondOrderState] = useState(1); // 1, 2, or 3
  const [activeElement, setActiveElement] = useState("C");
  const [activeRing, setActiveRing] = useState("benzene"); // "benzene" | 6 | 5 | 4 | 3

  // Sub-drawers & Flyouts
  const [showElementFlyout, setShowElementFlyout] = useState(false);
  const [showRingFlyout, setShowRingFlyout] = useState(false);
  const [showAllElementsModal, setShowAllElementsModal] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showSearchModal, setShowSearchModal] = useState(false);

  // Selection
  const [selectedAtomId, setSelectedAtomId] = useState(null);
  const [selectedBondId, setSelectedBondId] = useState(null);

  // Search & Filter
  const [elementSearchQuery, setElementSearchQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState(null);
  const [searchError, setSearchError] = useState(null);

  // Toast / Status Message
  const [toastMsg, setToastMsg] = useState("");
  const toastTimerRef = useRef(null);
  const showToast = useCallback((msg) => {
    setToastMsg(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMsg(""), 2500);
  }, []);

  // ---------------------------------------------------------------------------
  // Canvas Viewport & ResizeObserver (100% Exact Screen-to-World Sync)
  // ---------------------------------------------------------------------------
  const canvasContainerRef = useRef(null);
  const svgRef = useRef(null);
  const worldGroupRef = useRef(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dimensions, setDimensions] = useState({ width: 360, height: 480 });

  // Measure the actual SVG drawing viewport, not the combined editor container
  useEffect(() => {
    const el = canvasContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ width, height });
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Map screen (clientX, clientY) -> Molecule World Coordinates using SVG Matrix Transform
  const screenToWorld = useCallback(
    (clientX, clientY) => {
      if (!svgRef.current) return { x: 0, y: 0 };

      // Priority 1: Exact SVG transformation matrix inversion
      if (worldGroupRef.current && typeof worldGroupRef.current.getScreenCTM === "function") {
        try {
          const ctm = worldGroupRef.current.getScreenCTM();
          if (ctm) {
            const inv = ctm.inverse();
            if (typeof DOMPoint !== "undefined") {
              const pt = new DOMPoint(clientX, clientY).matrixTransform(inv);
              if (Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
                return { x: pt.x, y: pt.y };
              }
            } else if (typeof svgRef.current.createSVGPoint === "function") {
              const pt = svgRef.current.createSVGPoint();
              pt.x = clientX;
              pt.y = clientY;
              const res = pt.matrixTransform(inv);
              if (Number.isFinite(res.x) && Number.isFinite(res.y)) {
                return { x: res.x, y: res.y };
              }
            }
          }
        } catch {
          // Fall through to bounding rect calculation if matrix cannot be inverted
        }
      }

      // Priority 2: Viewport-relative fallback using measured SVG canvas bounds
      const rect = svgRef.current.getBoundingClientRect();
      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;
      return {
        x: (screenX - rect.width / 2 - pan.x) / zoom,
        y: (screenY - rect.height / 2 - pan.y) / zoom,
      };
    },
    [pan.x, pan.y, zoom]
  );

  // Fit Molecule to Canvas
  const handleFitToScreen = useCallback(() => {
    const currentMol = molRef.current;
    if (!currentMol.atoms.length) {
      setPan({ x: 0, y: 0 });
      setZoom(1);
      return;
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const a of currentMol.atoms) {
      minX = Math.min(minX, a.x);
      maxX = Math.max(maxX, a.x);
      minY = Math.min(minY, a.y);
      maxY = Math.max(maxY, a.y);
    }
    const molW = maxX - minX + BOND_LEN * 2.5;
    const molH = maxY - minY + BOND_LEN * 2.5;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    const targetW = dimensions.width * 0.8;
    const targetH = dimensions.height * 0.75;
    const fitZoom = Math.min(
      Math.max(0.55, Math.min(targetW / (molW || 1), targetH / (molH || 1))),
      1.6
    );
    setZoom(fitZoom);
    setPan({ x: -midX * fitZoom, y: -midY * fitZoom });
    showToast("Framed molecule");
  }, [dimensions, showToast]);

  const handleZoomChange = (factor) => {
    setZoom((z) => Math.min(2.5, Math.max(0.45, z * factor)));
  };

  // ---------------------------------------------------------------------------
  // Gesture State Machine (Touch, Pinch, Tap, Drag)
  // ---------------------------------------------------------------------------
  const gestureRef = useRef({
    pointers: new Map(), // pointerId -> { clientX, clientY }
    isPinch: false,
    initialPinchDist: 0,
    initialZoom: 1,
    initialPan: { x: 0, y: 0 },
    dragType: null, // "move_atom" | "draw_preview" | "pan_canvas"
    startAtom: null,
    dragStarted: false,
    startScreenX: 0,
    startScreenY: 0,
    startWorldX: 0,
    startWorldY: 0,
    movingAtomOrigX: 0,
    movingAtomOrigY: 0,
    molBeforeDrag: null,
  });

  const [dragPreview, setDragPreview] = useState(null); // { from: {x,y}, to: {x,y}, targetAtomId }

  const handlePointerDown = (e) => {
    // Avoid triggering when tapping buttons or UI elements
    if (e.target.closest("button") || e.target.closest("input") || e.target.closest(".dock-container")) {
      return;
    }

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    const g = gestureRef.current;
    g.pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

    // Multi-touch: 2 fingers -> Pinch to zoom & pan
    if (g.pointers.size === 2) {
      g.isPinch = true;
      g.dragType = null;
      g.startAtom = null;
      g.molBeforeDrag = null;
      setDragPreview(null);
      const pts = Array.from(g.pointers.values());
      g.initialPinchDist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
      g.initialZoom = zoom;
      g.initialPan = { ...pan };
      return;
    }

    if (g.pointers.size > 2) return;

    // Single touch setup
    g.isPinch = false;
    g.dragStarted = false;
    g.molBeforeDrag = null;
    g.startScreenX = e.clientX;
    g.startScreenY = e.clientY;

    const world = screenToWorld(e.clientX, e.clientY);
    g.startWorldX = world.x;
    g.startWorldY = world.y;

    // Touch hit thresholds (scaled to guarantee at least 24px screen hit target)
    const atomHitRadius = Math.max(BOND_LEN * 0.55, 26 / zoom);
    const bondHitRadius = Math.max(BOND_LEN * 0.45, 20 / zoom);

    const hitAtom = findAtomNear(molRef.current, world.x, world.y, atomHitRadius);
    const hitBond = !hitAtom ? findBondNear(molRef.current, world.x, world.y, bondHitRadius) : null;

    // ERASE TOOL
    if (activeTool === "erase") {
      if (hitAtom) {
        pushState(removeAtom(molRef.current, hitAtom.id));
        if (selectedAtomId === hitAtom.id) setSelectedAtomId(null);
        showToast(`Erased atom ${hitAtom.el}`);
      } else if (hitBond) {
        pushState(removeBond(molRef.current, hitBond.id));
        if (selectedBondId === hitBond.id) setSelectedBondId(null);
        showToast("Erased bond");
      }
      g.dragType = null;
      return;
    }

    // RING TOOL
    if (activeTool === "ring") {
      const isBenzene = activeRing === "benzene";
      const ringSize = isBenzene ? 6 : activeRing;
      if (hitAtom) {
        pushState(placeRing(molRef.current, ringSize, { type: "atom", id: hitAtom.id }, isBenzene));
        showToast(`Attached ${isBenzene ? "benzene ring" : `${ringSize}-membered ring`}`);
      } else if (hitBond) {
        pushState(placeRing(molRef.current, ringSize, { type: "bond", id: hitBond.id }, isBenzene));
        showToast(`Fused ${isBenzene ? "benzene ring" : `${ringSize}-membered ring`}`);
      } else {
        pushState(placeRing(molRef.current, ringSize, { type: "point", x: world.x, y: world.y }, isBenzene));
        showToast(`Placed ${isBenzene ? "benzene ring" : `${ringSize}-membered ring`}`);
      }
      // Return to draw tool after ring placement
      setActiveTool("draw");
      setShowRingFlyout(false);
      g.dragType = null;
      return;
    }

    // MOVE TOOL
    if (activeTool === "move") {
      if (hitAtom) {
        setSelectedAtomId(hitAtom.id);
        setSelectedBondId(null);
        g.dragType = "move_atom";
        g.startAtom = hitAtom;
        g.molBeforeDrag = molRef.current;
        g.movingAtomOrigX = hitAtom.x;
        g.movingAtomOrigY = hitAtom.y;
      } else if (hitBond) {
        setSelectedBondId(hitBond.id);
        setSelectedAtomId(null);
        g.dragType = null;
      } else {
        setSelectedAtomId(null);
        setSelectedBondId(null);
        g.dragType = "pan_canvas";
        g.initialPan = { ...pan };
      }
      return;
    }

    // DRAW TOOL (Primary)
    if (hitAtom) {
      g.startAtom = hitAtom;
      g.dragType = "draw_preview";
    } else if (hitBond) {
      // Tap bond in draw tool: cycle bond order
      const nextOrder = hitBond.order === 3 ? 1 : hitBond.order + 1;
      pushState(setBondOrder(molRef.current, hitBond.id, nextOrder));
      setSelectedBondId(hitBond.id);
      setSelectedAtomId(null);
      showToast(`${nextOrder === 1 ? "Single" : nextOrder === 2 ? "Double" : "Triple"} bond`);
      g.dragType = null;
    } else {
      // Touched empty canvas in draw tool
      g.dragType = "pan_canvas";
      g.initialPan = { ...pan };
    }
  };

  const handlePointerMove = (e) => {
    const g = gestureRef.current;
    if (!g.pointers.has(e.pointerId)) return;
    g.pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

    // Handle 2-finger pinch & pan
    if (g.isPinch && g.pointers.size === 2) {
      const pts = Array.from(g.pointers.values());
      const currentDist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
      if (g.initialPinchDist > 0) {
        const factor = currentDist / g.initialPinchDist;
        const newZoom = Math.min(2.5, Math.max(0.45, g.initialZoom * factor));
        setZoom(newZoom);
      }
      return;
    }

    const distFromStart = Math.hypot(e.clientX - g.startScreenX, e.clientY - g.startScreenY);
    if (distFromStart > 8) {
      g.dragStarted = true;
    }

    const world = screenToWorld(e.clientX, e.clientY);

    // Pan canvas
    if (g.dragType === "pan_canvas" && g.initialPan) {
      const dx = e.clientX - g.startScreenX;
      const dy = e.clientY - g.startScreenY;
      setPan({ x: g.initialPan.x + dx, y: g.initialPan.y + dy });
      return;
    }

    // Move atom
    if (g.dragType === "move_atom" && g.startAtom) {
      const dx = world.x - g.startWorldX;
      const dy = world.y - g.startWorldY;
      const updated = {
        ...molRef.current,
        atoms: molRef.current.atoms.map((a) =>
          a.id === g.startAtom.id
            ? { ...a, x: g.movingAtomOrigX + dx, y: g.movingAtomOrigY + dy }
            : a
        ),
      };
      setMol(updated);
      return;
    }

    // Draw bond preview
    if (g.dragType === "draw_preview" && g.startAtom && g.dragStarted) {
      const atom = g.startAtom;
      const snappedEnd = previewBondEnd(molRef.current, atom, world, atom.id);
      const target = findAtomNear(molRef.current, world.x, world.y, BOND_LEN * 0.55, [atom.id]);
      setDragPreview({
        from: { x: atom.x, y: atom.y },
        to: snappedEnd,
        targetAtomId: target ? target.id : null,
      });
    }
  };

  const handlePointerUp = (e) => {
    const g = gestureRef.current;
    if (g.pointers.has(e.pointerId)) {
      g.pointers.delete(e.pointerId);
    }

    // If a pinch gesture was active, ignore any release drawing
    if (g.isPinch) {
      if (g.pointers.size === 0) g.isPinch = false;
      setDragPreview(null);
      return;
    }

    const world = screenToWorld(e.clientX, e.clientY);

    // 1. Finished moving an atom (commit one clean history entry)
    if (g.dragType === "move_atom" && g.startAtom && g.dragStarted) {
      if (g.molBeforeDrag) {
        setHistory((h) => ({
          past: [...h.past.slice(-25), g.molBeforeDrag],
          future: [],
        }));
        if (onStructureChange) {
          try {
            onStructureChange(molRef.current);
          } catch (err) {
            console.error("onStructureChange error:", err);
          }
        }
      }
      showToast("Moved atom");
    }

    // 2. Finished drawing via dragging from an atom
    else if (g.dragType === "draw_preview" && g.startAtom && g.dragStarted) {
      const nextM = drawBondTo(
        molRef.current,
        g.startAtom.id,
        g.startAtom,
        world,
        bondOrder,
        activeElement
      );
      pushState(nextM);
      showToast(`Added ${bondOrder === 1 ? "single" : bondOrder === 2 ? "double" : "triple"} bond`);
    }

    // 3. Simple Tap in Move Tool (No dragging)
    else if (activeTool === "move" && !g.dragStarted && !g.isPinch) {
      const atomHitRadius = Math.max(BOND_LEN * 0.55, 26 / zoom);
      const hitAtom = findAtomNear(molRef.current, world.x, world.y, atomHitRadius);
      if (hitAtom) {
        setSelectedAtomId(hitAtom.id);
        setSelectedBondId(null);
      } else {
        setSelectedAtomId(null);
        setSelectedBondId(null);
      }
    }

    // 4. Simple Tap in Draw Tool (No dragging)
    else if (activeTool === "draw" && !g.dragStarted && !g.isPinch) {
      const atomHitRadius = Math.max(BOND_LEN * 0.55, 26 / zoom);
      const hitAtom = findAtomNear(molRef.current, world.x, world.y, atomHitRadius);

      if (hitAtom) {
        // A. An atom was already selected and user tapped a DIFFERENT atom:
        // Connect them with a bond!
        if (selectedAtomId != null && selectedAtomId !== hitAtom.id) {
          const nextM = addBond(molRef.current, selectedAtomId, hitAtom.id, bondOrder);
          pushState(nextM);
          setSelectedAtomId(hitAtom.id);
          showToast("Connected atoms");
        }
        // B. User tapped the ALREADY selected atom:
        // Sprout a new substituent bond!
        else if (selectedAtomId === hitAtom.id) {
          const nextM = addSubstituent(molRef.current, hitAtom.id, activeElement, bondOrder);
          pushState(nextM);
          showToast("Added substituent");
        }
        // C. User tapped an unselected atom:
        // Select it!
        else {
          setSelectedAtomId(hitAtom.id);
          setSelectedBondId(null);
        }
      } else {
        // Tapped empty canvas
        if (selectedAtomId != null) {
          // If an atom was selected, tap empty canvas to extend chain towards that point!
          const nextM = drawBondTo(
            molRef.current,
            selectedAtomId,
            getAtom(molRef.current, selectedAtomId),
            world,
            bondOrder,
            activeElement
          );
          pushState(nextM);
          // Select the newly added atom
          const newestAtom = nextM.atoms[nextM.atoms.length - 1];
          if (newestAtom) setSelectedAtomId(newestAtom.id);
          showToast("Extended bond");
        } else {
          // If nothing was selected, place a starter atom
          const { mol: nextM, id } = addAtom(molRef.current, world.x, world.y, activeElement);
          pushState(nextM);
          setSelectedAtomId(id);
          showToast(`Added ${activeElement} atom`);
        }
      }
    }

    // Reset interaction flags
    setDragPreview(null);
    if (g.pointers.size === 0) {
      g.dragType = null;
      g.startAtom = null;
      g.dragStarted = false;
      g.molBeforeDrag = null;
    }
  };

  const handlePointerCancel = (e) => {
    const g = gestureRef.current;
    if (g.pointers.has(e.pointerId)) {
      g.pointers.delete(e.pointerId);
    }
    // Revert atom position if an interrupted drag occurred
    if (g.dragType === "move_atom" && g.molBeforeDrag) {
      setMol(g.molBeforeDrag);
    }
    setDragPreview(null);
    if (g.pointers.size === 0) {
      g.isPinch = false;
      g.dragType = null;
      g.startAtom = null;
      g.dragStarted = false;
      g.molBeforeDrag = null;
    }
  };

  // ---------------------------------------------------------------------------
  // Action Handlers
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
        showToast("Structure export error: " + (err?.message || err));
      }
    }
  };

  // Quick Element Pick Handler
  const handleSelectElement = (sym) => {
    setActiveElement(sym);
    if (selectedAtomId != null) {
      pushState(setAtomElement(molRef.current, selectedAtomId, sym));
      showToast(`Changed atom to ${sym}`);
    } else {
      showToast(`Drawing element: ${sym}`);
    }
    setShowElementFlyout(false);
    setShowAllElementsModal(false);
  };

  // Ring Template Pick Handler
  const handleSelectRing = (ring) => {
    setActiveRing(ring);
    setActiveTool("ring");
    setShowRingFlyout(false);
    showToast(`Tap canvas, atom, or bond to place ${ring === "benzene" ? "Benzene" : `${ring}-ring`}`);
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
      setTimeout(handleFitToScreen, 120);
    } catch (err) {
      console.error("Failed to load candidate into mobile canvas:", err);
      showToast("Could not render candidate: " + err.message);
    }
  };

  // Live Formula & Valence Summary
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

  // Periodic Table Search Filter
  const filteredElements = useMemo(() => {
    if (!elementSearchQuery.trim()) return ALL_ELEMENTS;
    const q = elementSearchQuery.toLowerCase();
    return ALL_ELEMENTS.filter(
      (el) => el.symbol.toLowerCase().includes(q) || el.name.toLowerCase().includes(q)
    );
  }, [elementSearchQuery]);

  return (
    <div
      className={`flex flex-col h-full w-full bg-slate-50 text-slate-900 select-none overflow-hidden relative font-sans ${className}`}
    >
      {/* ------------------------------------------------------------------ */}
      {/* 1. Header (Clean, Modern CHEMAI Style)                             */}
      {/* ------------------------------------------------------------------ */}
      <header className="flex items-center justify-between px-3 py-2 bg-white border-b border-slate-200 shrink-0 z-30 shadow-xs">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 shrink-0">
            <ChemAINeuralHexIcon className="w-5 h-5 text-indigo-600" />
            <span className="font-extrabold text-sm tracking-tight text-slate-900">CHEMAI</span>
          </div>

          {molSummary && molSummary.formula ? (
            <div className="flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 text-indigo-900 px-2 py-0.5 rounded-full text-2xs font-mono font-semibold truncate">
              <span>{molSummary.formula}</span>
              {molSummary.weight && (
                <span className="text-indigo-600 hidden xs:inline">• {molSummary.weight} g/mol</span>
              )}
            </div>
          ) : (
            <span className="text-2xs font-medium text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
              Mobile 2D
            </span>
          )}
        </div>

        {/* Actions: Undo, Redo, Clear, Desktop Switch */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={handleUndo}
            disabled={history.past.length === 0}
            className="w-9 h-9 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 active:bg-slate-300 disabled:opacity-30 disabled:pointer-events-none transition-colors"
            title="Undo"
            aria-label="Undo"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.4" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a5 5 0 015 5v2m-15-7l4-4m-4 4l4 4" />
            </svg>
          </button>

          <button
            type="button"
            onClick={handleRedo}
            disabled={history.future.length === 0}
            className="w-9 h-9 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 active:bg-slate-300 disabled:opacity-30 disabled:pointer-events-none transition-colors"
            title="Redo"
            aria-label="Redo"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.4" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 10H11a5 5 0 00-5 5v2m15-7l-4-4m4 4l-4 4" />
            </svg>
          </button>

          <button
            type="button"
            onClick={() => {
              if (mol.atoms.length > 0) setShowClearConfirm(true);
              else showToast("Canvas is already clear");
            }}
            className="w-9 h-9 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg bg-slate-100 hover:bg-red-50 text-slate-700 hover:text-red-600 active:bg-red-100 transition-colors"
            title="Clear canvas"
            aria-label="Clear canvas"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>

          {onSwitchToDesktop && (
            <button
              type="button"
              onClick={onSwitchToDesktop}
              className="ml-1 px-2.5 py-1.5 min-h-[36px] text-xs font-semibold rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 flex items-center gap-1 transition-colors"
              title="Switch to Desktop Ketcher"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <span className="hidden xs:inline">Desktop</span>
            </button>
          )}
        </div>
      </header>

      {/* Toast Notice */}
      {toastMsg && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-40 bg-slate-900/90 text-white text-xs font-medium px-4 py-1.5 rounded-full shadow-lg backdrop-blur-md animate-in fade-in slide-in-from-top-1 pointer-events-none">
          {toastMsg}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* 2. Molecular Drawing Canvas (SVG with Exact Matrix Mapping)        */}
      {/* ------------------------------------------------------------------ */}
      <div ref={canvasContainerRef} className="flex-1 relative w-full h-full bg-slate-50 overflow-hidden cursor-crosshair">
        <svg
          ref={svgRef}
          className="w-full h-full block touch-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          role="region"
          aria-label="Molecular drawing canvas"
        >
          {/* Subtle Grid Dots */}
          <defs>
            <pattern id="dot-grid" width="28" height="28" patternUnits="userSpaceOnUse">
              <circle cx="14" cy="14" r="1.1" fill="#cbd5e1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#dot-grid)" />

          {/* Molecule Container (Centered + Pan + Zoom) */}
          <g
            ref={worldGroupRef}
            transform={`translate(${dimensions.width / 2 + pan.x}, ${dimensions.height / 2 + pan.y}) scale(${zoom})`}
          >
            {/* Bonds */}
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
                  {/* Invisible wide hit area for fingers */}
                  <line
                    x1={a1.x}
                    y1={a1.y}
                    x2={a2.x}
                    y2={a2.y}
                    stroke="transparent"
                    strokeWidth="36"
                    strokeLinecap="round"
                  />

                  {/* Selected Bond Highlight Glow */}
                  {isSelected && (
                    <line
                      x1={a1.x}
                      y1={a1.y}
                      x2={a2.x}
                      y2={a2.y}
                      stroke="#6366f1"
                      strokeWidth="10"
                      strokeOpacity="0.35"
                      strokeLinecap="round"
                    />
                  )}

                  {/* Single Bond */}
                  {b.order === 1 && (
                    <line
                      x1={a1.x}
                      y1={a1.y}
                      x2={a2.x}
                      y2={a2.y}
                      stroke="#334155"
                      strokeWidth="3"
                      strokeLinecap="round"
                    />
                  )}

                  {/* Double Bond */}
                  {b.order === 2 && (
                    <>
                      <line
                        x1={a1.x + nx * 3.5}
                        y1={a1.y + ny * 3.5}
                        x2={a2.x + nx * 3.5}
                        y2={a2.y + ny * 3.5}
                        stroke="#334155"
                        strokeWidth="2.6"
                        strokeLinecap="round"
                      />
                      <line
                        x1={a1.x - nx * 3.5}
                        y1={a1.y - ny * 3.5}
                        x2={a2.x - nx * 3.5}
                        y2={a2.y - ny * 3.5}
                        stroke="#334155"
                        strokeWidth="2.6"
                        strokeLinecap="round"
                      />
                    </>
                  )}

                  {/* Triple Bond */}
                  {b.order === 3 && (
                    <>
                      <line
                        x1={a1.x}
                        y1={a1.y}
                        x2={a2.x}
                        y2={a2.y}
                        stroke="#334155"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                      />
                      <line
                        x1={a1.x + nx * 5}
                        y1={a1.y + ny * 5}
                        x2={a2.x + nx * 5}
                        y2={a2.y + ny * 5}
                        stroke="#334155"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                      />
                      <line
                        x1={a1.x - nx * 5}
                        y1={a1.y - ny * 5}
                        x2={a2.x - nx * 5}
                        y2={a2.y - ny * 5}
                        stroke="#334155"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                      />
                    </>
                  )}
                </g>
              );
            })}

            {/* Live Bond Drag Preview */}
            {dragPreview && (
              <g>
                <line
                  x1={dragPreview.from.x}
                  y1={dragPreview.from.y}
                  x2={dragPreview.to.x}
                  y2={dragPreview.to.y}
                  stroke="#4f46e5"
                  strokeWidth="2.8"
                  strokeDasharray="4 4"
                  strokeLinecap="round"
                />
                <circle
                  cx={dragPreview.to.x}
                  cy={dragPreview.to.y}
                  r={dragPreview.targetAtomId ? 12 : 5}
                  fill={dragPreview.targetAtomId ? "none" : "#4f46e5"}
                  stroke="#4f46e5"
                  strokeWidth="2.5"
                  strokeOpacity={dragPreview.targetAtomId ? 0.9 : 0.7}
                />
              </g>
            )}

            {/* Atoms */}
            {mol.atoms.map((a) => {
              const isSelected = selectedAtomId === a.id;
              const bondSum = valMap.get(a.id) || 0;
              const isCarbon = a.el === "C";
              const isIsolated = bondSum === 0;
              const showText = !isCarbon || isIsolated;
              const color = ELEMENT_COLORS[a.el] || (isCarbon ? "#0f172a" : "#4f46e5");
              const overvalent = isOvervalent(a, bondSum);
              const numH = implicitHydrogens(a, bondSum);

              let hLabel = "";
              if (showText && numH > 0 && a.el !== "C") {
                hLabel = numH === 1 ? "H" : `H${numH}`;
              }

              return (
                <g key={`atom-${a.id}`} transform={`translate(${a.x}, ${a.y})`}>
                  {/* Invisible wide hit target for fingers */}
                  <circle cx="0" cy="0" r="26" fill="transparent" />

                  {/* Selected Atom Halo Glow */}
                  {isSelected && (
                    <circle
                      cx="0"
                      cy="0"
                      r="18"
                      fill="#e0e7ff"
                      stroke="#4f46e5"
                      strokeWidth="2.2"
                      strokeDasharray="3 3"
                    />
                  )}

                  {/* Overvalence Warning Halo */}
                  {overvalent && (
                    <circle
                      cx="0"
                      cy="0"
                      r="20"
                      fill="#fee2e2"
                      stroke="#ef4444"
                      strokeWidth="2"
                    />
                  )}

                  {/* Heteroatom or Isolated Carbon */}
                  {showText ? (
                    <>
                      {/* Opaque white circular backing pill so crossing bonds don't cut through text */}
                      <circle cx="0" cy="0" r="13" fill="#ffffff" stroke="#e2e8f0" strokeWidth="1" />
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
                          <tspan fontSize="10" dy="0.3em" fill="#64748b">
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
                      r={isSelected ? 5.5 : 3.5}
                      fill={isSelected ? "#4f46e5" : "#334155"}
                    />
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Compact, Non-Obstructive Empty Canvas Instructions */}
        {mol.atoms.length === 0 && (
          <div className="absolute top-3 left-3 right-16 flex flex-col items-start pointer-events-none z-10 animate-in fade-in duration-150">
            <div className="bg-white/95 border border-slate-200/90 rounded-2xl p-3 shadow-md max-w-sm w-full backdrop-blur-sm pointer-events-auto">
              <div className="flex items-start gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-600 flex items-center justify-center text-sm font-bold shrink-0">
                  ✏️
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-slate-800 leading-snug">
                    Tap to start drawing. Select an element or drag from an atom to create a bond.
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    <button
                      type="button"
                      onClick={() => {
                        const { mol: nextM } = addAtom(EMPTY_MOL, -20, 0, "C");
                        const { mol: chainM } = addAtom(nextM, 20, 0, "C");
                        const chained = addBond(chainM, chainM.atoms[0].id, chainM.atoms[1].id, 1);
                        pushState(chained);
                        setTimeout(handleFitToScreen, 50);
                        showToast("Added C—C chain");
                      }}
                      className="px-2.5 py-1 text-2xs font-semibold bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-800 rounded-lg transition-colors flex items-center gap-1 cursor-pointer"
                    >
                      <span>—</span>
                      <span>C—C Chain</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        pushState(placeRing(EMPTY_MOL, 6, { type: "point", x: 0, y: 0 }, true));
                        setTimeout(handleFitToScreen, 50);
                        showToast("Placed Benzene ring");
                      }}
                      className="px-2.5 py-1 text-2xs font-semibold bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg transition-colors flex items-center gap-1 cursor-pointer"
                    >
                      <span>⬡</span>
                      <span>Benzene</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        pushState(placeRing(EMPTY_MOL, 6, { type: "point", x: 0, y: 0 }, false));
                        setTimeout(handleFitToScreen, 50);
                        showToast("Placed Cyclohexane ring");
                      }}
                      className="px-2.5 py-1 text-2xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors flex items-center gap-1 cursor-pointer"
                    >
                      <span>⬡</span>
                      <span>Cyclohexane</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Selected Atom / Bond Status Pill with 1-Tap Deselect */}
        {(selectedAtomId != null || selectedBondId != null) && (
          <div className="absolute bottom-3 left-3 z-20 flex items-center gap-2 bg-white/95 border border-slate-200 rounded-xl px-3 py-1.5 shadow-md backdrop-blur-xs animate-in fade-in slide-in-from-bottom-1">
            <span className="text-2xs font-semibold text-slate-500 uppercase tracking-wider">
              Selected:
            </span>
            <span className="text-xs font-bold text-indigo-700">
              {selectedAtomId != null
                ? `Atom ${getAtom(mol, selectedAtomId)?.el || ""}`
                : `Bond (${getBond(mol, selectedBondId)?.order === 1 ? "Single" : getBond(mol, selectedBondId)?.order === 2 ? "Double" : "Triple"})`}
            </span>
            <button
              type="button"
              onClick={() => {
                setSelectedAtomId(null);
                setSelectedBondId(null);
              }}
              className="ml-1 text-2xs text-slate-500 hover:text-slate-800 font-semibold px-1.5 py-0.5 rounded bg-slate-100 hover:bg-slate-200 transition-colors cursor-pointer"
              title="Deselect"
            >
              Deselect
            </button>
          </div>
        )}

        {/* Floating Zoom & Fit Controls (Top-Right) */}
        <div className="absolute top-3 right-3 flex flex-col gap-1.5 z-20">
          <button
            type="button"
            onClick={() => handleZoomChange(1.25)}
            className="w-10 h-10 min-w-[40px] min-h-[40px] rounded-xl bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 active:bg-slate-100 shadow-md flex items-center justify-center font-bold text-base transition-colors"
            title="Zoom In"
            aria-label="Zoom In"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => handleZoomChange(0.8)}
            className="w-10 h-10 min-w-[40px] min-h-[40px] rounded-xl bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 active:bg-slate-100 shadow-md flex items-center justify-center font-bold text-base transition-colors"
            title="Zoom Out"
            aria-label="Zoom Out"
          >
            −
          </button>
          <button
            type="button"
            onClick={handleFitToScreen}
            className="w-10 h-10 min-w-[40px] min-h-[40px] rounded-xl bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 active:bg-slate-100 shadow-md flex items-center justify-center text-xs transition-colors"
            title="Frame Molecule"
            aria-label="Frame Molecule"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* 3. Floating Bottom Dock (Ergonomic Thumb Toolbar)                  */}
      {/* ------------------------------------------------------------------ */}
      <div className="dock-container shrink-0 z-30 p-2.5 pb-3 bg-white/95 border-t border-slate-200 shadow-xl backdrop-blur-md flex flex-col gap-2">
        {/* Quick Element Bar (Shown when Element tool is toggled) */}
        {showElementFlyout && (
          <div className="flex items-center gap-1.5 overflow-x-auto py-1 px-0.5 border-b border-slate-100 animate-in fade-in slide-in-from-bottom-2">
            <span className="text-2xs font-semibold uppercase text-slate-400 shrink-0 mr-1">Elements:</span>
            {COMMON_ELEMENTS.slice(0, 7).map((sym) => (
              <button
                key={sym}
                type="button"
                onClick={() => handleSelectElement(sym)}
                className={`min-w-[38px] h-9 px-2.5 rounded-lg border text-xs font-bold transition-all shrink-0 ${
                  activeElement === sym
                    ? "bg-indigo-600 border-indigo-600 text-white shadow-xs"
                    : "bg-slate-100 border-slate-200 text-slate-800 hover:bg-slate-200"
                }`}
                style={{ color: activeElement === sym ? "#fff" : ELEMENT_COLORS[sym] || "#0f172a" }}
              >
                {sym}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setShowAllElementsModal(true)}
              className="min-w-[42px] h-9 px-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 text-slate-600 text-xs font-semibold hover:bg-slate-100 shrink-0"
            >
              More...
            </button>
          </div>
        )}

        {/* Quick Ring Bar (Shown when Ring tool is toggled) */}
        {showRingFlyout && (
          <div className="flex items-center gap-1.5 overflow-x-auto py-1 px-0.5 border-b border-slate-100 animate-in fade-in slide-in-from-bottom-2">
            <span className="text-2xs font-semibold uppercase text-slate-400 shrink-0 mr-1">Rings:</span>
            <button
              type="button"
              onClick={() => handleSelectRing("benzene")}
              className={`min-h-[38px] px-3 rounded-lg border text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 ${
                activeRing === "benzene" && activeTool === "ring"
                  ? "bg-indigo-600 border-indigo-600 text-white"
                  : "bg-slate-100 border-slate-200 text-slate-800"
              }`}
            >
              <span>⬡</span> Benzene
            </button>
            <button
              type="button"
              onClick={() => handleSelectRing(6)}
              className={`min-h-[38px] px-3 rounded-lg border text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 ${
                activeRing === 6 && activeTool === "ring"
                  ? "bg-indigo-600 border-indigo-600 text-white"
                  : "bg-slate-100 border-slate-200 text-slate-800"
              }`}
            >
              <span>⬡</span> 6-Ring
            </button>
            <button
              type="button"
              onClick={() => handleSelectRing(5)}
              className={`min-h-[38px] px-3 rounded-lg border text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 ${
                activeRing === 5 && activeTool === "ring"
                  ? "bg-indigo-600 border-indigo-600 text-white"
                  : "bg-slate-100 border-slate-200 text-slate-800"
              }`}
            >
              <span>⬠</span> 5-Ring
            </button>
            <button
              type="button"
              onClick={() => handleSelectRing(4)}
              className={`min-h-[38px] px-3 rounded-lg border text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 ${
                activeRing === 4 && activeTool === "ring"
                  ? "bg-indigo-600 border-indigo-600 text-white"
                  : "bg-slate-100 border-slate-200 text-slate-800"
              }`}
            >
              <span>◻</span> 4-Ring
            </button>
            <button
              type="button"
              onClick={() => handleSelectRing(3)}
              className={`min-h-[38px] px-3 rounded-lg border text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 ${
                activeRing === 3 && activeTool === "ring"
                  ? "bg-indigo-600 border-indigo-600 text-white"
                  : "bg-slate-100 border-slate-200 text-slate-800"
              }`}
            >
              <span>△</span> 3-Ring
            </button>
          </div>
        )}

        {/* Row 1: Drawing Tool Tabs */}
        <div className="grid grid-cols-5 gap-1.5 w-full">
          {/* 1. Draw / Bond Tool */}
          <button
            type="button"
            onClick={() => {
              if (activeTool === "draw") {
                // Cycle bond order on tap
                setBondOrderState((o) => (o === 3 ? 1 : o + 1));
                showToast(`Bond: ${bondOrder === 1 ? "Double" : bondOrder === 2 ? "Triple" : "Single"}`);
              } else {
                setActiveTool("draw");
                setShowElementFlyout(false);
                setShowRingFlyout(false);
              }
            }}
            className={`min-h-[46px] rounded-xl flex flex-col items-center justify-center gap-0.5 text-xs font-semibold border transition-all ${
              activeTool === "draw"
                ? "bg-indigo-600 border-indigo-600 text-white shadow-sm"
                : "bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200"
            }`}
          >
            <span className="font-mono text-base font-bold leading-none">
              {bondOrder === 1 ? "—" : bondOrder === 2 ? "═" : "≡"}
            </span>
            <span className="text-2xs">
              {bondOrder === 1 ? "Single" : bondOrder === 2 ? "Double" : "Triple"}
            </span>
          </button>

          {/* 2. Element Tool */}
          <button
            type="button"
            onClick={() => {
              setShowElementFlyout(!showElementFlyout);
              setShowRingFlyout(false);
            }}
            className={`min-h-[46px] rounded-xl flex flex-col items-center justify-center gap-0.5 text-xs font-semibold border transition-all ${
              showElementFlyout
                ? "bg-indigo-50 border-indigo-400 text-indigo-700 ring-2 ring-indigo-200"
                : "bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200"
            }`}
          >
            <span
              className="text-sm font-extrabold leading-none"
              style={{ color: ELEMENT_COLORS[activeElement] || "#4f46e5" }}
            >
              {activeElement}
            </span>
            <span className="text-2xs flex items-center gap-0.5">
              <span>Atom</span>
              <span className="text-3xs">▾</span>
            </span>
          </button>

          {/* 3. Ring Tool */}
          <button
            type="button"
            onClick={() => {
              setShowRingFlyout(!showRingFlyout);
              setShowElementFlyout(false);
              if (activeTool !== "ring") setActiveTool("ring");
            }}
            className={`min-h-[46px] rounded-xl flex flex-col items-center justify-center gap-0.5 text-xs font-semibold border transition-all ${
              activeTool === "ring" || showRingFlyout
                ? "bg-indigo-600 border-indigo-600 text-white shadow-sm"
                : "bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200"
            }`}
          >
            <span className="text-base leading-none">⬡</span>
            <span className="text-2xs flex items-center gap-0.5">
              <span>Ring</span>
              <span className="text-3xs">▾</span>
            </span>
          </button>

          {/* 4. Move / Pan Tool */}
          <button
            type="button"
            onClick={() => {
              setActiveTool("move");
              setShowElementFlyout(false);
              setShowRingFlyout(false);
            }}
            className={`min-h-[46px] rounded-xl flex flex-col items-center justify-center gap-0.5 text-xs font-semibold border transition-all ${
              activeTool === "move"
                ? "bg-indigo-600 border-indigo-600 text-white shadow-sm"
                : "bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200"
            }`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 11.5V14m0-2.5v-6a1.5 1.5 0 113 0m-3 6a1.5 1.5 0 00-3 0v2a7.5 7.5 0 0015 0v-5a1.5 1.5 0 00-3 0m-6-3V11m0-5.5v-1a1.5 1.5 0 013 0v1m0 0V11m0-5.5a1.5 1.5 0 013 0v3m0 0V11" />
            </svg>
            <span className="text-2xs">Move</span>
          </button>

          {/* 5. Erase Tool */}
          <button
            type="button"
            onClick={() => {
              setActiveTool("erase");
              setShowElementFlyout(false);
              setShowRingFlyout(false);
            }}
            className={`min-h-[46px] rounded-xl flex flex-col items-center justify-center gap-0.5 text-xs font-semibold border transition-all ${
              activeTool === "erase"
                ? "bg-red-600 border-red-600 text-white shadow-sm"
                : "bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200"
            }`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            <span className="text-2xs">Erase</span>
          </button>
        </div>

        {/* Row 2: Primary Actions (Search + Prominent Analyze Structure + Chat) */}
        <div className="flex items-center gap-2 w-full">
          {/* Quick Search */}
          <button
            type="button"
            onClick={() => setShowSearchModal(true)}
            className="w-12 h-12 min-w-[48px] min-h-[48px] rounded-xl bg-slate-100 hover:bg-slate-200 active:bg-slate-300 border border-slate-200 text-slate-700 flex items-center justify-center transition-colors shrink-0"
            title="Search compound by name or formula"
            aria-label="Search PubChem"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>

          {/* Primary Action: Analyze Structure */}
          <button
            type="button"
            onClick={handleAnalyzeClick}
            disabled={identifyLoading || mol.atoms.length === 0}
            className="flex-1 min-h-[48px] px-4 rounded-xl font-bold text-sm bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 active:from-indigo-700 active:to-blue-700 text-white shadow-md flex items-center justify-center gap-2 disabled:opacity-40 disabled:pointer-events-none transition-all cursor-pointer"
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

          {/* Ask ChemAI */}
          {onOpenChat && (
            <button
              type="button"
              onClick={onOpenChat}
              className="w-12 h-12 min-w-[48px] min-h-[48px] rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white shadow-md flex items-center justify-center transition-all shrink-0 cursor-pointer"
              title="Open ChemAI Chat"
              aria-label="Open ChemAI Chat"
            >
              <ChemAINeuralHexIcon className="w-6 h-6 text-white" />
            </button>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* 4. Full Periodic Table Drawer (Modal)                              */}
      {/* ------------------------------------------------------------------ */}
      {showAllElementsModal && (
        <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-xs flex flex-col justify-end animate-in fade-in duration-150">
          <div className="bg-white border-t border-slate-200 rounded-t-2xl p-4 max-h-[82vh] flex flex-col gap-3 shadow-2xl">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <h4 className="font-bold text-sm text-slate-900">Choose Chemical Element</h4>
              <button
                type="button"
                onClick={() => setShowAllElementsModal(false)}
                className="w-8 h-8 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center hover:bg-slate-200 text-sm font-bold"
              >
                ✕
              </button>
            </div>

            {/* Quick Common Elements */}
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
                    className={`min-h-[44px] rounded-xl flex items-center justify-center border font-bold text-base transition-all ${
                      activeElement === sym
                        ? "bg-indigo-600 border-indigo-600 text-white shadow-sm"
                        : "bg-slate-50 border-slate-200 text-slate-800 hover:bg-slate-100"
                    }`}
                    style={{ color: activeElement === sym ? "#fff" : ELEMENT_COLORS[sym] || "#0f172a" }}
                  >
                    {sym}
                  </button>
                ))}
              </div>
            </div>

            {/* Searchable Periodic Table */}
            <div className="flex-1 flex flex-col min-h-0 pt-2 border-t border-slate-100">
              <input
                type="text"
                placeholder="Search element symbol or name (e.g. Fe, B, Si)..."
                value={elementSearchQuery}
                onChange={(e) => setElementSearchQuery(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-sm text-slate-900 placeholder-slate-400 mb-2 focus:outline-none focus:border-indigo-500 focus:bg-white"
              />
              <div className="overflow-y-auto max-h-52 grid grid-cols-3 xs:grid-cols-4 gap-1.5 pr-1">
                {filteredElements.map((el) => (
                  <button
                    key={el.symbol}
                    type="button"
                    onClick={() => handleSelectElement(el.symbol)}
                    className="min-h-[42px] px-2 py-1 bg-slate-50 hover:bg-indigo-50 rounded-lg border border-slate-200 text-left flex items-center justify-between transition-colors cursor-pointer"
                  >
                    <span className="font-bold text-sm text-indigo-700">{el.symbol}</span>
                    <span className="text-3xs text-slate-500 truncate max-w-[55px]">{el.name}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* 5. Clear Confirmation Modal                                        */}
      {/* ------------------------------------------------------------------ */}
      {showClearConfirm && (
        <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-white border border-slate-200 rounded-2xl p-5 max-w-sm w-full shadow-2xl flex flex-col gap-3">
            <div className="w-12 h-12 rounded-full bg-red-50 border border-red-200 text-red-600 flex items-center justify-center text-xl mx-auto font-bold">
              ⚠️
            </div>
            <h4 className="font-bold text-base text-center text-slate-900">Clear Drawing Canvas?</h4>
            <p className="text-xs text-slate-600 text-center leading-relaxed">
              Are you sure you want to remove all atoms and bonds? Your current drawing will be deleted.
            </p>
            <div className="grid grid-cols-2 gap-2.5 mt-2">
              <button
                type="button"
                onClick={() => setShowClearConfirm(false)}
                className="min-h-[44px] rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold border border-slate-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleClearCanvas}
                className="min-h-[44px] rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold shadow-md transition-colors"
              >
                Clear Canvas
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* 6. Quick Compound Search Modal                                     */}
      {/* ------------------------------------------------------------------ */}
      {showSearchModal && (
        <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-xs flex flex-col justify-end xs:justify-center p-0 xs:p-4 animate-in fade-in duration-150">
          <div className="bg-white border border-slate-200 rounded-t-2xl xs:rounded-2xl p-4 max-h-[85vh] flex flex-col gap-3 shadow-2xl w-full max-w-md mx-auto">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <span className="text-indigo-600 font-bold">🔍</span>
                <h4 className="font-bold text-sm text-slate-900">Search PubChem Compound</h4>
              </div>
              <button
                type="button"
                onClick={() => setShowSearchModal(false)}
                className="w-8 h-8 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center hover:bg-slate-200 text-sm font-bold"
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
                className="flex-1 px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:bg-white"
                autoFocus
              />
              <button
                type="submit"
                disabled={searchLoading || !searchQuery.trim()}
                className="px-4 py-2.5 min-h-[44px] rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white font-bold text-xs shadow-sm transition-colors shrink-0"
              >
                {searchLoading ? "..." : "Search"}
              </button>
            </form>

            {searchError && (
              <div className="text-xs text-red-700 bg-red-50 p-2.5 rounded-lg border border-red-200">
                {searchError}
              </div>
            )}

            {/* Candidate List */}
            <div className="overflow-y-auto max-h-60 flex flex-col gap-2 pr-1">
              {searchResults && searchResults.length === 0 && (
                <div className="text-xs text-slate-500 text-center py-4">
                  No matching verified structures found.
                </div>
              )}
              {searchResults &&
                searchResults.map((cand) => (
                  <div
                    key={cand.cid || cand.smiles}
                    className="p-3 bg-slate-50 hover:bg-indigo-50/50 rounded-xl border border-slate-200 flex items-center justify-between gap-2 transition-colors"
                  >
                    <div className="min-w-0">
                      <h5 className="font-bold text-xs text-slate-900 truncate">{cand.name}</h5>
                      <div className="flex items-center gap-2 text-2xs text-slate-500 font-mono mt-0.5">
                        <span>{cand.formula || cand.molecularFormula}</span>
                        {cand.cid && <span>CID: {cand.cid}</span>}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleLoadCandidateIntoCanvas(cand)}
                      className="px-3 py-1.5 min-h-[36px] bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold shrink-0 shadow-2xs transition-colors"
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
