import OCL from "openchemlib";

/**
 * Lightweight, immutable molecule model used by the mobile editor.
 *
 *   atom: { id, x, y, el, charge }
 *   bond: { id, a, b, order }   // order: 1 | 2 | 3
 *
 * Coordinates are in "world" units where one standard bond = BOND_LEN.
 * Conversion to SMILES / Molfile goes through OpenChemLib, the same engine
 * the desktop editor already uses for structure validation and export.
 */

export const BOND_LEN = 40;
export const EMPTY_MOL = Object.freeze({ atoms: [], bonds: [] });

let idCounter = 1;
const nextId = () => idCounter++;

/** Ensure freshly-restored molecules never collide with newly generated ids. */
export function reseedIds(mol) {
  let max = 0;
  for (const a of mol.atoms) max = Math.max(max, a.id);
  for (const b of mol.bonds) max = Math.max(max, b.id);
  if (max >= idCounter) idCounter = max + 1;
}

export function atomicNo(symbol) {
  return OCL.Molecule.getAtomicNoFromLabel(symbol) || 0;
}

/* ------------------------------------------------------------------ */
/* Elements                                                            */
/* ------------------------------------------------------------------ */

export const COMMON_ELEMENTS = ["C", "O", "N", "S", "P", "F", "Cl", "Br", "I", "H"];

const SYMBOLS =
  "H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og".split(" ");
const NAMES =
  "Hydrogen Helium Lithium Beryllium Boron Carbon Nitrogen Oxygen Fluorine Neon Sodium Magnesium Aluminium Silicon Phosphorus Sulfur Chlorine Argon Potassium Calcium Scandium Titanium Vanadium Chromium Manganese Iron Cobalt Nickel Copper Zinc Gallium Germanium Arsenic Selenium Bromine Krypton Rubidium Strontium Yttrium Zirconium Niobium Molybdenum Technetium Ruthenium Rhodium Palladium Silver Cadmium Indium Tin Antimony Tellurium Iodine Xenon Caesium Barium Lanthanum Cerium Praseodymium Neodymium Promethium Samarium Europium Gadolinium Terbium Dysprosium Holmium Erbium Thulium Ytterbium Lutetium Hafnium Tantalum Tungsten Rhenium Osmium Iridium Platinum Gold Mercury Thallium Lead Bismuth Polonium Astatine Radon Francium Radium Actinium Thorium Protactinium Uranium Neptunium Plutonium Americium Curium Berkelium Californium Einsteinium Fermium Mendelevium Nobelium Lawrencium Rutherfordium Dubnium Seaborgium Bohrium Hassium Meitnerium Darmstadtium Roentgenium Copernicium Nihonium Flerovium Moscovium Livermorium Tennessine Oganesson".split(" ");

export const ALL_ELEMENTS = SYMBOLS.map((symbol, i) => ({
  symbol,
  name: NAMES[i],
  number: i + 1,
}));

export const ELEMENT_COLORS = {
  O: "#dc2626",
  N: "#2563eb",
  S: "#b45309",
  P: "#ea580c",
  F: "#16a34a",
  Cl: "#16a34a",
  Br: "#9a3412",
  I: "#7e22ce",
};

/* ------------------------------------------------------------------ */
/* Valence helpers (display + warnings only; OCL computes real SMILES) */
/* ------------------------------------------------------------------ */

const DEFAULT_VALENCE = { C: 4, N: 3, O: 2, S: 2, P: 3, B: 3, Si: 4, Se: 2, F: 1, Cl: 1, Br: 1, I: 1, H: 1 };
const MAX_VALENCE = { C: 4, N: 3, O: 2, S: 6, P: 5, B: 4, Si: 4, Se: 6, F: 1, Cl: 7, Br: 7, I: 7, H: 1 };

function adjustForCharge(el, base, charge) {
  if (!charge) return base;
  if (el === "C") return base - Math.abs(charge);
  if (el === "N" || el === "O" || el === "P" || el === "S") return base + charge;
  if (el === "B") return base - charge;
  return base;
}

/** bond-order sum per atom id */
export function valenceMap(mol) {
  const map = new Map();
  for (const b of mol.bonds) {
    map.set(b.a, (map.get(b.a) || 0) + b.order);
    map.set(b.b, (map.get(b.b) || 0) + b.order);
  }
  return map;
}

export function implicitHydrogens(atom, bondSum) {
  const base = DEFAULT_VALENCE[atom.el];
  if (base == null) return 0;
  return Math.max(0, adjustForCharge(atom.el, base, atom.charge || 0) - bondSum);
}

export function isOvervalent(atom, bondSum) {
  const max = MAX_VALENCE[atom.el];
  if (max == null) return false;
  return bondSum > adjustForCharge(atom.el, max, atom.charge || 0);
}

/* ------------------------------------------------------------------ */
/* Basic queries                                                       */
/* ------------------------------------------------------------------ */

export const getAtom = (mol, id) => mol.atoms.find((a) => a.id === id);
export const getBond = (mol, id) => mol.bonds.find((b) => b.id === id);

export function findBond(mol, a, b) {
  return mol.bonds.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
}

export function neighborIds(mol, atomId) {
  const out = [];
  for (const b of mol.bonds) {
    if (b.a === atomId) out.push(b.b);
    else if (b.b === atomId) out.push(b.a);
  }
  return out;
}

export function hasDoubleBond(mol, atomId) {
  return mol.bonds.some((b) => (b.a === atomId || b.b === atomId) && b.order >= 2);
}

export function findAtomNear(mol, x, y, radius, excludeIds = []) {
  let best = null;
  let bestD = radius;
  for (const a of mol.atoms) {
    if (excludeIds.includes(a.id)) continue;
    const d = Math.hypot(a.x - x, a.y - y);
    if (d <= bestD) {
      best = a;
      bestD = d;
    }
  }
  return best;
}

