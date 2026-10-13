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
    atoms: mol.atoms.map((a) => (a.id === atomId ? { ...a, el, charge: 0 } : a)),
  };
}

export function removeAtom(mol, atomId) {
  return {
    atoms: mol.atoms.filter((a) => a.id !== atomId),
    bonds: mol.bonds.filter((b) => b.a !== atomId && b.b !== atomId),
  };
}

export function removeBond(mol, bondId) {
  return { ...mol, bonds: mol.bonds.filter((b) => b.id !== bondId) };
}

export function moveAtoms(mol, ids, dx, dy, baseMol = mol) {
  const set = new Set(ids);
  return {
    ...mol,
    atoms: baseMol.atoms.map((a) => (set.has(a.id) ? { ...a, x: a.x + dx, y: a.y + dy } : a)),
  };
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

  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += m.getAtomX(i);
    cy += m.getAtomY(i);
  }
  cx /= n;
  cy /= n;

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
