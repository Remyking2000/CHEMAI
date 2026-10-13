import {
  BOND_LEN,
  EMPTY_MOL,
  addAtom,
  addBond,
  setBondOrder,
  setAtomElement,
  removeAtom,
  removeBond,
  addSubstituent,
  drawBondTo,
  placeRing,
  toOCL,
  exportStructure,
  molFromSmiles,
  valenceMap,
  implicitHydrogens,
  isOvervalent,
} from "./frontend/src/lib/mobileMolecule.js";

function assert(condition, message) {
  if (!condition) {
    console.error("FAIL:", message);
    process.exit(1);
  }
  console.log("PASS:", message);
}

console.log("--- Starting Chemistry & Editor Logic Validation ---");

// 1. Empty molecule
assert(EMPTY_MOL.atoms.length === 0 && EMPTY_MOL.bonds.length === 0, "EMPTY_MOL has 0 atoms and 0 bonds");

// 2. Ethanol (C2H6O)
let m = EMPTY_MOL;
const a1 = addAtom(m, 0, 0, "C");
const a2 = addAtom(a1.mol, 40, 0, "C");
const a3 = addAtom(a2.mol, 80, 0, "O");
let eth = addBond(a3.mol, a1.id, a2.id, 1);
eth = addBond(eth, a2.id, a3.id, 1);
const ethExp = exportStructure(eth);
assert(ethExp.formula === "C2H6O", `Ethanol formula is C2H6O (got ${ethExp.formula})`);
assert(ethExp.smiles === "CCO", `Ethanol SMILES is CCO (got ${ethExp.smiles})`);
assert(Math.abs(parseFloat(ethExp.weight) - 46.07) < 0.1, `Ethanol weight is ~46.07 (got ${ethExp.weight})`);

// 3. Acetic Acid (C2H4O2)
let aa = EMPTY_MOL;
const c1 = addAtom(aa, 0, 0, "C");
const c2 = addAtom(c1.mol, 40, 0, "C");
const o1 = addAtom(c2.mol, 40, -40, "O"); // carbonyl
const o2 = addAtom(o1.mol, 75, 20, "O"); // hydroxyl
aa = addBond(o2.mol, c1.id, c2.id, 1);
aa = addBond(aa, c2.id, o1.id, 2);
aa = addBond(aa, c2.id, o2.id, 1);
const aaExp = exportStructure(aa);
assert(aaExp.formula === "C2H4O2", `Acetic acid formula is C2H4O2 (got ${aaExp.formula})`);
assert(aaExp.smiles === "CC(=O)O" || aaExp.smiles === "CC(O)=O", `Acetic acid SMILES is valid (got ${aaExp.smiles})`);

// 4. Benzene (C6H6) Starter Template
const benz = placeRing(EMPTY_MOL, 6, { type: "point", x: 0, y: 0 }, true);
const benzExp = exportStructure(benz);
assert(benzExp.formula === "C6H6", `Benzene formula is C6H6 (got ${benzExp.formula})`);
assert(benzExp.smiles === "C1=CC=CC=C1" || benzExp.smiles === "c1ccccc1", `Benzene SMILES is valid (got ${benzExp.smiles})`);

// 5. Cyclohexane (C6H12) Starter Template
const cyc = placeRing(EMPTY_MOL, 6, { type: "point", x: 0, y: 0 }, false);
const cycExp = exportStructure(cyc);
assert(cycExp.formula === "C6H12", `Cyclohexane formula is C6H12 (got ${cycExp.formula})`);
assert(cycExp.smiles === "C1CCCCC1", `Cyclohexane SMILES is C1CCCCC1 (got ${cycExp.smiles})`);

// 6. C-C Starter Chain
const chainStart = addAtom(EMPTY_MOL, -20, 0, "C");
const chainNext = addAtom(chainStart.mol, 20, 0, "C");
const chainMol = addBond(chainNext.mol, chainNext.mol.atoms[0].id, chainNext.mol.atoms[1].id, 1);
const chainExp = exportStructure(chainMol);
assert(chainExp.formula === "C2H6", `C-C chain formula is C2H6 (got ${chainExp.formula})`);
assert(chainExp.smiles === "CC", `C-C chain SMILES is CC (got ${chainExp.smiles})`);

// 7. Fused Ring: Naphthalene (C10H8)
const naph = placeRing(benz, 6, { type: "bond", id: benz.bonds[0].id }, true);
const naphExp = exportStructure(naph);
assert(naphExp.formula === "C10H8", `Naphthalene formula is C10H8 (got ${naphExp.formula})`);

// 8. Substituent Ring: Biphenyl (C12H10)
const biphenyl = placeRing(benz, 6, { type: "atom", id: benz.atoms[0].id }, true);
const biExp = exportStructure(biphenyl);
assert(biExp.formula === "C12H10", `Biphenyl formula is C12H10 (got ${biExp.formula})`);

// 9. Nitrogen compound: Methylamine (CH5N)
let meN = EMPTY_MOL;
const nC = addAtom(meN, 0, 0, "C");
const nN = addAtom(nC.mol, 40, 0, "N");
meN = addBond(nN.mol, nC.id, nN.id, 1);
const meNExp = exportStructure(meN);
assert(meNExp.formula === "CH5N", `Methylamine formula is CH5N (got ${meNExp.formula})`);
assert(meNExp.smiles === "CN", `Methylamine SMILES is CN (got ${meNExp.smiles})`);

// 10. Round-trip serialization through molFromSmiles
const roundTrip = molFromSmiles(aaExp.smiles);
const rtExp = exportStructure(roundTrip);
assert(rtExp.formula === "C2H4O2", `Round-trip formula matches C2H4O2 (got ${rtExp.formula})`);
assert(rtExp.smiles === "CC(=O)O" || rtExp.smiles === "CC(O)=O", `Round-trip SMILES matches (got ${rtExp.smiles})`);

console.log("--- All Chemistry Tests Passed Successfully! ---");