export function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function findBondNear(mol, x, y, maxDist = BOND_LEN * 0.45) {
  let best = null;
  let bestD = maxDist;
  for (const b of mol.bonds) {
    const A = getAtom(mol, b.a);
    const B = getAtom(mol, b.b);
    if (!A || !B) continue;
    const d = distToSegment(x, y, A.x, A.y, B.x, B.y);
    if (d <= bestD) {
      best = b;
      bestD = d;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Immutable edits                                                     */
/* ------------------------------------------------------------------ */

export function addAtom(mol, x, y, el = "C") {
  const id = nextId();
  return { mol: { ...mol, atoms: [...mol.atoms, { id, x, y, el, charge: 0 }] }, id };
}

export function addBond(mol, a, b, order = 1) {
  if (a === b) return mol;
  const existing = findBond(mol, a, b);
  if (existing) return setBondOrder(mol, existing.id, order);
  return { ...mol, bonds: [...mol.bonds, { id: nextId(), a, b, order }] };
}

export function setBondOrder(mol, bondId, order) {
  return { ...mol, bonds: mol.bonds.map((b) => (b.id === bondId ? { ...b, order } : b)) };
}

export function setAtomElement(mol, atomId, el) {
  return {
    ...mol,
    atoms: mol.atoms.map((a) => (a.id === atomId ? { ...a, el } : a)),
  };
}

export function setAtomCharge(mol, atomId, charge) {
  return {
    ...mol,
    atoms: mol.atoms.map((a) => (a.id === atomId ? { ...a, charge: Number(charge) || 0 } : a)),
  };
}

export function cycleAtomCharge(mol, atomId, delta = 1) {
  const atom = getAtom(mol, atomId);
  if (!atom) return mol;
  let nextCharge = (atom.charge || 0) + delta;
  if (nextCharge > 2) nextCharge = -2;
  if (nextCharge < -2) nextCharge = 2;
  return setAtomCharge(mol, atomId, nextCharge);
}

export function removeAtom(mol, atomId) {
  return {
    atoms: mol.atoms.filter((a) => a.id !== atomId),
    bonds: mol.bonds.filter((b) => b.a !== atomId && b.b !== atomId),
  };
}

export function removeAtoms(mol, atomIds) {
  const set = new Set(atomIds);
  return {
    atoms: mol.atoms.filter((a) => !set.has(a.id)),
    bonds: mol.bonds.filter((b) => !set.has(b.a) && !set.has(b.b)),
  };
}

export function removeBond(mol, bondId) {
  return { ...mol, bonds: mol.bonds.filter((b) => b.id !== bondId) };
}

export function removeBonds(mol, bondIds) {
  const set = new Set(bondIds);
  return { ...mol, bonds: mol.bonds.filter((b) => !set.has(b.id)) };
}

export function moveAtoms(mol, ids, dx, dy, baseMol = mol) {
  const set = new Set(ids);
  return {
    ...mol,
    atoms: baseMol.atoms.map((a) => (set.has(a.id) ? { ...a, x: a.x + dx, y: a.y + dy } : a)),
  };
}

export function getConnectedComponent(mol, startAtomId) {
  const visited = new Set();
  const queue = [startAtomId];
  while (queue.length > 0) {
    const cur = queue.pop();
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const nb of neighborIds(mol, cur)) {
      if (!visited.has(nb)) queue.push(nb);
    }
  }
  return Array.from(visited);
}

/* ------------------------------------------------------------------ */
/* Geometry: where should a new substituent go?                        */
/* ------------------------------------------------------------------ */

export function freeDirection(mol, atomId) {
  const atom = getAtom(mol, atomId);
  const nbs = neighborIds(mol, atomId).map((id) => getAtom(mol, id)).filter(Boolean);
  if (!atom || nbs.length === 0) return -Math.PI / 6; // up-right

  const angles = nbs.map((n) => Math.atan2(n.y - atom.y, n.x - atom.x));

  if (nbs.length === 1) {
    // zig-zag: 120 degrees from the existing bond, on the less crowded side
    const candidates = [angles[0] + (2 * Math.PI) / 3, angles[0] - (2 * Math.PI) / 3];
    const scored = candidates.map((ang) => {
      const px = atom.x + BOND_LEN * Math.cos(ang);
      const py = atom.y + BOND_LEN * Math.sin(ang);
      let minD = Infinity;
      for (const a of mol.atoms) {
        if (a.id === atomId) continue;
        minD = Math.min(minD, Math.hypot(a.x - px, a.y - py));
      }
      return { ang, minD };
    });
    const [c1, c2] = scored;
    if (Math.abs(c1.minD - c2.minD) > 1) return c1.minD > c2.minD ? c1.ang : c2.ang;
    // tie: prefer growing to the right, then upward
    const cos1 = Math.cos(c1.ang);
    const cos2 = Math.cos(c2.ang);
    if (Math.abs(cos1 - cos2) > 1e-3) return cos1 > cos2 ? c1.ang : c2.ang;
    return Math.sin(c1.ang) < Math.sin(c2.ang) ? c1.ang : c2.ang;
  }

  // bisect the largest angular gap between existing bonds
  const sorted = angles.map((a) => (a + 2 * Math.PI) % (2 * Math.PI)).sort((a, b) => a - b);
  let bestGap = -1;
  let bestMid = 0;
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const next = i === sorted.length - 1 ? sorted[0] + 2 * Math.PI : sorted[i + 1];
    const gap = next - cur;
    if (gap > bestGap) {
      bestGap = gap;
      bestMid = cur + gap / 2;
    }
  }
  return bestMid;
}

/** Add a new atom bonded to `atomId`, merging with a nearby atom if one is already there. */
export function addSubstituent(mol, atomId, el = "C", order = 1) {
  const atom = getAtom(mol, atomId);
  if (!atom) return mol;
  const ang = freeDirection(mol, atomId);
  const px = atom.x + BOND_LEN * Math.cos(ang);
  const py = atom.y + BOND_LEN * Math.sin(ang);
  const near = findAtomNear(mol, px, py, BOND_LEN * 0.35, [atomId]);
  if (near) return addBond(mol, atomId, near.id, order);
  const { mol: withAtom, id } = addAtom(mol, px, py, el);
  return addBond(withAtom, atomId, id, order);
}

/** New two-atom fragment starting at (x, y). */
export function addFragment(mol, x, y, order = 1) {
  const ang = -Math.PI / 6;
  const r1 = addAtom(mol, x - (BOND_LEN / 2) * Math.cos(ang), y - (BOND_LEN / 2) * Math.sin(ang), "C");
  const r2 = addAtom(r1.mol, x + (BOND_LEN / 2) * Math.cos(ang), y + (BOND_LEN / 2) * Math.sin(ang), "C");
  return addBond(r2.mol, r1.id, r2.id, order);
}

/** Bond from an existing atom (or a new atom at start) towards an end point, snapped to 30 degrees. */
export function drawBondTo(mol, fromAtomId, start, end, order = 1, el = "C") {
  let next = mol;
  let fromId = fromAtomId;
  if (fromId == null) {
    const r = addAtom(next, start.x, start.y, el);
    next = r.mol;
    fromId = r.id;
  }
  const from = getAtom(next, fromId);
  const target = findAtomNear(next, end.x, end.y, BOND_LEN * 0.55, [fromId]);
  if (target) return addBond(next, fromId, target.id, order);

  const raw = Math.atan2(end.y - from.y, end.x - from.x);
  const step = Math.PI / 6;
  const ang = Math.round(raw / step) * step;
  const px = from.x + BOND_LEN * Math.cos(ang);
  const py = from.y + BOND_LEN * Math.sin(ang);
  const near = findAtomNear(next, px, py, BOND_LEN * 0.25, [fromId]);
  if (near) return addBond(next, fromId, near.id, order);
  const r = addAtom(next, px, py, el);
  return addBond(r.mol, fromId, r.id, order);
}

/** Preview end point for the bond tool (same snapping as drawBondTo). */
export function previewBondEnd(mol, from, end, fromAtomId) {
  const target = findAtomNear(mol, end.x, end.y, BOND_LEN * 0.55, fromAtomId != null ? [fromAtomId] : []);
  if (target) return { x: target.x, y: target.y };
  const raw = Math.atan2(end.y - from.y, end.x - from.x);
  const step = Math.PI / 6;
  const ang = Math.round(raw / step) * step;
  return { x: from.x + BOND_LEN * Math.cos(ang), y: from.y + BOND_LEN * Math.sin(ang) };
}

/* ------------------------------------------------------------------ */
/* Ring templates                                                      */
/* ------------------------------------------------------------------ */

function ringPoints(cx, cy, n, R, startAngle, dir = 1) {
  return Array.from({ length: n }, (_, i) => {
    const t = startAngle + (dir * i * 2 * Math.PI) / n;
    return { x: cx + R * Math.cos(t), y: cy + R * Math.sin(t) };
  });
}

/**
 * Place an n-membered ring.
 * target: { type: "point", x, y } | { type: "atom", id } | { type: "bond", id }
 * aromatic: alternate double bonds (Kekulé benzene) where valence allows.
 */
export function placeRing(mol, n, target, aromatic = false) {
  let pts;
  let attachToAtomId = null;

  if (target.type === "atom") {
    const a = getAtom(mol, target.id);
    if (!a) return mol;
    const nbs = neighborIds(mol, a.id);
    const R = BOND_LEN / (2 * Math.sin(Math.PI / n));
    if (nbs.length === 0) {
      // Isolated starter atom: becomes vertex 0 of the ring
      const dir = -Math.PI / 2;
      const cx = a.x + R * Math.cos(dir);
      const cy = a.y + R * Math.sin(dir);
      pts = ringPoints(cx, cy, n, R, dir + Math.PI);
    } else {
      // Connected atom: attach substituent ring via single exocyclic bond in free direction
      const dir = freeDirection(mol, a.id);
      const cx = a.x + (BOND_LEN + R) * Math.cos(dir);
      const cy = a.y + (BOND_LEN + R) * Math.sin(dir);
      pts = ringPoints(cx, cy, n, R, dir + Math.PI);
      attachToAtomId = a.id;
    }
  } else if (target.type === "bond") {
    const bond = getBond(mol, target.id);
    if (!bond) return mol;
    const A = getAtom(mol, bond.a);
    const B = getAtom(mol, bond.b);
    const l = Math.hypot(B.x - A.x, B.y - A.y) || BOND_LEN;
    const R = l / (2 * Math.sin(Math.PI / n));
    const d = l / (2 * Math.tan(Math.PI / n));
    const mx = (A.x + B.x) / 2;
    const my = (A.y + B.y) / 2;
    let nx = -(B.y - A.y) / l;
    let ny = (B.x - A.x) / l;
    // put the new ring on the side with fewer existing substituents
    let side = 0;
    for (const id of [...neighborIds(mol, A.id), ...neighborIds(mol, B.id)]) {
      if (id === A.id || id === B.id) continue;
      const p = getAtom(mol, id);
      side += (p.x - mx) * nx + (p.y - my) * ny;
    }
    if (side > 0) {
      nx = -nx;
      ny = -ny;
    }
    const cx = mx + nx * d;
    const cy = my + ny * d;
    const startAngle = Math.atan2(A.y - cy, A.x - cx);
    let diff = Math.atan2(B.y - cy, B.x - cx) - startAngle;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff <= -Math.PI) diff += 2 * Math.PI;
    pts = ringPoints(cx, cy, n, R, startAngle, diff > 0 ? 1 : -1);
  } else {
    const R = BOND_LEN / (2 * Math.sin(Math.PI / n));
    pts = ringPoints(target.x, target.y, n, R, n === 4 ? -Math.PI / 4 : -Math.PI / 2);
  }

  // merge vertices with existing atoms, create the rest
  let next = mol;
  let ids;

  if (target.type === "bond") {
    const bond = getBond(mol, target.id);
    ids = [bond.a, bond.b];
    for (let i = 2; i < pts.length; i++) {
      const p = pts[i];
      const ex = findAtomNear(next, p.x, p.y, BOND_LEN * 0.45, [bond.a, bond.b]);
      if (ex) {
        ids.push(ex.id);
      } else {
        const r = addAtom(next, p.x, p.y, "C");
        next = r.mol;
        ids.push(r.id);
      }
    }
  } else {
    ids = pts.map((p) => {
      const ex = findAtomNear(next, p.x, p.y, BOND_LEN * 0.4);
      if (ex) return ex.id;
      const r = addAtom(next, p.x, p.y, "C");
      next = r.mol;
      return r.id;
    });
  }

  const edges = ids.map((id, i) => [id, ids[(i + 1) % ids.length]]).filter(([a, b]) => a !== b);

  const build = (base, parity) => {
    let m = base;
    let doubles = 0;
    edges.forEach(([a, b], i) => {
      if (findBond(m, a, b)) return;
      let order = 1;
      if (aromatic && i % 2 === parity && !hasDoubleBond(m, a) && !hasDoubleBond(m, b)) {
        order = 2;
        doubles++;
      }
      m = addBond(m, a, b, order);
    });
    return { m, doubles };
  };

  let res;
  if (!aromatic) {
    res = build(next, 0).m;
  } else {
    const even = build(next, 0);
    const odd = build(next, 1);
    res = odd.doubles > even.doubles ? odd.m : even.m;
  }

  if (attachToAtomId != null && ids.length > 0) {
    res = addBond(res, attachToAtomId, ids[0], 1);
  }
  return res;
}

