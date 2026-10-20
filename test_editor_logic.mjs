import {
  BOND_LEN,
  EMPTY_MOL,
  addAtom,
  addBond,
  setBondOrder,
  setAtomElement,
  removeAtom,
  removeBond,
  moveAtoms,
  valenceMap,
  isOvervalent,
  implicitHydrogens,
  molFromSmiles,
  computeViewportTransform,
} from "./frontend/src/lib/mobileMolecule.js";

function assert(condition, message) {
  if (!condition) {
    console.error("FAIL:", message);
    process.exit(1);
  }
  console.log("PASS:", message);
}

console.log("--- Starting Coordinate & Editor Logic Tests ---");

// Test 1: Coordinate mapping formula simulation
function simulateScreenToWorld(clientX, clientY, rect, pan, zoom) {
  const screenX = clientX - rect.left;
  const screenY = clientY - rect.top;
  return {
    x: (screenX - rect.width / 2 - pan.x) / zoom,
    y: (screenY - rect.height / 2 - pan.y) / zoom,
  };
}

const rect1 = { left: 0, top: 50, width: 360, height: 500 };
const w1 = simulateScreenToWorld(180, 300, rect1, { x: 0, y: 0 }, 1.0);
assert(Math.abs(w1.x) < 1e-6 && Math.abs(w1.y) < 1e-6, "Center of canvas maps to (0, 0)");

const w2 = simulateScreenToWorld(180 + 40, 300, rect1, { x: 0, y: 0 }, 1.0);
assert(Math.abs(w2.x - 40) < 1e-6 && Math.abs(w2.y) < 1e-6, "(180+40, 300) maps to (40, 0)");

const wZoom = simulateScreenToWorld(180 + 80, 300, rect1, { x: 0, y: 0 }, 2.0);
assert(Math.abs(wZoom.x - 40) < 1e-6, "With zoom=2, 80px screen offset maps to 40 world units");

const wPan = simulateScreenToWorld(180 + 20, 300, rect1, { x: 20, y: 0 }, 1.0);
assert(Math.abs(wPan.x) < 1e-6, "Pan shifts screen-to-world mapping correctly");

// Test 2: History Stack Invariants
let history = { past: [], future: [] };
let current = EMPTY_MOL;

function pushState(newMol) {
  if (current === newMol) return;
  history = { past: [...history.past.slice(-25), current], future: [] };
  current = newMol;
}

function undo() {
  if (history.past.length === 0) return;
  const previous = history.past[history.past.length - 1];
  history = {
    past: history.past.slice(0, -1),
    future: [current, ...history.future],
  };
  current = previous;
}

function redo() {
  if (history.future.length === 0) return;
  const next = history.future[0];
  history = {
    past: [...history.past, current],
    future: history.future.slice(1),
  };
  current = next;
}

// Perform edits
const step1 = addAtom(current, 0, 0, "C").mol;
pushState(step1);
assert(current.atoms.length === 1 && history.past.length === 1, "History records 1st atom addition");

const step2 = addAtom(current, 40, 0, "C").mol;
pushState(step2);
assert(current.atoms.length === 2 && history.past.length === 2, "History records 2nd atom addition");

const step3 = addBond(current, current.atoms[0].id, current.atoms[1].id, 1);
pushState(step3);
assert(current.bonds.length === 1 && history.past.length === 3, "History records bond creation");

// Test Undo
undo();
assert(current.bonds.length === 0 && current.atoms.length === 2, "Undo removes bond");
undo();
assert(current.atoms.length === 1, "Undo removes 2nd atom");
undo();
assert(current.atoms.length === 0, "Undo restores empty state");

// Test Redo
redo();
assert(current.atoms.length === 1, "Redo restores 1st atom");
redo();
assert(current.atoms.length === 2, "Redo restores 2nd atom");
redo();
assert(current.bonds.length === 1, "Redo restores bond");

// Test 3: Atom Movement History
const molBeforeMove = current;
const movedMol = moveAtoms(current, [current.atoms[0].id], 15, -10);
// Commit movement
history = { past: [...history.past.slice(-25), molBeforeMove], future: [] };
current = movedMol;
assert(current.atoms[0].x === 15 && current.atoms[0].y === -10, "Atom moved to new coords");
undo();
assert(current.atoms[0].x === 0 && current.atoms[0].y === 0, "Undo reverts atom coordinates");

// Test 4: Atom & Bond Deletion Invariants
const molWithAtomDeleted = removeAtom(step3, step3.atoms[0].id);
assert(molWithAtomDeleted.atoms.length === 1, "Atom deleted");
assert(molWithAtomDeleted.bonds.length === 0, "Incident bond automatically deleted when atom removed");

// Test 5: Valence and Overvalence checks
let valMol = EMPTY_MOL;
const cv = addAtom(valMol, 0, 0, "C");
let mVal = cv.mol;
const cId = cv.id;
for (let i = 0; i < 5; i++) {
  const o = addAtom(mVal, 40 * Math.cos(i), 40 * Math.sin(i), "C");
  mVal = addBond(o.mol, cId, o.id, 1);
}
const vMap = valenceMap(mVal);
assert(vMap.get(cId) === 5, "Carbon has valence 5 with 5 single bonds");
assert(isOvervalent(mVal.atoms[0], vMap.get(cId)) === true, "isOvervalent correctly flags 5-valent carbon");

// Test 6: Bounding-box centering in molFromSmiles and computeViewportTransform across desktop viewports
const aspirinMol = molFromSmiles("CC(=O)Oc1ccccc1C(=O)O");
const viewports = [
  { w: 910, h: 500, label: "1024x768 canvas" },
  { w: 1170, h: 500, label: "1366x768 canvas" },
  { w: 1200, h: 560, label: "1920x1080 canvas" },
];
for (const vp of viewports) {
  const tf = computeViewportTransform(aspirinMol, vp.w, vp.h);
  assert(tf.zoom >= 1.2 && tf.zoom <= 2.0, `Aspirin zoom on ${vp.label} is readable (${tf.zoom})`);
  const screenCenterX = vp.w / 2 + tf.pan.x + tf.centerX * tf.zoom;
  const screenCenterY = vp.h / 2 + tf.pan.y + tf.centerY * tf.zoom;
  assert(
    Math.abs(screenCenterX - vp.w / 2) < 1 && Math.abs(screenCenterY - vp.h / 2) < 1,
    `Aspirin center maps to exact canvas midpoint on ${vp.label}`
  );
}

console.log("--- All Coordinate and Editor Logic Tests Passed! ---");
