import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  BOND_LEN,
  EMPTY_MOL,
  COMMON_ELEMENTS,
  ALL_ELEMENTS,
  ELEMENT_COLORS,
  getAtom,
  findAtomNear,
  findBondNear,
  addAtom,
  setBondOrder,
  setAtomElement,
  removeAtom,
  removeBond,
  removeAtoms,
  removeBonds,
  cycleAtomCharge,
  addSubstituent,
  drawBondTo,
  previewBondEnd,
  placeRing,
  exportStructure,
  molFromSmiles,
  molFromMolfile,
  cleanStructure,
  valenceMap,
  implicitHydrogens,
  isOvervalent,
  getConnectedComponent,
  computeViewportTransform,
} from "../lib/moleculeEngine";

const ZOOM_PRESETS = [50, 75, 80, 100, 120, 150, 200, 250, 300];
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4.0;

/**
 * DesktopMolecularEditor
 *
 * Full-featured, responsive desktop molecular drawing interface.
 * Uses the shared molecular engine for authoritative chemical data model
 * and seamless parity with mobile.
 */
export default function DesktopMolecularEditor({
  mol: externalMol,
  onMolChange,
  undo: externalUndo,
  redo: externalRedo,
  canUndo: externalCanUndo,
  canRedo: externalCanRedo,
  clear: externalClear,
  loadVersion = 0,
  initialMol = null,
  initialSmiles = null,
  onIdentify,
  identifyLoading = false,
  onOpenChat,
  onSwitchToMobile,
  className = "",
}) {
  // ---------------------------------------------------------------------------
  // 1. Authoritative Molecule & History State
  // ---------------------------------------------------------------------------
  const [internalMol, setInternalMol] = useState(() => {
    if (initialMol && Array.isArray(initialMol.atoms) && initialMol.atoms.length > 0) {
      return initialMol;
    }
    if (initialSmiles && typeof initialSmiles === "string" && initialSmiles.trim()) {
      try {
        return molFromSmiles(initialSmiles.trim());
      } catch (e) {
        console.warn("Could not parse initialSmiles for desktop editor:", e);
      }
    }
    // Start with a clean, empty canvas by default
    return EMPTY_MOL;
  });

  const [internalHistory, setInternalHistory] = useState({ past: [], future: [] });

  const isControlled = externalMol !== undefined && onMolChange !== undefined;
  const currentMol = isControlled ? externalMol : internalMol;
  const currentMolRef = useRef(currentMol);
  currentMolRef.current = currentMol;

  // Track internal interactive edits vs external structure loads
  const isInternalEditRef = useRef(false);
  const hasUserAdjustedViewportRef = useRef(false);
  const hasInitialFitRef = useRef(false);

  const pushState = useCallback(
    (newMol, isInternal = true) => {
      isInternalEditRef.current = isInternal;
      if (isControlled) {
        onMolChange(newMol);
      } else {
        setInternalMol((prev) => {
          if (prev === newMol) return prev;
          setInternalHistory((h) => ({
            past: [...h.past.slice(-35), prev],
            future: [],
          }));
          return newMol;
        });
      }
    },
    [isControlled, onMolChange]
  );

  const handleUndo = useCallback(() => {
    isInternalEditRef.current = true;
    if (isControlled && externalUndo) {
      externalUndo();
    } else {
      setInternalHistory((h) => {
        if (h.past.length === 0) return h;
        const prev = h.past[h.past.length - 1];
        setInternalMol(prev);
        return {
          past: h.past.slice(0, -1),
          future: [internalMol, ...h.future],
        };
      });
    }
  }, [isControlled, externalUndo, internalMol]);

  const handleRedo = useCallback(() => {
    isInternalEditRef.current = true;
    if (isControlled && externalRedo) {
      externalRedo();
    } else {
      setInternalHistory((h) => {
        if (h.future.length === 0) return h;
        const next = h.future[0];
        setInternalMol(next);
        return {
          past: [...h.past, internalMol],
          future: h.future.slice(1),
        };
      });
    }
  }, [isControlled, externalRedo, internalMol]);

  const canUndo = isControlled ? !!externalCanUndo : internalHistory.past.length > 0;
  const canRedo = isControlled ? !!externalCanRedo : internalHistory.future.length > 0;

  // ---------------------------------------------------------------------------
  // 2. Editor Tools & Configuration State
  // ---------------------------------------------------------------------------
  // Active tool: 'select' | 'bond' | 'ring' | 'erase' | 'charge'
  const [activeTool, setActiveTool] = useState("bond");
  const [currentElement, setCurrentElement] = useState("C");
  const [currentBondOrder, setCurrentBondOrder] = useState(1);
  const [currentRing, setCurrentRing] = useState({ size: 6, aromatic: true, name: "Benzene" });
  const [chargeDelta, setChargeDelta] = useState(1); // +1 or -1

  // Selection state
  const [selectedAtomIds, setSelectedAtomIds] = useState(new Set());
  const [selectedBondIds, setSelectedBondIds] = useState(new Set());
  const [hoverAtomId, setHoverAtomId] = useState(null);
  const [hoverBondId, setHoverBondId] = useState(null);

  // Periodic Table modal state
  const [showPeriodicTable, setShowPeriodicTable] = useState(false);
  const [periodicFilter, setPeriodicFilter] = useState("");

  // Import Structure modal state
  const [showImportModal, setShowImportModal] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState(null);

  // Canvas Viewport Transformation
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1.5);
  const [dimensions, setDimensions] = useState({ width: 900, height: 520 });
  const dimensionsRef = useRef(dimensions);
  dimensionsRef.current = dimensions;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;

  // Mouse interaction state
  const isMouseDownRef = useRef(false);
  const dragModeRef = useRef(null); // 'pan' | 'move_atom' | 'move_group' | 'draw_bond' | null
  const dragStartRef = useRef({ x: 0, y: 0, screenX: 0, screenY: 0 });
  const initialAtomCoordsRef = useRef(new Map());
  const hasMovedRef = useRef(false);

  // Interactive Live Previews
  const [dragPreview, setDragPreview] = useState(null);

  // Status message / toast
  const [toastMsg, setToastMsg] = useState("");
  const toastTimeoutRef = useRef(null);

  const showToast = useCallback((msg) => {
    setToastMsg(msg);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => setToastMsg(""), 3500);
  }, []);

  // DOM Refs
  const containerRef = useRef(null);
  const canvasContainerRef = useRef(null);
  const svgRef = useRef(null);
  const worldGroupRef = useRef(null);

  // ---------------------------------------------------------------------------
  // 3. Viewport Centering, Scaling & Responsive Resize Handling
  // ---------------------------------------------------------------------------
  const fitMoleculeToViewport = useCallback((targetMol, targetDims = dimensionsRef.current) => {
    const { zoom: nextZoom, pan: nextPan } = computeViewportTransform(
      targetMol,
      targetDims.width,
      targetDims.height,
      { minZoom: MIN_ZOOM, maxZoom: 2.0, emptyZoom: 1.5 }
    );
    setZoom(nextZoom);
    setPan(nextPan);
    zoomRef.current = nextZoom;
    panRef.current = nextPan;
  }, []);

  const isMoleculeClipped = useCallback((mol, dims, curZoom, curPan) => {
    if (!mol || !mol.atoms || mol.atoms.length === 0) return false;
    const margin = 36;
    for (const a of mol.atoms) {
      const sx = dims.width / 2 + curPan.x + a.x * curZoom;
      const sy = dims.height / 2 + curPan.y + a.y * curZoom;
      if (
        sx < margin ||
        sx > dims.width - margin ||
        sy < margin ||
        sy > dims.height - margin
      ) {
        return true;
      }
    }
    return false;
  }, []);

  useEffect(() => {
    const updateSize = () => {
      const el = canvasContainerRef.current || svgRef.current || containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const nextDims = {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
        setDimensions((prev) => {
          if (prev.width === nextDims.width && prev.height === nextDims.height && hasInitialFitRef.current) {
            return prev;
          }
          dimensionsRef.current = nextDims;
          if (
            !hasInitialFitRef.current ||
            !hasUserAdjustedViewportRef.current ||
            isMoleculeClipped(currentMolRef.current, nextDims, zoomRef.current, panRef.current)
          ) {
            hasInitialFitRef.current = true;
            fitMoleculeToViewport(currentMolRef.current, nextDims);
          }
          return nextDims;
        });
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    if (canvasContainerRef.current) {
      observer.observe(canvasContainerRef.current);
    } else if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    window.addEventListener("resize", updateSize);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateSize);
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, [fitMoleculeToViewport, isMoleculeClipped]);

  // Automatically center and scale when a structure is loaded or replaced externally
  useEffect(() => {
    if (isInternalEditRef.current) {
      isInternalEditRef.current = false;
      return;
    }
    hasUserAdjustedViewportRef.current = false;
    setSelectedAtomIds(new Set());
    setSelectedBondIds(new Set());
    fitMoleculeToViewport(currentMol, dimensionsRef.current);
  }, [currentMol, loadVersion, fitMoleculeToViewport]);

  const handleClear = useCallback(() => {
    hasUserAdjustedViewportRef.current = false;
    setSelectedAtomIds(new Set());
    setSelectedBondIds(new Set());
    if (isControlled && externalClear) {
      externalClear();
    } else {
      pushState(EMPTY_MOL, false);
    }
    fitMoleculeToViewport(EMPTY_MOL, dimensionsRef.current);
  }, [isControlled, externalClear, pushState, fitMoleculeToViewport]);

  // ---------------------------------------------------------------------------
  // 4. Chemical Derivations (Valence, Overvalence, Formula)
  // ---------------------------------------------------------------------------
  const valMap = useMemo(() => valenceMap(currentMol), [currentMol]);

  const chemicalInfo = useMemo(() => {
    if (!currentMol || !currentMol.atoms || currentMol.atoms.length === 0) {
      return { formula: "", weight: "", atomCount: 0, bondCount: 0, smiles: "" };
    }
    try {
      const exp = exportStructure(currentMol);
      return {
        formula: exp.formula || "",
        weight: exp.weight || "",
        smiles: exp.smiles || "",
        atomCount: currentMol.atoms.length,
        bondCount: currentMol.bonds.length,
      };
    } catch {
      return {
        formula: "",
        weight: "",
        smiles: "",
        atomCount: currentMol.atoms.length,
        bondCount: currentMol.bonds.length,
      };
    }
  }, [currentMol]);

  // ---------------------------------------------------------------------------
  // 5. Coordinate Transformations (Screen <-> World)
  // ---------------------------------------------------------------------------
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

      // Priority 2: Viewport-relative fallback using actual measured SVG canvas bounds
      const rect = svgRef.current.getBoundingClientRect();
      const wx = (clientX - rect.left - rect.width / 2 - pan.x) / zoom;
      const wy = (clientY - rect.top - rect.height / 2 - pan.y) / zoom;
      return { x: wx, y: wy };
    },
    [pan.x, pan.y, zoom]
  );

  // ---------------------------------------------------------------------------
  // 6. Viewport Actions: Zoom, Pan, Fit-to-Screen
  // ---------------------------------------------------------------------------
  const applyZoomWithCenteredPan = useCallback((nextZoomRaw) => {
    const nextZoom = +Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoomRaw)).toFixed(2);
    const prevZoom = zoomRef.current || 1;
    const ratio = nextZoom / prevZoom;
    hasUserAdjustedViewportRef.current = true;
    setZoom(nextZoom);
    setPan((prevPan) => {
      const nextPan = {
        x: +(prevPan.x * ratio).toFixed(2),
        y: +(prevPan.y * ratio).toFixed(2),
      };
      panRef.current = nextPan;
      return nextPan;
    });
    zoomRef.current = nextZoom;
  }, []);

  const handleZoomIn = useCallback(() => {
    applyZoomWithCenteredPan(zoomRef.current * 1.2);
  }, [applyZoomWithCenteredPan]);

  const handleZoomOut = useCallback(() => {
    applyZoomWithCenteredPan(zoomRef.current / 1.2);
  }, [applyZoomWithCenteredPan]);

  const handleSetZoomPercent = useCallback(
    (percent) => {
      const num = Number(percent);
      if (!Number.isFinite(num) || num <= 0) return;
      applyZoomWithCenteredPan(num / 100);
    },
    [applyZoomWithCenteredPan]
  );

  const handleFitToScreen = useCallback(() => {
    hasUserAdjustedViewportRef.current = false;
    fitMoleculeToViewport(currentMolRef.current, dimensionsRef.current);
  }, [fitMoleculeToViewport]);

  // Clean 2D Coordinates using OpenChemLib layout
  const handleCleanStructure = useCallback(() => {
    if (!currentMol.atoms || currentMol.atoms.length === 0) return;
    try {
      const cleaned = cleanStructure(currentMol);
      pushState(cleaned, false);
      fitMoleculeToViewport(cleaned, dimensionsRef.current);
      showToast("Cleaned 2D coordinates layout.");
    } catch (e) {
      console.warn("Could not clean structure:", e);
      showToast("Unable to clean coordinates for this structure.");
    }
  }, [currentMol, pushState, fitMoleculeToViewport, showToast]);

  // Import SMILES or Molfile structure directly into the canvas
  const handleImportSubmit = useCallback(
    (e) => {
      if (e) e.preventDefault();
      const raw = importText.trim();
      if (!raw) {
        setImportError("Please paste a valid SMILES string or MDL Molfile.");
        return;
      }
      try {
        const isMolfile =
          raw.includes("V2000") ||
          raw.includes("V3000") ||
          raw.includes("M  END") ||
          raw.split(/\r?\n/).length > 3;
        const importedMol = isMolfile ? molFromMolfile(raw) : molFromSmiles(raw);
        if (!importedMol || !importedMol.atoms || importedMol.atoms.length === 0) {
          setImportError("Parsed structure contains 0 atoms. Check your input format.");
          return;
        }
        hasUserAdjustedViewportRef.current = false;
        pushState(importedMol, false);
        fitMoleculeToViewport(importedMol, dimensionsRef.current);
        setShowImportModal(false);
        setImportText("");
        setImportError(null);
        showToast(`Imported structure (${importedMol.atoms.length} atoms) onto canvas.`);
      } catch (err) {
        setImportError(err?.message || "Could not parse structure. Please check the SMILES or Molfile syntax.");
      }
    },
    [importText, pushState, fitMoleculeToViewport, showToast]
  );

  // ---------------------------------------------------------------------------
  // 7. Mouse Wheel Zoom & Middle-Button Pan
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const onWheel = (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      applyZoomWithCenteredPan(zoomRef.current * zoomFactor);
    };
    svgEl.addEventListener("wheel", onWheel, { passive: false });
    return () => svgEl.removeEventListener("wheel", onWheel);
  }, [applyZoomWithCenteredPan]);

  // ---------------------------------------------------------------------------
  // 8. Keyboard Shortcuts
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Do not trigger shortcuts if typing inside an input or textarea
      const target = e.target;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }

      // Undo: Ctrl+Z / Cmd+Z
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
        return;
      }

      // Redo: Ctrl+Y / Cmd+Y or Ctrl+Shift+Z
      if (
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")
      ) {
        e.preventDefault();
        handleRedo();
        return;
      }

      // Delete / Backspace: delete selection
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedAtomIds.size > 0 || selectedBondIds.size > 0) {
          e.preventDefault();
          let next = currentMol;
          if (selectedBondIds.size > 0) {
            next = removeBonds(next, Array.from(selectedBondIds));
          }
          if (selectedAtomIds.size > 0) {
            next = removeAtoms(next, Array.from(selectedAtomIds));
          }
          pushState(next);
          setSelectedAtomIds(new Set());
          setSelectedBondIds(new Set());
          showToast("Deleted selection.");
        }
        return;
      }

      // Escape: deselect or cancel
      if (e.key === "Escape") {
        setSelectedAtomIds(new Set());
        setSelectedBondIds(new Set());
        if (activeTool !== "select") setActiveTool("select");
        return;
      }

      // Zoom + / -
      if (e.key === "+" || e.key === "=") {
        handleZoomIn();
        return;
      }
      if (e.key === "-" || e.key === "_") {
        handleZoomOut();
        return;
      }
      if (e.key === "0") {
        handleFitToScreen();
        return;
      }

      // Tool shortcut keys
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === "s") setActiveTool("select");
        else if (k === "b") setActiveTool("bond");
        else if (k === "e") setActiveTool("erase");
        else if (k === "r") setActiveTool("ring");
        else if (k === "1") setCurrentBondOrder(1);
        else if (k === "2") setCurrentBondOrder(2);
        else if (k === "3") setCurrentBondOrder(3);
        else if (["c", "h", "o", "n", "p", "f", "i"].includes(k)) {
          setCurrentElement(k.toUpperCase());
          showToast(`Element: ${k.toUpperCase()}`);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    handleUndo,
    handleRedo,
    selectedAtomIds,
    selectedBondIds,
    currentMol,
    pushState,
    activeTool,
    handleZoomIn,
    handleZoomOut,
    handleFitToScreen,
    showToast,
  ]);

  // ---------------------------------------------------------------------------
  // 9. Interactive Drawing & Mouse Handlers
  // ---------------------------------------------------------------------------
  const handleMouseDown = useCallback(
    (e) => {
      // Middle click or Space+click = canvas pan
      if (e.button === 1 || e.spaceKey) {
        e.preventDefault();
        isMouseDownRef.current = true;
        dragModeRef.current = "pan";
        dragStartRef.current = { screenX: e.clientX, screenY: e.clientY, panX: pan.x, panY: pan.y };
        return;
      }

      if (e.button !== 0) return; // Only primary button

      const world = screenToWorld(e.clientX, e.clientY);
      const clickedAtom = findAtomNear(currentMol, world.x, world.y, BOND_LEN * 0.45);
      const clickedBond = !clickedAtom ? findBondNear(currentMol, world.x, world.y, 16) : null;

      isMouseDownRef.current = true;
      hasMovedRef.current = false;
      dragStartRef.current = {
        screenX: e.clientX,
        screenY: e.clientY,
        worldX: world.x,
        worldY: world.y,
        panX: pan.x,
        panY: pan.y,
      };

      // TOOL: ERASE
      if (activeTool === "erase") {
        if (clickedAtom) {
          pushState(removeAtom(currentMol, clickedAtom.id));
          setSelectedAtomIds(new Set());
          setSelectedBondIds(new Set());
          showToast(`Deleted atom ${clickedAtom.el}`);
        } else if (clickedBond) {
          pushState(removeBond(currentMol, clickedBond.id));
          setSelectedAtomIds(new Set());
          setSelectedBondIds(new Set());
          showToast("Deleted bond");
        }
        return;
      }

      // TOOL: CHARGE
      if (activeTool === "charge") {
        if (clickedAtom) {
          pushState(cycleAtomCharge(currentMol, clickedAtom.id, chargeDelta));
          showToast(`Adjusted charge on atom ${clickedAtom.el}`);
        }
        return;
      }

      // TOOL: RING TEMPLATE
      if (activeTool === "ring") {
        if (clickedAtom) {
          // Attach ring as substituent to existing atom
          const next = placeRing(
            currentMol,
            currentRing.size,
            { type: "atom", id: clickedAtom.id },
            currentRing.aromatic
          );
          pushState(next);
          showToast(`Attached ${currentRing.name} ring to atom`);
        } else if (clickedBond) {
          // Fuse ring onto existing bond
          const next = placeRing(
            currentMol,
            currentRing.size,
            { type: "bond", id: clickedBond.id },
            currentRing.aromatic
          );
          pushState(next);
          showToast(`Fused ${currentRing.name} ring to bond`);
        } else {
          // Place ring on empty canvas
          const next = placeRing(
            currentMol,
            currentRing.size,
            { type: "point", x: world.x, y: world.y },
            currentRing.aromatic
          );
          pushState(next);
          showToast(`Placed ${currentRing.name} ring`);
        }
        return;
      }

      // TOOL: SELECT / MOVE
      if (activeTool === "select") {
        if (clickedAtom) {
          let nextSelection = new Set(selectedAtomIds);
          if (e.shiftKey) {
            if (nextSelection.has(clickedAtom.id)) nextSelection.delete(clickedAtom.id);
            else nextSelection.add(clickedAtom.id);
          } else if (e.altKey) {
            // Select entire connected component
            const comp = getConnectedComponent(currentMol, clickedAtom.id);
            nextSelection = new Set(comp);
          } else if (!nextSelection.has(clickedAtom.id)) {
            nextSelection = new Set([clickedAtom.id]);
          }
          setSelectedAtomIds(nextSelection);
          setSelectedBondIds(new Set());

          // Prepare atom drag
          dragModeRef.current = "move_atom";
          const coordsMap = new Map();
          for (const a of currentMol.atoms) {
            if (nextSelection.has(a.id)) {
              coordsMap.set(a.id, { x: a.x, y: a.y });
            }
          }
          initialAtomCoordsRef.current = coordsMap;
        } else if (clickedBond) {
          if (e.shiftKey) {
            const nextB = new Set(selectedBondIds);
            if (nextB.has(clickedBond.id)) nextB.delete(clickedBond.id);
            else nextB.add(clickedBond.id);
            setSelectedBondIds(nextB);
          } else {
            setSelectedBondIds(new Set([clickedBond.id]));
            setSelectedAtomIds(new Set());
          }
        } else {
          // Clicked empty background: drag pan or clear selection
          if (!e.shiftKey) {
            setSelectedAtomIds(new Set());
            setSelectedBondIds(new Set());
          }
          dragModeRef.current = "pan";
        }
        return;
      }

      // TOOL: DRAW BOND / ATOM
      if (activeTool === "bond") {
        if (clickedAtom) {
          // Start drawing bond from clicked atom
          dragModeRef.current = "draw_bond";
          dragStartRef.current.fromAtomId = clickedAtom.id;
          dragStartRef.current.fromPos = { x: clickedAtom.x, y: clickedAtom.y };
        } else if (clickedBond) {
          // Quick click on bond toggles order (1 -> 2 -> 3 -> 1)
          const nextOrder = (clickedBond.order % 3) + 1;
          pushState(setBondOrder(currentMol, clickedBond.id, nextOrder));
          showToast(`Bond order changed to ${nextOrder === 1 ? "Single" : nextOrder === 2 ? "Double" : "Triple"}`);
        } else {
          // Click on empty space: start drawing bond from new atom
          dragModeRef.current = "draw_bond";
          dragStartRef.current.fromAtomId = null;
          dragStartRef.current.fromPos = { x: world.x, y: world.y };
        }
      }
    },
    [
      screenToWorld,
      currentMol,
      pan.x,
      pan.y,
      activeTool,
      chargeDelta,
      currentRing,
      selectedAtomIds,
      selectedBondIds,
      pushState,
      showToast,
    ]
  );

  const handleMouseMove = useCallback(
    (e) => {
      const world = screenToWorld(e.clientX, e.clientY);

      // Update hover state when not dragging
      if (!isMouseDownRef.current) {
        const hAtom = findAtomNear(currentMol, world.x, world.y, BOND_LEN * 0.45);
        const hBond = !hAtom ? findBondNear(currentMol, world.x, world.y, 16) : null;
        setHoverAtomId(hAtom ? hAtom.id : null);
        setHoverBondId(hBond ? hBond.id : null);
        return;
      }

      // Mouse is down: check if moved past jitter threshold
      const dist = Math.hypot(
        e.clientX - dragStartRef.current.screenX,
        e.clientY - dragStartRef.current.screenY
      );
      if (dist > 4) {
        hasMovedRef.current = true;
      }

      // PAN MODE
      if (dragModeRef.current === "pan") {
        const dx = e.clientX - dragStartRef.current.screenX;
        const dy = e.clientY - dragStartRef.current.screenY;
        const nextPan = {
          x: dragStartRef.current.panX + dx,
          y: dragStartRef.current.panY + dy,
        };
        if (Math.hypot(dx, dy) > 4) {
          hasUserAdjustedViewportRef.current = true;
        }
        panRef.current = nextPan;
        setPan(nextPan);
        return;
      }

      // MOVE ATOM(S) MODE
      if (dragModeRef.current === "move_atom") {
        const dx = world.x - dragStartRef.current.worldX;
        const dy = world.y - dragStartRef.current.worldY;
        const coordsMap = initialAtomCoordsRef.current;

        // Reposition all selected atoms
        const updatedAtoms = currentMol.atoms.map((a) => {
          const init = coordsMap.get(a.id);
          if (init) {
            return { ...a, x: +(init.x + dx).toFixed(2), y: +(init.y + dy).toFixed(2) };
          }
          return a;
        });

        // Do direct state update during drag (without pushing 60 history frames per second)
        isInternalEditRef.current = true;
        if (isControlled) {
          onMolChange({ ...currentMol, atoms: updatedAtoms });
        } else {
          setInternalMol({ ...currentMol, atoms: updatedAtoms });
        }
        return;
      }

      // DRAW BOND MODE
      if (dragModeRef.current === "draw_bond") {
        const fromPos = dragStartRef.current.fromPos;
        const fromAtomId = dragStartRef.current.fromAtomId;
        const target = findAtomNear(currentMol, world.x, world.y, BOND_LEN * 0.55, fromAtomId ? [fromAtomId] : []);
        const snapped = previewBondEnd(currentMol, fromPos, world, fromAtomId);

        setDragPreview({
          from: fromPos,
          to: snapped,
          targetAtomId: target ? target.id : null,
          fromAtomId,
        });
      }
    },
    [screenToWorld, currentMol, isControlled, onMolChange]
  );

  const handleMouseUp = useCallback(
    (e) => {
      if (!isMouseDownRef.current) return;
      isMouseDownRef.current = false;
      const mode = dragModeRef.current;
      dragModeRef.current = null;
      setDragPreview(null);

      const world = screenToWorld(e.clientX, e.clientY);

      // 1. Finished moving atom(s)
      if (mode === "move_atom") {
        if (hasMovedRef.current) {
          // Push final state into history
          pushState(currentMol);
        } else {
          // Quick click without drag: if in select mode, selection already handled
        }
        return;
      }

      // 2. Finished drawing bond
      if (mode === "draw_bond") {
        const fromPos = dragStartRef.current.fromPos;
        const fromAtomId = dragStartRef.current.fromAtomId;

        if (!hasMovedRef.current) {
          // QUICK CLICK:
          if (fromAtomId != null) {
            const atom = getAtom(currentMol, fromAtomId);
            if (atom && atom.el !== currentElement) {
              // Clicked atom with different element selected -> change element!
              pushState(setAtomElement(currentMol, fromAtomId, currentElement));
              showToast(`Changed atom to ${currentElement}`);
            } else {
              // Same element -> add substituent branch!
              const next = addSubstituent(currentMol, fromAtomId, currentElement, currentBondOrder);
              pushState(next);
              showToast(`Added ${currentElement} branch`);
            }
          } else {
            // Clicked empty space -> drop single new atom
            const { mol: next } = addAtom(currentMol, world.x, world.y, currentElement);
            pushState(next);
            showToast(`Placed ${currentElement} atom`);
          }
        } else {
          // DRAG FINISHED: Commit bond
          const next = drawBondTo(
            currentMol,
            fromAtomId,
            fromPos,
            world,
            currentBondOrder,
            currentElement
          );
          pushState(next);
          showToast(`Created bond (${currentBondOrder === 1 ? "single" : currentBondOrder === 2 ? "double" : "triple"})`);
        }
      }
    },
    [
      screenToWorld,
      currentMol,
      currentElement,
      currentBondOrder,
      pushState,
      showToast,
    ]
  );

  // ---------------------------------------------------------------------------
  // 10. Filtered Periodic Table Elements & Zoom Display
  // ---------------------------------------------------------------------------
  const filteredElements = useMemo(() => {
    if (!periodicFilter.trim()) return ALL_ELEMENTS;
    const q = periodicFilter.toLowerCase().trim();
    return ALL_ELEMENTS.filter(
      (el) =>
        el.symbol.toLowerCase().includes(q) ||
        el.name.toLowerCase().includes(q) ||
        String(el.number).includes(q)
    );
  }, [periodicFilter]);

  const zoomPercent = Math.round(zoom * 100);
  const zoomOptions = useMemo(() => {
    const set = new Set([...ZOOM_PRESETS, zoomPercent]);
    return Array.from(set).sort((a, b) => a - b);
  }, [zoomPercent]);

  // ---------------------------------------------------------------------------
  // 11. Render Component
  // ---------------------------------------------------------------------------
  return (
    <div
      ref={containerRef}
      className={`w-full flex flex-col bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden relative select-none ${className}`}
      style={{ minHeight: "600px", height: "100%" }}
    >
      {/* ------------------------------------------------------------------ */}
      {/* Top Main Toolbar                                                   */}
      {/* ------------------------------------------------------------------ */}
      <header className="bg-slate-50 border-b border-slate-200 px-4 py-2 flex flex-wrap items-center justify-between gap-3 text-xs z-20">
        {/* Left Section: Modes & Core Tools */}
        <div className="flex items-center flex-wrap gap-1">
          {/* Select / Move Tool */}
          <button
            type="button"
            onClick={() => setActiveTool("select")}
            className={`px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
              activeTool === "select"
                ? "bg-indigo-600 text-white shadow-sm"
                : "bg-white hover:bg-slate-100 text-slate-700 border border-slate-200"
            }`}
            title="Select and Move atoms / groups (Shortcut: S)"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.042 21.672L13.684 16.6m0 0l-2.51 2.225.569-9.47 5.227 7.917-3.286-.672zM12 2.25V4.5m5.834.666l-1.591 1.591M21.75 12h-2.25m-.666 5.834l-1.591-1.591M2.25 12h2.25m1.334-5.834l1.591 1.591" />
            </svg>
            <span>Select</span>
          </button>

          {/* Draw Bond / Atom Tool */}
          <button
            type="button"
            onClick={() => setActiveTool("bond")}
            className={`px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
              activeTool === "bond"
                ? "bg-indigo-600 text-white shadow-sm"
                : "bg-white hover:bg-slate-100 text-slate-700 border border-slate-200"
            }`}
            title="Draw bonds and place atoms (Shortcut: B)"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125" />
            </svg>
            <span>Draw</span>
          </button>

          {/* Erase Tool */}
          <button
            type="button"
            onClick={() => setActiveTool("erase")}
            className={`px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
              activeTool === "erase"
                ? "bg-red-600 text-white shadow-sm"
                : "bg-white hover:bg-red-50 text-slate-700 hover:text-red-700 border border-slate-200"
            }`}
            title="Erase atoms and bonds (Shortcut: E)"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
            <span>Erase</span>
          </button>

          {/* Charge Tool (+ / -) */}
          <button
            type="button"
            onClick={() => {
              setActiveTool("charge");
              setChargeDelta((prev) => (prev === 1 ? -1 : 1));
            }}
            className={`px-2.5 py-1.5 rounded-lg font-bold flex items-center gap-1 transition-colors cursor-pointer ${
              activeTool === "charge"
                ? "bg-amber-600 text-white shadow-sm"
                : "bg-white hover:bg-slate-100 text-slate-700 border border-slate-200"
            }`}
            title={`Formal Charge: Click atom to apply ${chargeDelta > 0 ? "+1" : "-1"} charge`}
          >
            <span>{chargeDelta > 0 ? "Charge (+)" : "Charge (-)"}</span>
          </button>

          <span className="w-px h-5 bg-slate-300 mx-1" />

          {/* Bond Orders: Single, Double, Triple */}
          <div className="flex items-center bg-white rounded-lg border border-slate-200 p-0.5">
            <button
              type="button"
              onClick={() => {
                setCurrentBondOrder(1);
                if (activeTool !== "bond") setActiveTool("bond");
              }}
              className={`px-2.5 py-1 rounded font-bold transition-colors cursor-pointer ${
                currentBondOrder === 1
                  ? "bg-indigo-100 text-indigo-800"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
              title="Single Bond (Shortcut: 1)"
            >
              — Single
            </button>
            <button
              type="button"
              onClick={() => {
                setCurrentBondOrder(2);
                if (activeTool !== "bond") setActiveTool("bond");
              }}
              className={`px-2.5 py-1 rounded font-bold transition-colors cursor-pointer ${
                currentBondOrder === 2
                  ? "bg-indigo-100 text-indigo-800"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
              title="Double Bond (Shortcut: 2)"
            >
              = Double
            </button>
            <button
              type="button"
              onClick={() => {
                setCurrentBondOrder(3);
                if (activeTool !== "bond") setActiveTool("bond");
              }}
              className={`px-2.5 py-1 rounded font-bold transition-colors cursor-pointer ${
                currentBondOrder === 3
                  ? "bg-indigo-100 text-indigo-800"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
              title="Triple Bond (Shortcut: 3)"
            >
              ≡ Triple
            </button>
          </div>

          <span className="w-px h-5 bg-slate-300 mx-1" />

          {/* Ring Templates */}
          <div className="flex items-center bg-white rounded-lg border border-slate-200 p-0.5">
            {[
              { size: 6, aromatic: true, name: "Benzene", label: "⬡ Benzene" },
              { size: 6, aromatic: false, name: "Cyclohexane", label: "⬡ 6-Ring" },
              { size: 5, aromatic: false, name: "Cyclopentane", label: "⬠ 5-Ring" },
              { size: 4, aromatic: false, name: "Cyclobutane", label: "◻ 4-Ring" },
              { size: 3, aromatic: false, name: "Cyclopropane", label: "△ 3-Ring" },
            ].map((r) => (
              <button
                key={r.name}
                type="button"
                onClick={() => {
                  setCurrentRing(r);
                  setActiveTool("ring");
                }}
                className={`px-2 py-1 rounded font-semibold transition-colors cursor-pointer ${
                  activeTool === "ring" && currentRing.name === r.name
                    ? "bg-indigo-100 text-indigo-800"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
                title={`Insert ${r.name} Ring Template`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* Right Section: Undo/Redo, Import, Clean, Zoom, Fit */}
        <div className="flex items-center flex-wrap gap-1.5">
          <button
            type="button"
            onClick={handleUndo}
            disabled={!canUndo}
            className="p-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
            </svg>
          </button>

          <button
            type="button"
            onClick={handleRedo}
            disabled={!canRedo}
            className="p-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Redo (Ctrl+Y)"
            aria-label="Redo"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 15l6-6m0 0l-6-6m6 6H9a6 6 0 000 12h3" />
            </svg>
          </button>

          <button
            type="button"
            onClick={() => {
              setImportError(null);
              setShowImportModal(true);
            }}
            className="px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 hover:bg-slate-100 font-medium transition-colors cursor-pointer"
            title="Import structure from SMILES or Molfile"
          >
            Import
          </button>

          <button
            type="button"
            onClick={handleCleanStructure}
            disabled={!currentMol.atoms || currentMol.atoms.length === 0}
            className="px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed font-medium transition-colors cursor-pointer"
            title="Clean 2D Coordinates & Angles"
          >
            Clean Layout
          </button>

          <button
            type="button"
            onClick={handleClear}
            disabled={!currentMol.atoms || currentMol.atoms.length === 0}
            className="px-2 py-1.5 rounded-lg bg-white border border-slate-200 text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed font-medium transition-colors cursor-pointer"
            title="Clear all atoms and bonds"
          >
            Clear
          </button>

          <span className="w-px h-5 bg-slate-300 mx-1" />

          {/* Unified Zoom & Fit-to-Screen Controls */}
          <div className="flex items-center bg-white rounded-lg border border-slate-200 p-0.5 gap-0.5">
            <button
              type="button"
              onClick={handleZoomOut}
              disabled={zoom <= MIN_ZOOM}
              className="p-1.5 rounded-md text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              title="Zoom Out (−)"
              aria-label="Zoom Out"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" />
              </svg>
            </button>

            <select
              value={zoomPercent}
              onChange={(e) => handleSetZoomPercent(Number(e.target.value))}
              aria-label="Zoom Percentage"
              title="Zoom Percentage"
              className="px-1.5 py-1 text-xs font-semibold text-slate-700 bg-transparent hover:bg-slate-100 rounded-md focus:outline-none cursor-pointer font-mono"
            >
              {zoomOptions.map((pct) => (
                <option key={pct} value={pct}>
                  {pct}%
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={handleZoomIn}
              disabled={zoom >= MAX_ZOOM}
              className="p-1.5 rounded-md text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              title="Zoom In (+)"
              aria-label="Zoom In"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </button>

            <span className="w-px h-4 bg-slate-200 mx-0.5" />

            <button
              type="button"
              onClick={handleFitToScreen}
              className="px-2 py-1 rounded-md text-slate-700 hover:bg-indigo-50 hover:text-indigo-700 font-semibold flex items-center gap-1 transition-colors cursor-pointer"
              title="Fit Structure to Screen (Shortcut: 0)"
              aria-label="Fit to Screen"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
              <span>Fit to Screen</span>
            </button>
          </div>

          {onSwitchToMobile && (
            <button
              type="button"
              onClick={onSwitchToMobile}
              className="ml-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 flex items-center gap-1 transition-colors cursor-pointer"
              title="Switch to Mobile Touch Editor"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
              </svg>
              <span>Mobile View</span>
            </button>
          )}
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Workspace Body: Left Element Sidebar + Main SVG Drawing Canvas     */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex-1 flex w-full relative overflow-hidden bg-slate-100/60 min-h-[500px]">
        {/* Left Elements Palette */}
        <aside className="w-14 bg-slate-50 border-r border-slate-200 p-2 flex flex-col items-center gap-1.5 z-10 shrink-0 select-none">
          <span className="text-3xs font-bold text-slate-400 uppercase tracking-widest mb-0.5">
            Atoms
          </span>

          {COMMON_ELEMENTS.map((el) => {
            const isSelected = currentElement === el;
            const color = ELEMENT_COLORS[el] || "#334155";
            return (
              <button
                key={el}
                type="button"
                onClick={() => {
                  setCurrentElement(el);
                  if (activeTool !== "bond" && activeTool !== "select") {
                    setActiveTool("bond");
                  }
                  showToast(`Selected element ${el}`);
                }}
                className={`w-10 h-10 rounded-xl font-bold text-sm flex flex-col items-center justify-center transition-all cursor-pointer ${
                  isSelected
                    ? "bg-white shadow-md border-2 border-indigo-600 scale-105"
                    : "bg-white/80 hover:bg-white text-slate-700 border border-slate-200 hover:shadow-xs"
                }`}
                style={{ color: isSelected ? color : undefined }}
                title={`Select ${el} (Shortcut: ${el.toLowerCase()})`}
              >
                <span>{el}</span>
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => setShowPeriodicTable(true)}
            className="w-10 h-10 mt-1 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 font-bold text-2xs flex flex-col items-center justify-center transition-colors cursor-pointer"
            title="Open Periodic Table"
          >
            <span>Table</span>
            <span className="text-3xs text-indigo-500">118</span>
          </button>
        </aside>

        {/* Main Molecular Canvas Area */}
        <div
          ref={canvasContainerRef}
          className="flex-1 relative w-full h-full min-h-[500px] overflow-hidden cursor-crosshair"
        >
          {/* Toast Notification */}
          {toastMsg && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 bg-slate-900/90 text-white text-xs font-medium px-4 py-1.5 rounded-full shadow-lg backdrop-blur-md animate-in fade-in slide-in-from-top-1 pointer-events-none">
              {toastMsg}
            </div>
          )}

          {/* SVG Canvas */}
          <svg
            ref={svgRef}
            viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
            width="100%"
            height="100%"
            className="w-full h-full block"
            style={{ width: "100%", height: "100%", minHeight: "500px", display: "block" }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            role="region"
            aria-label="Desktop Molecular Drawing Canvas"
          >
            {/* Dot Grid Background */}
            <defs>
              <pattern id="desktop-dot-grid" width="32" height="32" patternUnits="userSpaceOnUse">
                <circle cx="16" cy="16" r="1.5" fill="#94a3b8" opacity="0.6" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="#f8fafc" />
            <rect width="100%" height="100%" fill="url(#desktop-dot-grid)" />

            {/* Centered Transformation Group */}
            <g
              ref={worldGroupRef}
              transform={`translate(${dimensions.width / 2 + pan.x}, ${dimensions.height / 2 + pan.y}) scale(${zoom})`}
            >
              {/* Bonds Rendering */}
              {currentMol.bonds.map((b) => {
                const a1 = getAtom(currentMol, b.a);
                const a2 = getAtom(currentMol, b.b);
                if (!a1 || !a2) return null;

                const dx = a2.x - a1.x;
                const dy = a2.y - a1.y;
                const len = Math.hypot(dx, dy) || 1;
                const nx = -dy / len;
                const ny = dx / len;
                const isSelected = selectedBondIds.has(b.id);
                const isHovered = hoverBondId === b.id;

                return (
                  <g key={`bond-${b.id}`}>
                    {/* Generous Hit Line for Mouse Hover & Click */}
                    <line
                      x1={a1.x}
                      y1={a1.y}
                      x2={a2.x}
                      y2={a2.y}
                      stroke="transparent"
                      strokeWidth="24"
                      strokeLinecap="round"
                    />

                    {/* Selected / Hover Bond Glow */}
                    {(isSelected || isHovered) && (
                      <line
                        x1={a1.x}
                        y1={a1.y}
                        x2={a2.x}
                        y2={a2.y}
                        stroke={isSelected ? "#6366f1" : "#93c5fd"}
                        strokeWidth="10"
                        strokeOpacity="0.45"
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

              {/* Live Interactive Bond Drag Preview */}
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

              {/* Atoms Rendering */}
              {currentMol.atoms.map((a) => {
                const isSelected = selectedAtomIds.has(a.id);
                const isHovered = hoverAtomId === a.id;
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
                    {/* Generous Hit Circle */}
                    <circle cx="0" cy="0" r="18" fill="transparent" />

                    {/* Selected / Hover Atom Glow */}
                    {(isSelected || isHovered) && (
                      <circle
                        cx="0"
                        cy="0"
                        r={showText ? 18 : 12}
                        fill={isSelected ? "#e0e7ff" : "#f1f5f9"}
                        stroke={isSelected ? "#4f46e5" : "#94a3b8"}
                        strokeWidth="2"
                        strokeDasharray={isSelected ? "3 3" : undefined}
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
                        strokeDasharray="2 2"
                      />
                    )}

                    {/* Formal Charge Badge */}
                    {a.charge !== 0 && (
                      <g transform={`translate(${showText ? 10 : 7}, ${showText ? -9 : -7})`}>
                        <circle cx="0" cy="0" r="6.5" fill="#4f46e5" />
                        <text
                          x="0"
                          y="0"
                          dy="0.35em"
                          textAnchor="middle"
                          fill="#ffffff"
                          fontSize="9"
                          fontWeight="bold"
                        >
                          {a.charge > 1 ? `${a.charge}+` : a.charge === 1 ? "+" : a.charge < -1 ? `${Math.abs(a.charge)}-` : "-"}
                        </text>
                      </g>
                    )}

                    {/* Heteroatom or Isolated Carbon */}
                    {showText ? (
                      <>
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

          {/* Subtle non-blocking empty canvas hint */}
          {currentMol.atoms.length === 0 && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-white/85 border border-slate-200/80 rounded-full px-4 py-1.5 shadow-xs backdrop-blur-xs pointer-events-none z-10 text-xs text-slate-500 font-medium">
              Click or drag anywhere on the canvas to draw
            </div>
          )}

          {/* Selection indicator pill */}
          {(selectedAtomIds.size > 0 || selectedBondIds.size > 0) && (
            <div className="absolute bottom-4 left-4 z-20 flex items-center gap-2.5 bg-white/95 border border-slate-200 rounded-xl px-3 py-1.5 shadow-md backdrop-blur-sm animate-in fade-in">
              <span className="text-2xs font-semibold text-slate-400 uppercase tracking-wider">Selected:</span>
              <span className="text-xs font-bold text-indigo-700">
                {selectedAtomIds.size > 0 && `${selectedAtomIds.size} atom${selectedAtomIds.size > 1 ? "s" : ""}`}
                {selectedAtomIds.size > 0 && selectedBondIds.size > 0 && ", "}
                {selectedBondIds.size > 0 && `${selectedBondIds.size} bond${selectedBondIds.size > 1 ? "s" : ""}`}
              </span>
              <button
                type="button"
                onClick={() => {
                  setSelectedAtomIds(new Set());
                  setSelectedBondIds(new Set());
                }}
                className="text-2xs text-slate-400 hover:text-slate-700 underline cursor-pointer ml-1"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Bottom Status & Real-Time Chemistry Strip                          */}
      {/* ------------------------------------------------------------------ */}
      <footer className="bg-slate-50 border-t border-slate-200 px-4 py-2 flex flex-wrap items-center justify-between gap-3 text-xs z-20">
        {/* Real-time Chemical Properties */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-slate-400 font-medium">Formula:</span>
            <span className="font-bold text-slate-800">
              {chemicalInfo.formula || <span className="text-slate-400 italic">None</span>}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-slate-400 font-medium">MW:</span>
            <span className="font-bold text-slate-800">
              {chemicalInfo.weight ? `${chemicalInfo.weight} g/mol` : <span className="text-slate-400 italic">—</span>}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-slate-400 font-medium">Atoms:</span>
            <span className="font-semibold text-slate-700">{chemicalInfo.atomCount}</span>
            <span className="text-slate-300">|</span>
            <span className="text-slate-400 font-medium">Bonds:</span>
            <span className="font-semibold text-slate-700">{chemicalInfo.bondCount}</span>
          </div>

          {chemicalInfo.smiles && (
            <div className="hidden lg:flex items-center gap-1.5 text-2xs bg-white border border-slate-200 px-2.5 py-0.5 rounded-lg max-w-sm truncate text-slate-600 font-mono">
              <span className="text-slate-400 font-sans font-medium">SMILES:</span>
              <span className="truncate">{chemicalInfo.smiles}</span>
            </div>
          )}
        </div>

        {/* Action Buttons: Identify Structure & Open AI Chat */}
        <div className="flex items-center gap-2">
          {onIdentify && (
            <button
              type="button"
              onClick={() => onIdentify(chemicalInfo.smiles)}
              disabled={identifyLoading || chemicalInfo.atomCount === 0}
              className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer"
              title="Identify molecule in PubChem database"
            >
              {identifyLoading ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  <span>Identifying...</span>
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                  </svg>
                  <span>Identify Structure</span>
                </>
              )}
            </button>
          )}

          {onOpenChat && (
            <button
              type="button"
              onClick={() => onOpenChat(chemicalInfo.smiles)}
              disabled={chemicalInfo.atomCount === 0}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors cursor-pointer"
              title="Discuss structure with ChemAI Assistant"
            >
              <span>Ask AI</span>
            </button>
          )}
        </div>
      </footer>

      {/* ------------------------------------------------------------------ */}
      {/* Periodic Table Modal                                               */}
      {/* ------------------------------------------------------------------ */}
      {showPeriodicTable && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-5 shadow-2xl border border-slate-200 flex flex-col max-h-[85vh]">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div>
                <h3 className="text-base font-bold text-slate-900">Periodic Table of Elements</h3>
                <p className="text-xs text-slate-500">Pick any element to draw in your molecular structure</p>
              </div>
              <button
                type="button"
                onClick={() => setShowPeriodicTable(false)}
                className="w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center transition-colors cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="py-3">
              <input
                type="text"
                value={periodicFilter}
                onChange={(e) => setPeriodicFilter(e.target.value)}
                placeholder="Search element name, symbol, or atomic number..."
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 focus:outline-hidden focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            <div className="flex-1 overflow-y-auto grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-1.5 pr-1">
              {filteredElements.map((el) => {
                const color = ELEMENT_COLORS[el.symbol] || "#334155";
                return (
                  <button
                    key={el.symbol}
                    type="button"
                    onClick={() => {
                      setCurrentElement(el.symbol);
                      setShowPeriodicTable(false);
                      if (activeTool !== "bond" && activeTool !== "select") {
                        setActiveTool("bond");
                      }
                      showToast(`Selected element ${el.symbol} (${el.name})`);
                    }}
                    className="flex flex-col items-center justify-center p-2 rounded-xl border border-slate-200 hover:border-indigo-500 hover:bg-indigo-50/50 transition-colors cursor-pointer"
                  >
                    <span className="text-3xs text-slate-400 font-mono">{el.number}</span>
                    <span className="text-base font-bold" style={{ color }}>
                      {el.symbol}
                    </span>
                    <span className="text-3xs text-slate-500 truncate max-w-full">{el.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Import Structure Modal (SMILES / MDL Molfile)                      */}
      {/* ------------------------------------------------------------------ */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-5 shadow-2xl border border-slate-200 flex flex-col gap-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div>
                <h3 className="text-base font-bold text-slate-900">Import Molecular Structure</h3>
                <p className="text-xs text-slate-500">
                  Paste a SMILES string or MDL Molfile (V2000/V3000) to render centered on canvas
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowImportModal(false);
                  setImportError(null);
                }}
                className="w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center transition-colors cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleImportSubmit} className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">
                  SMILES or Molfile Content
                </label>
                <textarea
                  rows={5}
                  value={importText}
                  onChange={(e) => {
                    setImportText(e.target.value);
                    if (importError) setImportError(null);
                  }}
                  placeholder="e.g. CC(=O)Nc1ccc(O)cc1 (Paracetamol) or paste V2000 Molfile..."
                  className="w-full px-3 py-2 text-xs font-mono rounded-xl border border-slate-300 focus:outline-hidden focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              {importError && (
                <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-2.5">
                  {importError}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => {
                    setShowImportModal(false);
                    setImportError(null);
                  }}
                  className="px-3.5 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-xs transition-colors cursor-pointer"
                >
                  Load Structure
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