/* ------------------------------------------------------------------ */
/* OpenChemLib conversion                                              */
/* ------------------------------------------------------------------ */

export function toOCL(mol) {
  const m = new OCL.Molecule(Math.max(mol.atoms.length, 1), Math.max(mol.bonds.length, 1));
  const index = new Map();
  for (const a of mol.atoms) {
    const i = m.addAtom(atomicNo(a.el) || 6);
    m.setAtomX(i, a.x / BOND_LEN);
    m.setAtomY(i, a.y / BOND_LEN);
    if (a.charge) m.setAtomCharge(i, a.charge);
    index.set(a.id, i);
  }
  for (const b of mol.bonds) {
    const ia = index.get(b.a);
    const ib = index.get(b.b);
    if (ia == null || ib == null) continue;
    const bi = m.addBond(ia, ib);
    m.setBondOrder(bi, b.order);
  }
  return m;
}

/** Returns { smiles, molfile, formula, weight } for a non-empty molecule. */
export function exportStructure(mol) {
  const m = toOCL(mol);
  const mf = m.getMolecularFormula();
  return {
    smiles: m.toSmiles(),
    molfile: m.toMolfile(),
    formula: mf.formula,
    weight: Number(mf.relativeWeight || mf.absoluteWeight).toFixed(2),
  };
}

/** Parse SMILES (e.g. a PubChem candidate) into the editor model with 2D coordinates. */
export function molFromSmiles(smiles) {
  const m = OCL.Molecule.fromSmiles(smiles);
  const n = m.getAllAtoms();
  const nb = m.getAllBonds();
  if (!n) throw new Error("Structure contains no atoms");

  let total = 0;
  for (let b = 0; b < nb; b++) {
    const a1 = m.getBondAtom(0, b);
    const a2 = m.getBondAtom(1, b);
    total += Math.hypot(m.getAtomX(a1) - m.getAtomX(a2), m.getAtomY(a1) - m.getAtomY(a2));
  }
  const avg = nb ? total / nb : 1;
  const scale = BOND_LEN / (avg || 1);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = m.getAtomX(i);
    const y = m.getAtomY(i);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cx = Number.isFinite(minX) && Number.isFinite(maxX) ? (minX + maxX) / 2 : 0;
  const cy = Number.isFinite(minY) && Number.isFinite(maxY) ? (minY + maxY) / 2 : 0;

  const ids = [];
  const atoms = [];
  for (let i = 0; i < n; i++) {
    const id = nextId();
    ids.push(id);
    atoms.push({
      id,
      x: (m.getAtomX(i) - cx) * scale,
      y: (m.getAtomY(i) - cy) * scale,
      el: m.getAtomLabel(i),
      charge: m.getAtomCharge(i) || 0,
    });
  }
  const bonds = [];
  for (let b = 0; b < nb; b++) {
    const order = Math.min(3, Math.max(1, m.getBondOrder(b)));
    bonds.push({ id: nextId(), a: ids[m.getBondAtom(0, b)], b: ids[m.getBondAtom(1, b)], order });
  }
  return { atoms, bonds };
}

/** Validate a molecule restored from storage. */
export function sanitizeMol(raw) {
  if (!raw || !Array.isArray(raw.atoms) || !Array.isArray(raw.bonds)) return null;
  const atoms = raw.atoms.filter(
    (a) => Number.isFinite(a.id) && Number.isFinite(a.x) && Number.isFinite(a.y) && typeof a.el === "string" && atomicNo(a.el)
  );
  const ids = new Set(atoms.map((a) => a.id));
  const bonds = raw.bonds.filter((b) => ids.has(b.a) && ids.has(b.b) && [1, 2, 3].includes(b.order));
  const mol = { atoms: atoms.map((a) => ({ ...a, charge: a.charge || 0 })), bonds };
  reseedIds(mol);
  return mol;
}

/** Parse Molfile (V2000 or V3000) into editor molecule model with 2D coordinates. */
export function molFromMolfile(molfile) {
  if (!molfile || typeof molfile !== "string" || !molfile.trim()) {
    return EMPTY_MOL;
  }
  const m = OCL.Molecule.fromMolfile(molfile);
  const n = m.getAllAtoms();
  const nb = m.getAllBonds();
  if (!n) return EMPTY_MOL;

  let total = 0;
  for (let b = 0; b < nb; b++) {
    const a1 = m.getBondAtom(0, b);
    const a2 = m.getBondAtom(1, b);
    total += Math.hypot(m.getAtomX(a1) - m.getAtomX(a2), m.getAtomY(a1) - m.getAtomY(a2));
  }
  if (nb > 0 && total < 1e-4 && typeof m.inventCoordinates === "function") {
    m.inventCoordinates();
    for (let b = 0; b < nb; b++) {
      const a1 = m.getBondAtom(0, b);
      const a2 = m.getBondAtom(1, b);
      total += Math.hypot(m.getAtomX(a1) - m.getAtomX(a2), m.getAtomY(a1) - m.getAtomY(a2));
    }
  }
  const avg = nb ? total / nb : 1;
  const scale = avg > 0 ? BOND_LEN / avg : 1;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = m.getAtomX(i);
    const y = m.getAtomY(i);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cx = Number.isFinite(minX) && Number.isFinite(maxX) ? (minX + maxX) / 2 : 0;
  const cy = Number.isFinite(minY) && Number.isFinite(maxY) ? (minY + maxY) / 2 : 0;

  const ids = [];
  const atoms = [];
  for (let i = 0; i < n; i++) {
    const id = nextId();
    ids.push(id);
    atoms.push({
      id,
      x: (m.getAtomX(i) - cx) * scale,
      y: (m.getAtomY(i) - cy) * scale,
      el: m.getAtomLabel(i) || "C",
      charge: m.getAtomCharge(i) || 0,
    });
  }
  const bonds = [];
  for (let b = 0; b < nb; b++) {
    const order = Math.min(3, Math.max(1, m.getBondOrder(b)));
    bonds.push({
      id: nextId(),
      a: ids[m.getBondAtom(0, b)],
      b: ids[m.getBondAtom(1, b)],
      order,
    });
  }
  return { atoms, bonds };
}

/** Recompute clean 2D layout coordinates for a molecule using OpenChemLib. */
export function cleanStructure(mol) {
  if (!mol || !mol.atoms || !mol.atoms.length) return mol;
  try {
    const ocl = toOCL(mol);
    const smiles = ocl.toSmiles();
    if (smiles) {
      return molFromSmiles(smiles);
    }
  } catch (err) {
    console.warn("Could not clean structure layout:", err);
  }
  return mol;
}

/** Validate structure using OpenChemLib. Returns { valid, error, formula, weight, smiles }. */
export function validateStructure(mol) {
  if (!mol || !mol.atoms || mol.atoms.length === 0) {
    return { valid: false, error: "Canvas is empty. Draw a chemical structure first.", atomCount: 0, bondCount: 0 };
  }
  try {
    const ocl = toOCL(mol);
    const smiles = ocl.toSmiles();
    const mf = ocl.getMolecularFormula();
    return {
      valid: true,
      smiles,
      formula: mf.formula,
      weight: Number(mf.relativeWeight || mf.absoluteWeight).toFixed(2),
      atomCount: mol.atoms.length,
      bondCount: mol.bonds.length,
    };
  } catch (err) {
    return {
      valid: false,
      error: err?.message || "Invalid chemical structure",
      atomCount: mol.atoms?.length || 0,
      bondCount: mol.bonds?.length || 0,
    };
  }
}

/**
 * Compute optimal centered viewport transform (zoom and pan) for a molecule
 * within a visible canvas of (width x height).
 */
export function computeViewportTransform(mol, width, height, options = {}) {
  const safeW = Math.max(200, Number(width) || 800);
  const safeH = Math.max(200, Number(height) || 500);
  const emptyZoom = options.emptyZoom ?? 1.5;

  if (!mol || !Array.isArray(mol.atoms) || mol.atoms.length === 0) {
    return {
      zoom: emptyZoom,
      pan: { x: 0, y: 0 },
      centerX: 0,
      centerY: 0,
      spanW: 0,
      spanH: 0,
    };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const a of mol.atoms) {
    if (a.x < minX) minX = a.x;
    if (a.x > maxX) maxX = a.x;
    if (a.y < minY) minY = a.y;
    if (a.y > maxY) maxY = a.y;
  }

  const rawW = Math.max(0, maxX - minX);
  const rawH = Math.max(0, maxY - minY);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  // Include padding in world units for atom labels, hydrogens, and selection halos,
  // with a minimum span so 1-3 atom molecules are not over-magnified.
  const effectiveW = Math.max(rawW + BOND_LEN * 2.2, BOND_LEN * 3.5);
  const effectiveH = Math.max(rawH + BOND_LEN * 2.2, BOND_LEN * 3.5);

  const padX = Math.max(56, safeW * 0.12);
  const padY = Math.max(48, safeH * 0.12);
  const availW = Math.max(120, safeW - padX * 2);
  const availH = Math.max(120, safeH - padY * 2);

  const idealScale = Math.min(availW / effectiveW, availH / effectiveH);
  const minZoom = options.minZoom ?? 0.25;
  const maxZoom = options.maxZoom ?? 2.0;
  const zoom = +Math.max(minZoom, Math.min(idealScale, maxZoom)).toFixed(2);

  const pan = {
    x: +(-centerX * zoom).toFixed(2),
    y: +(-centerY * zoom).toFixed(2),
  };

  return {
    zoom,
    pan,
    centerX,
    centerY,
    spanW: rawW,
    spanH: rawH,
  };
}

/* ------------------------------------------------------------------ */
/* Phase 3A: Molecular Identity Resolution & Transactional Validation */
/* ------------------------------------------------------------------ */

/**
 * Checks whether an identifier is a valid positive integer entity ID.
 */
export function isValidEntityId(id) {
  return typeof id === "number" && Number.isInteger(id) && id > 0;
}

/**
 * Produces a deep, normalized copy of a molecule graph without mutating the source.
 */
export function cloneMolecule(mol) {
  if (!mol || typeof mol !== "object") {
    return { atoms: [], bonds: [] };
  }
  const atoms = Array.isArray(mol.atoms)
    ? mol.atoms.map((a) => ({
        id: a.id,
        x: a.x,
        y: a.y,
        el: a.el || a.element || "C",
        charge: Number(a.charge) || 0,
      }))
    : [];
  const bonds = Array.isArray(mol.bonds)
    ? mol.bonds.map((b) => ({
        id: b.id,
        a: b.a ?? b.a1,
        b: b.b ?? b.a2,
        order: b.order,
      }))
    : [];
  return { atoms, bonds };
}

/**
 * Resolves a single atom by its stable integer ID in the given molecule.
 */
export function resolveAtom(mol, atomId) {
  if (!mol || !Array.isArray(mol.atoms)) {
    return {
      ok: false,
      code: "empty_canvas",
      error: "Molecular graph is empty or unavailable.",
    };
  }
  if (!isValidEntityId(atomId)) {
    return {
      ok: false,
      code: "invalid_atom_id",
      error: `Invalid atom ID "${String(atomId)}": atom ID must be a positive integer.`,
    };
  }
  const atom = mol.atoms.find((a) => a.id === atomId);
  if (!atom) {
    return {
      ok: false,
      code: "unknown_atom_id",
      error: `Atom ID ${atomId} does not exist in the current molecular structure.`,
    };
  }
  return {
    ok: true,
    atom: {
      ...atom,
      el: atom.el || atom.element || "C",
      charge: Number(atom.charge) || 0,
    },
  };
}

/**
 * Resolves an existing bond by its stable integer bondId or by its endpoint atom IDs (atomId1, atomId2).
 * If both bondId and endpoint atom IDs are provided, verifies that they refer to the same bond.
 */
export function resolveBond(mol, selector) {
  if (!mol || !Array.isArray(mol.atoms) || !Array.isArray(mol.bonds)) {
    return {
      ok: false,
      code: "empty_canvas",
      error: "Molecular graph is empty or unavailable.",
    };
  }

  const ref = typeof selector === "number" ? { bondId: selector } : selector || {};
  const hasBondId = ref.bondId !== undefined && ref.bondId !== null;
  const rawAtom1 = ref.atomId1 ?? ref.a ?? ref.a1;
  const rawAtom2 = ref.atomId2 ?? ref.b ?? ref.a2;
  const hasAtom1 = rawAtom1 !== undefined && rawAtom1 !== null;
  const hasAtom2 = rawAtom2 !== undefined && rawAtom2 !== null;

  if (!hasBondId && !hasAtom1 && !hasAtom2) {
    return {
      ok: false,
      code: "missing_bond_target",
      error: "A target bond must be specified by 'bondId' or by both 'atomId1' and 'atomId2'.",
    };
  }

  if (hasAtom1 || hasAtom2) {
    if (!hasAtom1 || !hasAtom2) {
      return {
        ok: false,
        code: "invalid_atom_id",
        error: "Both 'atomId1' and 'atomId2' must be provided when referencing a bond by its endpoint atoms.",
      };
    }
    if (!isValidEntityId(rawAtom1)) {
      return {
        ok: false,
        code: "invalid_atom_id",
        error: `Invalid atomId1 "${String(rawAtom1)}": atom ID must be a positive integer.`,
      };
    }
    if (!isValidEntityId(rawAtom2)) {
      return {
        ok: false,
        code: "invalid_atom_id",
        error: `Invalid atomId2 "${String(rawAtom2)}": atom ID must be a positive integer.`,
      };
    }
    if (rawAtom1 === rawAtom2) {
      return {
        ok: false,
        code: "self_bond",
        error: `Self-bond attempt rejected: atomId1 and atomId2 cannot refer to the same atom (${rawAtom1}).`,
      };
    }
  }

  if (hasBondId) {
    if (!isValidEntityId(ref.bondId)) {
      return {
        ok: false,
        code: "invalid_bond_id",
        error: `Invalid bond ID "${String(ref.bondId)}": bond ID must be a positive integer.`,
      };
    }
    const bond = mol.bonds.find((b) => b.id === ref.bondId);
    if (!bond) {
      return {
        ok: false,
        code: "unknown_bond_id",
        error: `Bond ID ${ref.bondId} does not exist in the current molecular structure.`,
      };
    }
    const endA = bond.a ?? bond.a1;
    const endB = bond.b ?? bond.a2;
    const rA = resolveAtom(mol, endA);
    if (!rA.ok) {
      return {
        ok: false,
        code: "unknown_atom_id",
        error: `Bond ID ${ref.bondId} references missing endpoint atom ${endA}.`,
      };
    }
    const rB = resolveAtom(mol, endB);
    if (!rB.ok) {
      return {
        ok: false,
        code: "unknown_atom_id",
        error: `Bond ID ${ref.bondId} references missing endpoint atom ${endB}.`,
      };
    }
    if (hasAtom1 && hasAtom2) {
      const check1 = resolveAtom(mol, rawAtom1);
      if (!check1.ok) return check1;
      const check2 = resolveAtom(mol, rawAtom2);
      if (!check2.ok) return check2;
      const matchesEndpoints =
        (endA === rawAtom1 && endB === rawAtom2) || (endA === rawAtom2 && endB === rawAtom1);
      if (!matchesEndpoints) {
        return {
          ok: false,
          code: "bond_endpoint_mismatch",
          error: `Bond ID ${ref.bondId} connects atoms (${endA}, ${endB}), which does not match specified atoms (${rawAtom1}, ${rawAtom2}).`,
        };
      }
    }
    return {
      ok: true,
      bond: { id: bond.id, a: endA, b: endB, order: bond.order },
      atomA: rA.atom,
      atomB: rB.atom,
    };
  }

  // Resolve by endpoint pair (rawAtom1, rawAtom2)
  const r1 = resolveAtom(mol, rawAtom1);
  if (!r1.ok) return r1;
  const r2 = resolveAtom(mol, rawAtom2);
  if (!r2.ok) return r2;

  const matchingBonds = mol.bonds.filter((b) => {
    const ba = b.a ?? b.a1;
    const bb = b.b ?? b.a2;
    return (ba === rawAtom1 && bb === rawAtom2) || (ba === rawAtom2 && bb === rawAtom1);
  });

  if (matchingBonds.length === 0) {
    return {
      ok: false,
      code: "unknown_bond_id",
      error: `No bond exists between atom ${rawAtom1} (${r1.atom.el}) and atom ${rawAtom2} (${r2.atom.el}).`,
    };
  }
  if (matchingBonds.length > 1) {
    return {
      ok: false,
      code: "duplicate_bond",
      error: `Multiple duplicate bonds found between atom ${rawAtom1} and atom ${rawAtom2}.`,
    };
  }

  const found = matchingBonds[0];
  return {
    ok: true,
    bond: { id: found.id, a: found.a ?? found.a1, b: found.b ?? found.a2, order: found.order },
    atomA: r1.atom,
    atomB: r2.atom,
  };
}

/**
 * Validates a proposed molecular graph for structural integrity, valence constraints,
 * and OpenChemLib chemical validity before committing to state.
 */
export function validateProposedGraph(mol) {
  const errors = [];
  if (!mol || typeof mol !== "object" || !Array.isArray(mol.atoms) || !Array.isArray(mol.bonds)) {
    return {
      valid: false,
      code: "invalid_graph",
      error: "Proposed molecular structure is not a valid graph object.",
      errors: ["Proposed molecular structure is not a valid graph object."],
      atomCount: 0,
      bondCount: 0,
    };
  }

  if (mol.atoms.length === 0) {
    return {
      valid: false,
      code: "empty_structure",
      error: "Proposed molecular structure contains 0 atoms.",
      errors: ["Proposed molecular structure contains 0 atoms."],
      atomCount: 0,
      bondCount: 0,
    };
  }

  const atomIds = new Set();
  const normalizedAtoms = [];
  for (const a of mol.atoms) {
    const el = a?.el || a?.element;
    if (!isValidEntityId(a?.id)) {
      errors.push(`Invalid atom ID "${String(a?.id)}".`);
      continue;
    }
    if (atomIds.has(a.id)) {
      errors.push(`Duplicate atom ID ${a.id} in molecular graph.`);
      continue;
    }
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) {
      errors.push(`Atom ${a.id} has non-finite coordinates.`);
      continue;
    }
    if (typeof el !== "string" || !atomicNo(el)) {
      errors.push(`Atom ${a.id} has unrecognized chemical element "${String(el)}".`);
      continue;
    }
    atomIds.add(a.id);
    normalizedAtoms.push({
      id: a.id,
      x: a.x,
      y: a.y,
      el,
      charge: Number(a.charge) || 0,
    });
  }

  if (errors.length > 0) {
    return {
      valid: false,
      code: "invalid_atom",
      error: errors.join(" "),
      errors,
      atomCount: mol.atoms.length,
      bondCount: mol.bonds.length,
    };
  }

  const bondIds = new Set();
  const bondPairs = new Set();
  const normalizedBonds = [];
  let failureCode = null;

  for (const b of mol.bonds) {
    const ba = b?.a ?? b?.a1;
    const bb = b?.b ?? b?.a2;
    if (!isValidEntityId(b?.id)) {
      errors.push(`Invalid bond ID "${String(b?.id)}".`);
      failureCode = failureCode || "invalid_bond_id";
      continue;
    }
    if (bondIds.has(b.id)) {
      errors.push(`Duplicate bond ID ${b.id} in molecular graph.`);
      failureCode = failureCode || "duplicate_bond";
      continue;
    }
    if (!isValidEntityId(ba) || !isValidEntityId(bb)) {
      errors.push(`Bond ${b.id} has invalid endpoint atom IDs (${String(ba)}, ${String(bb)}).`);
      failureCode = failureCode || "invalid_atom_id";
      continue;
    }
    if (ba === bb) {
      errors.push(`Self-bond detected on atom ${ba} (bond ${b.id}).`);
      failureCode = failureCode || "self_bond";
      continue;
    }
    if (!atomIds.has(ba) || !atomIds.has(bb)) {
      errors.push(`Bond ${b.id} references non-existent endpoint atom(s) (${ba}, ${bb}).`);
      failureCode = failureCode || "unknown_atom_id";
      continue;
    }
    if (!Number.isInteger(b.order) || ![1, 2, 3].includes(b.order)) {
      errors.push(`Bond ${b.id} has invalid bond order "${String(b.order)}" (must be 1, 2, or 3).`);
      failureCode = failureCode || "invalid_bond_order";
      continue;
    }
    const pairKey = ba < bb ? `${ba}:${bb}` : `${bb}:${ba}`;
    if (bondPairs.has(pairKey)) {
      errors.push(`Duplicate bond detected between atom ${ba} and atom ${bb}.`);
      failureCode = failureCode || "duplicate_bond";
      continue;
    }
    bondIds.add(b.id);
    bondPairs.add(pairKey);
    normalizedBonds.push({ id: b.id, a: ba, b: bb, order: b.order });
  }

  if (errors.length > 0) {
    return {
      valid: false,
      code: failureCode || "invalid_bond",
      error: errors.join(" "),
      errors,
      atomCount: normalizedAtoms.length,
      bondCount: mol.bonds.length,
    };
  }

  const normalizedMol = { atoms: normalizedAtoms, bonds: normalizedBonds };

  // Check chemical valence limits using the engine's valenceMap and isOvervalent helpers
  const vMap = valenceMap(normalizedMol);
  for (const atom of normalizedAtoms) {
    const bondSum = vMap.get(atom.id) || 0;
    if (isOvervalent(atom, bondSum)) {
      const maxBase = MAX_VALENCE[atom.el];
      const allowedMax = maxBase != null ? adjustForCharge(atom.el, maxBase, atom.charge || 0) : maxBase;
      errors.push(
        `Valence violation on atom ${atom.id} (${atom.el}): total bond order ${bondSum} exceeds maximum allowed valence${allowedMax != null ? ` of ${allowedMax}` : ""}.`
      );
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      code: "valence_violation",
      error: errors.join(" "),
      errors,
      atomCount: normalizedAtoms.length,
      bondCount: normalizedBonds.length,
    };
  }

  // Validate conversion and round-trip parseability through OpenChemLib
  try {
    const exp = exportStructure(normalizedMol);
    if (!exp.smiles || typeof exp.smiles !== "string") {
      return {
        valid: false,
        code: "ocl_conversion_failed",
        error: "OpenChemLib failed to generate a valid SMILES for the proposed structure.",
        errors: ["OpenChemLib failed to generate a valid SMILES for the proposed structure."],
        atomCount: normalizedAtoms.length,
        bondCount: normalizedBonds.length,
      };
    }
    // Verify OpenChemLib can parse the resulting SMILES without throwing
    OCL.Molecule.fromSmiles(exp.smiles);

    return {
      valid: true,
      errors: [],
      smiles: exp.smiles,
      molfile: exp.molfile,
      formula: exp.formula,
      weight: exp.weight,
      atomCount: normalizedAtoms.length,
      bondCount: normalizedBonds.length,
    };
  } catch (err) {
    const msg = err?.message || "Invalid chemical structure rejected by OpenChemLib.";
    return {
      valid: false,
      code: "ocl_validation_failed",
      error: msg,
      errors: [msg],
      atomCount: normalizedAtoms.length,
      bondCount: normalizedBonds.length,
    };
  }
}

/**
 * Strictly validates and proposes adding a new bond between two existing atoms,
 * rejecting self-bonds and duplicate bonds between already-connected atoms.
 */
export function proposeBondAddition(mol, { atomId1, atomId2, order = 1 } = {}) {
  if (!Number.isInteger(order) || ![1, 2, 3].includes(order)) {
    return {
      ok: false,
      code: "invalid_bond_order",
      error: `Invalid bond order "${String(order)}": bond order must be 1, 2, or 3.`,
    };
  }
  const r1 = resolveAtom(mol, atomId1);
  if (!r1.ok) return r1;
  const r2 = resolveAtom(mol, atomId2);
  if (!r2.ok) return r2;

  if (atomId1 === atomId2) {
    return {
      ok: false,
      code: "self_bond",
      error: `Self-bond attempt rejected: cannot bond atom ${atomId1} to itself.`,
    };
  }

  const existing = findBond(mol, atomId1, atomId2);
  if (existing) {
    return {
      ok: false,
      code: "duplicate_bond",
      error: `Duplicate bond attempt rejected: bond ${existing.id} already connects atom ${atomId1} (${r1.atom.el}) and atom ${atomId2} (${r2.atom.el}). Use change_bond_order instead.`,
    };
  }

  const base = cloneMolecule(mol);
  const newBondId = nextId();
  const proposedMol = {
    atoms: base.atoms,
    bonds: [...base.bonds, { id: newBondId, a: atomId1, b: atomId2, order }],
  };

  const validation = validateProposedGraph(proposedMol);
  if (!validation.valid) {
    return {
      ok: false,
      code: validation.code || "validation_failed",
      validationFailed: true,
      validationErrors: validation.errors,
      error: validation.error,
    };
  }

  return {
    ok: true,
    proposedMol,
    bondId: newBondId,
    validation,
  };
}

/**
 * Pure, non-destructive transactional proposal for changing an existing bond's order.
 * Resolves identities, checks for duplicate/no-op bond order or invalid valence,
 * and returns the validated candidate graph without modifying the input molecule.
 */
export function proposeBondOrderChange(mol, params = {}) {
  const { bondId, atomId1, atomId2, a, b, a1, a2, order, createBond } = params || {};

  if (!Number.isInteger(order) || ![1, 2, 3].includes(order)) {
    return {
      ok: false,
      code: "invalid_bond_order",
      error: `Invalid bond order "${String(order)}": bond order must be 1 (single), 2 (double), or 3 (triple).`,
    };
  }

  const resolved = resolveBond(mol, { bondId, atomId1, atomId2, a, b, a1, a2 });
  if (!resolved.ok) {
    return resolved;
  }

  const { bond, atomA, atomB } = resolved;

  if (createBond === true) {
    return {
      ok: false,
      code: "duplicate_bond",
      error: `Duplicate bond attempt rejected: bond ${bond.id} already exists between atom ${atomA.id} (${atomA.el}) and atom ${atomB.id} (${atomB.el}).`,
    };
  }

  if (bond.order === order) {
    return {
      ok: false,
      code: "duplicate_bond",
      error: `Duplicate bond order attempt rejected: bond ${bond.id} between atom ${atomA.id} (${atomA.el}) and atom ${atomB.id} (${atomB.el}) already has order ${order}.`,
    };
  }

  // Apply non-destructive modification on a cloned graph using the engine's setBondOrder
  const baseMol = cloneMolecule(mol);
  const proposedMol = setBondOrder(baseMol, bond.id, order);

  const validation = validateProposedGraph(proposedMol);
  if (!validation.valid) {
    return {
      ok: false,
      code: validation.code || "validation_failed",
      validationFailed: true,
      validationErrors: validation.errors,
      error: validation.error,
    };
  }

  const orderLabels = { 1: "single", 2: "double", 3: "triple" };
  const summary = `Changed bond ${bond.id} between ${atomA.el}${atomA.id} and ${atomB.el}${atomB.id} from ${orderLabels[bond.order] || bond.order} (order ${bond.order}) to ${orderLabels[order]} (order ${order}).`;

  return {
    ok: true,
    proposedMol,
    validation,
    summary,
    mutatedBond: {
      id: bond.id,
      a: atomA.id,
      b: atomB.id,
      a1: atomA.id,
      a2: atomB.id,
      previousOrder: bond.order,
      order,
    },
  };
}



