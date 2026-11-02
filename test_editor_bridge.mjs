/**
 * ==============================================================================
 * ChemAI — Controlled Molecular Editor Bridge Tests (Phase 2A)
 * ------------------------------------------------------------------------------
 * Automated test suite verifying the programmatic editor bridge:
 *   1. Reading empty editor returns valid empty-state result.
 *   2. Reading populated editor returns current structure & properties.
 *   3. Loading valid structure into active editor.
 *   4. Invalid SMILES / failed conversions preserve current molecule intact.
 *   5. Fit-to-screen updates viewport without mutating the molecule.
 *   6. Bridge parity across desktop and mobile editor targets.
 *   7. Replacement of populated canvas respects the approval boundary.
 *   8. Allowlist rejection of arbitrary / unsupported actions.
 *   9. Registry registration, retrieval, and unregistration lifecycle.
 * ==============================================================================
 */

import {
  createEditorBridge,
  registerEditorBridge,
  getActiveEditorBridge,
  ALLOWED_BRIDGE_ACTIONS,
  ALLOWED_MUTATION_OPERATIONS,
  BRIDGE_ERROR_TYPES,
  MUTATION_FAILURE_CODES,
  validateMutationRequest,
} from "./frontend/src/lib/editorBridge.js";
import {
  EMPTY_MOL,
  molFromSmiles,
  exportStructure,
  computeViewportTransform,
  addAtom,
  addBond,
  removeAtom,
  removeBond,
  resolveAtom,
  resolveBond,
  validateProposedGraph,
  proposeBondAddition,
  proposeBondOrderChange,
  createMoleculeStateManager,
} from "./frontend/src/lib/moleculeEngine.js";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`PASS: ${message}`);
  } else {
    failed++;
    console.error(`FAIL: ${message}`);
  }
}

console.log("--- Starting ChemAI Controlled Molecular Editor Bridge Tests (Phase 2A) ---");

/**
 * Creates an in-memory mock editor target implementing the shared manager adapter contract.
 */
function createMockEditorTarget({
  initialMol = EMPTY_MOL,
  viewMode = "desktop",
  onApproval = null,
} = {}) {
  let currentMol = initialMol;
  let viewport = { zoom: 1.5, pan: { x: 0, y: 0 } };
  let loadCalls = 0;
  let fitCalls = 0;

  return {
    getMolecule: () => currentMol,
    exportCurrent: () => {
      if (!currentMol || !currentMol.atoms || !currentMol.atoms.length) {
        return { smiles: "", molfile: "", formula: "", weight: "", atomCount: 0, bondCount: 0 };
      }
      const exp = exportStructure(currentMol);
      return {
        ...exp,
        atomCount: currentMol.atoms.length,
        bondCount: currentMol.bonds.length,
      };
    },
    loadSmiles: (smiles) => {
      loadCalls++;
      currentMol = smiles ? molFromSmiles(smiles) : EMPTY_MOL;
    },
    setMolecule: (newMol) => {
      loadCalls++;
      currentMol = newMol || EMPTY_MOL;
    },
    fitView: () => {
      fitCalls++;
      const dims = viewMode === "mobile" ? { width: 360, height: 480 } : { width: 800, height: 600 };
      viewport = computeViewportTransform(currentMol, dims.width, dims.height);
      return viewport;
    },
    getViewport: () => viewport,
    getViewMode: () => viewMode,
    setViewMode: (mode) => { viewMode = mode; },
    isReady: () => true,
    requestApproval: onApproval,
    getStats: () => ({ loadCalls, fitCalls, currentMol, viewport }),
  };
}

// -----------------------------------------------------------------------------
// Test 1: Reading an empty editor returns a valid empty-state result
// -----------------------------------------------------------------------------
{
  const target = createMockEditorTarget({ initialMol: EMPTY_MOL });
  const bridge = createEditorBridge(target);

  const res = await bridge.read_editor_structure();
  assert(res.ok === true, "Empty editor read returns ok: true");
  assert(res.action === "read_editor_structure", "Action label is read_editor_structure");
  assert(res.data.isEmpty === true, "isEmpty is true for 0 atoms");
  assert(res.data.hasMolecule === false, "hasMolecule is false for 0 atoms");
  assert(res.data.atomCount === 0 && res.data.bondCount === 0, "atomCount and bondCount are 0");
  assert(res.data.smiles === "", "SMILES is empty string for empty canvas");
  assert(Array.isArray(res.data.graph.atoms) && res.data.graph.atoms.length === 0, "Graph atoms array is empty");
}

// -----------------------------------------------------------------------------
// Test 2: Reading a populated editor returns current structure & properties
// -----------------------------------------------------------------------------
{
  const ethanolMol = molFromSmiles("CCO");
  const target = createMockEditorTarget({ initialMol: ethanolMol });
  const bridge = createEditorBridge(target);

  const res = await bridge.read_editor_structure();
  assert(res.ok === true, "Populated editor read returns ok: true");
  assert(res.data.isEmpty === false, "isEmpty is false for populated molecule");
  assert(res.data.hasMolecule === true, "hasMolecule is true for populated molecule");
  assert(res.data.atomCount === 3, "Ethanol atomCount is 3 (heavy atoms C, C, O)");
  assert(res.data.bondCount === 2, "Ethanol bondCount is 2");
  assert(res.data.smiles === "CCO", "Canonical SMILES is CCO");
  assert(res.data.formula === "C2H6O", "Formula is C2H6O");
  assert(res.data.weight === "46.07", "Weight is 46.07");
  assert(res.data.graph.atoms.length === 3, "Graph contains 3 atom nodes with coordinates");
  assert(res.data.graph.bonds.length === 2, "Graph contains 2 bond edges");
}

// -----------------------------------------------------------------------------
// Test 3: Loading a valid structure into an active empty editor
// -----------------------------------------------------------------------------
{
  const target = createMockEditorTarget({ initialMol: EMPTY_MOL });
  const bridge = createEditorBridge(target);

  const res = await bridge.load_structure_into_editor("CC(=O)Oc1ccccc1C(=O)O"); // Aspirin
  assert(res.ok === true, "Loading valid Aspirin SMILES returns ok: true");
  assert(res.data.atomCount === 13, "Loaded Aspirin contains 13 heavy atoms");
  assert(res.data.bondCount === 13, "Loaded Aspirin contains 13 bonds");
  assert(res.data.formula === "C9H8O4", "Loaded Aspirin formula is C9H8O4");
  assert(target.getStats().loadCalls === 1, "loadSmiles was called on shared manager adapter");
  assert(target.getStats().fitCalls === 1, "fitView was automatically called after loading");

  // Read back to confirm state persistence
  const readRes = await bridge.read_editor_structure();
  assert(readRes.data.atomCount === 13, "Subsequent read confirms Aspirin structure is loaded");
  assert(readRes.data.hasMolecule === true, "Subsequent read confirms hasMolecule is true");
}

// -----------------------------------------------------------------------------
// Test 4: Invalid SMILES / failed conversions preserve current molecule intact
// -----------------------------------------------------------------------------
{
  const ethanolMol = molFromSmiles("CCO");
  const target = createMockEditorTarget({ initialMol: ethanolMol });
  const bridge = createEditorBridge(target);

  // Attempt 1: Malformed SMILES syntax
  const badRes1 = await bridge.load_structure_into_editor("C1CC1X_INVALID_SYNTAX@@");
  assert(badRes1.ok === false, "Loading malformed SMILES returns ok: false");
  assert(/Invalid SMILES/i.test(badRes1.error), "Error message clearly explains invalid SMILES");
  assert(target.getStats().loadCalls === 0, "Editor was NOT mutated on parse failure");

  // Attempt 2: Empty SMILES string
  const badRes2 = await bridge.load_structure_into_editor("   ");
  assert(badRes2.ok === false, "Empty SMILES returns ok: false");
  assert(/required/i.test(badRes2.error), "Error message indicates non-empty SMILES is required");
  assert(target.getStats().loadCalls === 0, "Editor was NOT mutated on empty SMILES");

  // Verify original Ethanol structure remains 100% intact
  const verifyRes = await bridge.read_editor_structure();
  assert(verifyRes.data.atomCount === 3, "Original Ethanol structure preserved (3 atoms)");
  assert(verifyRes.data.smiles === "CCO", "Original Ethanol SMILES preserved (CCO)");
}

// -----------------------------------------------------------------------------
// Test 5: Fit-to-screen updates viewport without mutating the molecule
// -----------------------------------------------------------------------------
{
  const aspirinMol = molFromSmiles("CC(=O)Oc1ccccc1C(=O)O");
  const target = createMockEditorTarget({ initialMol: aspirinMol });
  const bridge = createEditorBridge(target);

  const initialAtomData = JSON.stringify(aspirinMol.atoms);
  const fitRes = await bridge.fit_canvas_view();

  assert(fitRes.ok === true, "fit_canvas_view returns ok: true");
  assert(fitRes.action === "fit_canvas_view", "Action label is fit_canvas_view");
  assert(fitRes.data.viewport && typeof fitRes.data.viewport.zoom === "number", "Returns computed zoom factor");
  assert(fitRes.data.viewport.zoom > 0.5 && fitRes.data.viewport.zoom <= 2.0, "Zoom is within safe bounds");
  assert(target.getStats().fitCalls === 1, "Target fitView method was invoked");

  // Verify molecule was not mutated
  const currentAtomData = JSON.stringify(target.getMolecule().atoms);
  assert(initialAtomData === currentAtomData, "Atom coordinates and counts unchanged by viewport fit");
}

// -----------------------------------------------------------------------------
// Test 6: Bridge parity across desktop and mobile editor modes
// -----------------------------------------------------------------------------
{
  const targetDesktop = createMockEditorTarget({ viewMode: "desktop" });
  const bridgeDesktop = createEditorBridge(targetDesktop);

  const capDesktop = await bridgeDesktop.get_editor_capabilities();
  assert(capDesktop.ok === true, "Desktop get_editor_capabilities returns ok: true");
  assert(capDesktop.data.viewMode === "desktop", "Reports desktop viewMode");
  assert(capDesktop.data.canRead && capDesktop.data.canLoad && capDesktop.data.canFitView, "Desktop supports all core actions");

  const targetMobile = createMockEditorTarget({ viewMode: "mobile" });
  const bridgeMobile = createEditorBridge(targetMobile);

  const capMobile = await bridgeMobile.get_editor_capabilities();
  assert(capMobile.ok === true, "Mobile get_editor_capabilities returns ok: true");
  assert(capMobile.data.viewMode === "mobile", "Reports mobile viewMode");
  assert(capMobile.data.canRead && capMobile.data.canLoad && capMobile.data.canFitView, "Mobile supports all core actions");

  // Fit view on mobile uses mobile canvas dimensions
  const benzeneMol = molFromSmiles("c1ccccc1");
  targetMobile.setMolecule(benzeneMol);
  const fitMobile = await bridgeMobile.fit_canvas_view();
  assert(fitMobile.ok === true && fitMobile.data.viewMode === "mobile", "Mobile fit view succeeds and reports mobile mode");
}

// -----------------------------------------------------------------------------
// Test 7: Replacement of populated canvas respects the approval boundary
// -----------------------------------------------------------------------------
{
  // Case 7a: Replacing non-empty structure WITHOUT pre-approval or approval callback
  const target1 = createMockEditorTarget({ initialMol: molFromSmiles("CCO") });
  const bridge1 = createEditorBridge(target1);

  const unapprovedRes = await bridge1.load_structure_into_editor({
    smiles: "c1ccccc1",
    approved: false,
    requireApproval: true,
  });

  assert(unapprovedRes.ok === false, "Unapproved replacement of non-empty canvas is blocked");
  assert(unapprovedRes.needsApproval === true, "Response flags needsApproval: true");
  assert(/explicit user approval/i.test(unapprovedRes.error), "Error states explicit approval is required");
  assert(target1.getMolecule().atoms.length === 3, "Original Ethanol structure preserved (3 atoms)");

  // Case 7b: Replacing non-empty structure WITH interactive user refusal
  const target2 = createMockEditorTarget({
    initialMol: molFromSmiles("CCO"),
    onApproval: async () => false, // User clicks 'Keep Current'
  });
  const bridge2 = createEditorBridge(target2);

  const declinedRes = await bridge2.load_structure_into_editor({ smiles: "c1ccccc1" });
  assert(declinedRes.ok === false, "Declined replacement returns ok: false");
  assert(declinedRes.needsApproval === true, "Declined replacement flags needsApproval: true");
  assert(/declined by user/i.test(declinedRes.error), "Error reflects user decline");
  assert(target2.getMolecule().atoms.length === 3, "Original structure remains intact after decline");

  // Case 7c: Replacing non-empty structure WITH interactive user approval
  let approvalReceivedInfo = null;
  const target3 = createMockEditorTarget({
    initialMol: molFromSmiles("CCO"),
    onApproval: async (info) => {
      approvalReceivedInfo = info;
      return true; // User clicks 'Approve & Replace'
    },
  });
  const bridge3 = createEditorBridge(target3);

  const approvedRes = await bridge3.load_structure_into_editor({ smiles: "c1ccccc1", source: "ai_chat" });
  assert(approvedRes.ok === true, "Approved replacement succeeds");
  assert(approvalReceivedInfo && approvalReceivedInfo.candidateSmiles === "c1ccccc1", "Approval callback received candidate SMILES");
  assert(approvalReceivedInfo.currentAtomCount === 3, "Approval callback received current atom count");
  assert(target3.getMolecule().atoms.length === 6, "New Benzene structure applied after approval (6 atoms)");

  // Case 7d: Loading onto an EMPTY canvas requires NO approval
  const target4 = createMockEditorTarget({ initialMol: EMPTY_MOL });
  const bridge4 = createEditorBridge(target4);

  const emptyLoadRes = await bridge4.load_structure_into_editor({ smiles: "CCO" });
  assert(emptyLoadRes.ok === true, "Loading onto empty canvas succeeds without requiring approval");
  assert(target4.getMolecule().atoms.length === 3, "Structure loaded directly on empty canvas");
}

// -----------------------------------------------------------------------------
// Test 8: Allowlist rejection of arbitrary / unsupported actions
// -----------------------------------------------------------------------------
{
  const target = createMockEditorTarget();
  const bridge = createEditorBridge(target);

  const badAction1 = await bridge.executeAction("eval_arbitrary_code", { code: "alert(1)" });
  assert(badAction1.ok === false, "Arbitrary action eval_arbitrary_code is strictly rejected");
  assert(/not a supported editor bridge operation/i.test(badAction1.error), "Error indicates unsupported operation");

  const badAction2 = await bridge.executeAction("delete_all_files");
  assert(badAction2.ok === false, "Arbitrary action delete_all_files is strictly rejected");

  // Valid allowlisted actions dispatch correctly via executeAction
  const readViaDispatch = await bridge.executeAction("read_editor_structure");
  assert(readViaDispatch.ok === true && readViaDispatch.action === "read_editor_structure", "executeAction correctly dispatches read_editor_structure");

  const capViaDispatch = await bridge.executeAction("get_editor_capabilities");
  assert(capViaDispatch.ok === true && capViaDispatch.action === "get_editor_capabilities", "executeAction correctly dispatches get_editor_capabilities");
}

// -----------------------------------------------------------------------------
// Test 9: Registry registration, retrieval, and unregistration lifecycle
// -----------------------------------------------------------------------------
{
  assert(getActiveEditorBridge() === null, "Initially active bridge is null");

  const target = createMockEditorTarget();
  const bridge = createEditorBridge(target);

  let notifiedBridge = null;
  const unregister = registerEditorBridge(bridge);

  assert(getActiveEditorBridge() === bridge, "getActiveEditorBridge returns registered bridge");

  unregister();
  assert(getActiveEditorBridge() === null, "getActiveEditorBridge returns null after unregistration");
}

// -----------------------------------------------------------------------------
// Test 10: Phase 3A — Request Validation (Schema & Parameter Checks)
// -----------------------------------------------------------------------------
{
  // 10a. Valid mutation request (by bondId)
  const validByBond = validateMutationRequest({
    actionId: "mut_valid_1",
    operation: "change_bond_order",
    arguments: { bondId: 2, order: 2 },
    expectedRevision: 1,
  });
  assert(validByBond.ok === true, "Valid mutation request with bondId passes schema validation");
  assert(validByBond.normalized.bondId === 2 && validByBond.normalized.order === 2, "Normalized request preserves bondId and order");

  // 10b. Valid mutation request (by atomId1 & atomId2)
  const validByAtoms = validateMutationRequest({
    actionId: "mut_valid_2",
    operation: "change_bond_order",
    arguments: { atomId1: 1, atomId2: 2, order: 3 },
  });
  assert(validByAtoms.ok === true, "Valid mutation request with atomId1 and atomId2 passes schema validation");

  // 10c. Missing action ID
  const missingActionId = validateMutationRequest({
    operation: "change_bond_order",
    arguments: { bondId: 1, order: 2 },
  });
  assert(
    missingActionId.ok === false && missingActionId.code === MUTATION_FAILURE_CODES.MISSING_ACTION_ID,
    "Mutation request without actionId is rejected with missing_action_id"
  );

  // 10d. Missing operation
  const missingOp = validateMutationRequest({
    actionId: "mut_no_op",
    arguments: { bondId: 1, order: 2 },
  });
  assert(
    missingOp.ok === false && missingOp.code === MUTATION_FAILURE_CODES.MISSING_OPERATION,
    "Mutation request without operation is rejected with missing_operation"
  );

  // 10e. Unknown operation
  const unknownOp = validateMutationRequest({
    actionId: "mut_unknown_op",
    operation: "run_retrosynthesis_script",
    arguments: { bondId: 1, order: 2 },
  });
  assert(
    unknownOp.ok === false && unknownOp.code === MUTATION_FAILURE_CODES.UNKNOWN_OPERATION,
    "Mutation request with unknown operation is rejected with unknown_operation"
  );

  // 10f. Malformed arguments (non-object arguments, unexpected keys, missing bond selector)
  const malformedArgs1 = validateMutationRequest({
    actionId: "mut_bad_args_1",
    operation: "change_bond_order",
    arguments: "not-an-object",
  });
  assert(
    malformedArgs1.ok === false && malformedArgs1.code === MUTATION_FAILURE_CODES.MALFORMED_ARGUMENTS,
    "Mutation request with string arguments is rejected with malformed_arguments"
  );

  const malformedArgs2 = validateMutationRequest({
    actionId: "mut_bad_args_2",
    operation: "change_bond_order",
    arguments: { order: 2 }, // missing both bondId and atomId1/atomId2
  });
  assert(
    malformedArgs2.ok === false && malformedArgs2.code === MUTATION_FAILURE_CODES.MALFORMED_ARGUMENTS,
    "Mutation request missing both bondId and atomId1/atomId2 is rejected with malformed_arguments"
  );

  const malformedArgs3 = validateMutationRequest({
    actionId: "mut_bad_args_3",
    operation: "change_bond_order",
    arguments: { bondId: 1, order: 2, arbitraryScript: "window.location='evil'" },
  });
  assert(
    malformedArgs3.ok === false && malformedArgs3.code === MUTATION_FAILURE_CODES.MALFORMED_ARGUMENTS,
    "Mutation request with unexpected argument key is rejected with malformed_arguments"
  );

  // 10g. Invalid atom ID
  const invalidAtomId = validateMutationRequest({
    actionId: "mut_bad_atom_id",
    operation: "change_bond_order",
    arguments: { atomId1: -5, atomId2: 2, order: 2 },
  });
  assert(
    invalidAtomId.ok === false && invalidAtomId.code === MUTATION_FAILURE_CODES.INVALID_ATOM_ID,
    "Mutation request with negative atomId1 is rejected with invalid_atom_id"
  );

  const invalidAtomIdStr = validateMutationRequest({
    actionId: "mut_bad_atom_str",
    operation: "change_bond_order",
    arguments: { atomId1: "atom_1", atomId2: 2, order: 2 },
  });
  assert(
    invalidAtomIdStr.ok === false && invalidAtomIdStr.code === MUTATION_FAILURE_CODES.INVALID_ATOM_ID,
    "Mutation request with non-integer atomId is rejected with invalid_atom_id"
  );

  // 10h. Invalid bond ID
  const invalidBondId = validateMutationRequest({
    actionId: "mut_bad_bond_id",
    operation: "change_bond_order",
    arguments: { bondId: 0, order: 2 },
  });
  assert(
    invalidBondId.ok === false && invalidBondId.code === MUTATION_FAILURE_CODES.INVALID_BOND_ID,
    "Mutation request with bondId 0 is rejected with invalid_bond_id"
  );

  // 10i. Invalid bond order
  const invalidOrderHigh = validateMutationRequest({
    actionId: "mut_bad_order_4",
    operation: "change_bond_order",
    arguments: { bondId: 1, order: 4 },
  });
  assert(
    invalidOrderHigh.ok === false && invalidOrderHigh.code === MUTATION_FAILURE_CODES.INVALID_BOND_ORDER,
    "Mutation request with order 4 is rejected with invalid_bond_order"
  );

  const invalidOrderZero = validateMutationRequest({
    actionId: "mut_bad_order_0",
    operation: "change_bond_order",
    arguments: { bondId: 1, order: 0 },
  });
  assert(
    invalidOrderZero.ok === false && invalidOrderZero.code === MUTATION_FAILURE_CODES.INVALID_BOND_ORDER,
    "Mutation request with order 0 is rejected with invalid_bond_order"
  );
}

// -----------------------------------------------------------------------------
// Test 11: Phase 3A — Molecular Identity Resolution & Stability Across Edits
// -----------------------------------------------------------------------------
{
  // Build propanol C1 - C2 - C3 - O4 step by step
  const s1 = addAtom(EMPTY_MOL, 0, 0, "C");
  const s2 = addAtom(s1.mol, 40, 0, "C");
  const s3 = addAtom(s2.mol, 80, 0, "C");
  const s4 = addAtom(s3.mol, 120, 0, "O");
  let mol = addBond(s4.mol, s1.id, s2.id, 1);
  const b12Id = mol.bonds[0].id;
  mol = addBond(mol, s2.id, s3.id, 1);
  const b23Id = mol.bonds[1].id;
  mol = addBond(mol, s3.id, s4.id, 1);
  const b34Id = mol.bonds[2].id;

  // 11a. Resolve existing atom
  const resAtomO = resolveAtom(mol, s4.id);
  assert(resAtomO.ok === true && resAtomO.atom.el === "O", "Resolves existing oxygen atom by stable ID");

  // 11b. Resolve existing bond by bondId and by (atomId1, atomId2)
  const resBondById = resolveBond(mol, { bondId: b34Id });
  assert(
    resBondById.ok === true && resBondById.bond.id === b34Id && resBondById.atomA.id === s3.id && resBondById.atomB.id === s4.id,
    "Resolves existing C-O bond by bondId"
  );

  const resBondByAtoms = resolveBond(mol, { atomId1: s4.id, atomId2: s3.id });
  assert(
    resBondByAtoms.ok === true && resBondByAtoms.bond.id === b34Id,
    "Resolves existing C-O bond by endpoint atom IDs regardless of endpoint order"
  );

  // 11c. Delete the FIRST atom (s1), causing all remaining array indices to shift left by 1
  const molAfterDelete = removeAtom(mol, s1.id);
  assert(molAfterDelete.atoms.length === 3, "Removing first atom leaves 3 atoms");
  assert(molAfterDelete.atoms[0].id === s2.id, "Atom s2 shifted to array index 0 but kept its stable ID");

  // 11d. Reject deleted atom reference (s1.id)
  const deletedAtomCheck = resolveAtom(molAfterDelete, s1.id);
  assert(
    deletedAtomCheck.ok === false && deletedAtomCheck.code === MUTATION_FAILURE_CODES.UNKNOWN_ATOM_ID,
    "Deleted atom ID is rejected with unknown_atom_id"
  );

  // 11e. Reject deleted incident bond reference (b12Id)
  const deletedBondCheck = resolveBond(molAfterDelete, { bondId: b12Id });
  assert(
    deletedBondCheck.ok === false && deletedBondCheck.code === MUTATION_FAILURE_CODES.UNKNOWN_BOND_ID,
    "Incident bond deleted with atom s1 is rejected with unknown_bond_id"
  );

  // 11f. Confirm surviving atoms and bonds still resolve accurately by their original IDs after index shift
  const survivingBondCheck = resolveBond(molAfterDelete, { bondId: b34Id });
  assert(
    survivingBondCheck.ok === true &&
      survivingBondCheck.bond.id === b34Id &&
      survivingBondCheck.atomA.id === s3.id &&
      survivingBondCheck.atomB.id === s4.id,
    "Surviving C-O bond and endpoint atom IDs remain stable after earlier atom deletion"
  );

  // 11g. Explicit bond removal rejects subsequent bond lookup
  const molWithoutB23 = removeBond(molAfterDelete, b23Id);
  const removedBondCheck = resolveBond(molWithoutB23, { bondId: b23Id });
  assert(
    removedBondCheck.ok === false && removedBondCheck.code === MUTATION_FAILURE_CODES.UNKNOWN_BOND_ID,
    "Explicitly removed bond ID is rejected on subsequent lookup"
  );

  // 11h. Adding a new atom never reuses deleted atom or bond IDs
  const s5 = addAtom(molWithoutB23, 160, 0, "N");
  assert(
    s5.id > b34Id && s5.id !== s1.id && s5.id !== b12Id && s5.id !== b23Id,
    "Newly created atom receives a fresh monotonic ID and never reuses deleted IDs"
  );
}

// -----------------------------------------------------------------------------
// Test 12: Phase 3A — Mutation Execution & Chemical Constraint Validation
// -----------------------------------------------------------------------------
{
  const stateManager = createMoleculeStateManager(null, "CCO"); // Ethanol: C - C - O
  const bridge = createEditorBridge({
    ...stateManager,
    getViewMode: () => "desktop",
    isReady: () => true,
  });

  const initialRead = await bridge.read_editor_structure();
  assert(initialRead.ok === true && initialRead.data.revision === 1, "Initial read reports revision 1");
  const atoms = initialRead.data.graph.atoms;
  const bonds = initialRead.data.graph.bonds;
  assert(
    atoms.every((a) => typeof a.id === "number" && typeof a.element === "string" && a.element.length > 0),
    "read_editor_structure exposes stable atom IDs and element symbols"
  );
  assert(
    bonds.every((b) => typeof b.id === "number" && typeof b.a1 === "number" && typeof b.a2 === "number"),
    "read_editor_structure exposes stable bond IDs and endpoint atom IDs"
  );

  // Find the C-O bond in Ethanol
  const oxygenAtom = atoms.find((a) => a.element === "O");
  const coBond = bonds.find((b) => b.a1 === oxygenAtom.id || b.a2 === oxygenAtom.id);
  assert(Boolean(oxygenAtom && coBond), "Located C-O bond in ethanol by atom/bond IDs");

  // 12a. Successful mutation: change C-O single bond (order 1) to C=O double bond (order 2 -> Acetaldehyde CC=O)
  const mutSuccess = await bridge.mutate_editor_structure({
    actionId: "act_eth_to_acetaldehyde",
    operation: "change_bond_order",
    arguments: { bondId: coBond.id, order: 2 },
    expectedRevision: 1,
  });
  assert(mutSuccess.ok === true, "Valid bond-order mutation (C-O -> C=O) succeeds");
  assert(mutSuccess.status === "committed", "Mutation status is 'committed'");
  assert(mutSuccess.actionId === "act_eth_to_acetaldehyde", "Response echoes actionId");
  assert(mutSuccess.revision === 2 && mutSuccess.previousRevision === 1, "Revision increments from 1 to 2");
  assert(mutSuccess.data.formula === "C2H4O", `Formula updated from C2H6O to C2H4O (got ${mutSuccess.data.formula})`);
  assert(
    mutSuccess.data.smiles === "CC=O" || mutSuccess.data.smiles === "O=CC",
    `SMILES updated to acetaldehyde (got ${mutSuccess.data.smiles})`
  );
  assert(mutSuccess.validationErrors.length === 0, "Successful mutation has 0 validationErrors");

  // 12b. Impossible valence: attempt to change C=O bond to a triple bond (C#O on neutral oxygen -> valence 3 > max 2)
  const mutImpossibleValence = await bridge.mutate_editor_structure({
    actionId: "act_impossible_oxygen_triple",
    operation: "change_bond_order",
    arguments: { bondId: coBond.id, order: 3 },
    expectedRevision: 2,
  });
  assert(mutImpossibleValence.ok === false, "Triple bond on neutral oxygen is rejected");
  assert(mutImpossibleValence.validationFailed === true, "Impossible valence sets validationFailed: true");
  assert(
    mutImpossibleValence.failureCode === MUTATION_FAILURE_CODES.VALENCE_VIOLATION,
    "Failure code is valence_violation"
  );
  assert(
    mutImpossibleValence.errorType === BRIDGE_ERROR_TYPES.INVALID_STRUCTURE,
    "Error type is invalid_structure"
  );
  assert(mutImpossibleValence.validationErrors.length > 0, "Validation errors array explains the valence violation");

  // 12c. Self-bond attempt
  const mutSelfBond = await bridge.mutate_editor_structure({
    actionId: "act_self_bond",
    operation: "change_bond_order",
    arguments: { atomId1: oxygenAtom.id, atomId2: oxygenAtom.id, order: 2 },
    expectedRevision: 2,
  });
  assert(mutSelfBond.ok === false, "Self-bond attempt is rejected");
  assert(mutSelfBond.failureCode === MUTATION_FAILURE_CODES.SELF_BOND, "Self-bond failureCode is self_bond");

  // 12d. Duplicate bond attempt (both via redundant bond order and via proposeBondAddition / validateProposedGraph)
  const mutDupOrder = await bridge.mutate_editor_structure({
    actionId: "act_dup_bond_order",
    operation: "change_bond_order",
    arguments: { bondId: coBond.id, order: 2 }, // already order 2!
    expectedRevision: 2,
  });
  assert(mutDupOrder.ok === false, "Duplicate bond order attempt on bond already at order 2 is rejected");
  assert(mutDupOrder.failureCode === MUTATION_FAILURE_CODES.DUPLICATE_BOND, "Failure code is duplicate_bond");

  const dupAddProposal = proposeBondAddition(stateManager.getMolecule(), {
    atomId1: coBond.a1,
    atomId2: coBond.a2,
    order: 1,
  });
  assert(
    dupAddProposal.ok === false && dupAddProposal.code === MUTATION_FAILURE_CODES.DUPLICATE_BOND,
    "proposeBondAddition rejects creating a second bond between already-connected atoms"
  );

  const curGraph = stateManager.getMolecule();
  const corruptedWithDupBond = {
    atoms: curGraph.atoms,
    bonds: [...curGraph.bonds, { id: 9999, a: coBond.a1, b: coBond.a2, order: 1 }],
  };
  const dupGraphValidation = validateProposedGraph(corruptedWithDupBond);
  assert(
    dupGraphValidation.valid === false && dupGraphValidation.code === MUTATION_FAILURE_CODES.DUPLICATE_BOND,
    "validateProposedGraph rejects a molecular graph containing duplicate bonds between the same atom pair"
  );

  // 12e. Unsupported operation
  const mutUnsupported = await bridge.mutate_editor_structure({
    actionId: "act_unsupported_op",
    operation: "auto_functional_group_transform",
    arguments: { bondId: coBond.id, order: 1 },
  });
  assert(
    mutUnsupported.ok === false && mutUnsupported.failureCode === MUTATION_FAILURE_CODES.UNKNOWN_OPERATION,
    "Unsupported mutation operation is rejected with unknown_operation"
  );

  // 12f. Missing / unavailable editor
  const unreadyBridge = createEditorBridge({
    getMolecule: () => stateManager.getMolecule(),
    isReady: () => false,
    getViewMode: () => "desktop",
  });
  const mutMissingEditor = await unreadyBridge.mutate_editor_structure({
    actionId: "act_unready_editor",
    operation: "change_bond_order",
    arguments: { bondId: coBond.id, order: 1 },
  });
  assert(
    mutMissingEditor.ok === false &&
      mutMissingEditor.unavailable === true &&
      mutMissingEditor.errorType === BRIDGE_ERROR_TYPES.EDITOR_UNAVAILABLE,
    "Mutation against unavailable editor returns unavailable: true and editor_unavailable"
  );
}

// -----------------------------------------------------------------------------
// Test 13: Phase 3A — Transactional Safety (Preservation on Failure, Rejection, Interruption)
// -----------------------------------------------------------------------------
{
  // Start with Isobutane CC(C)C: central carbon is bonded to 3 methyl carbons (valence sum = 3)
  const stateManager = createMoleculeStateManager(null, "CC(C)C");
  let approvalDecision = false;
  let throwOnApproval = false;
  let throwOnCommit = false;
  let corruptReadback = false;

  const customTarget = {
    getMolecule: () => {
      const m = stateManager.getMolecule();
      if (corruptReadback) {
        return { atoms: m.atoms, bonds: m.bonds.map((b) => ({ ...b, order: 1 })) };
      }
      return m;
    },
    getRevision: () => stateManager.getRevision(),
    getHistory: () => stateManager.getHistory(),
    exportCurrent: () => stateManager.exportCurrent(),
    commitMolecule: (nextMol) => {
      if (throwOnCommit) throw new Error("Simulated storage commit failure");
      stateManager.pushState(nextMol);
    },
    setMolecule: (nextMol) => stateManager.pushState(nextMol),
    undo: () => stateManager.undo(),
    redo: () => stateManager.redo(),
    isReady: () => true,
    getViewMode: () => "desktop",
    requestApproval: async () => {
      if (throwOnApproval) throw new Error("Approval modal interrupted");
      return approvalDecision;
    },
  };

  const bridge = createEditorBridge(customTarget);
  const beforeRead = await bridge.read_editor_structure();
  const beforeSmiles = beforeRead.data.smiles;
  const beforeRev = beforeRead.data.revision;
  const firstBondId = beforeRead.data.graph.bonds[0].id;

  // 13a. Validation failure (pentavalent carbon: central C has 3 single bonds; changing one to triple bond -> bond sum 5 > 4)
  const valFailRes = await bridge.mutate_editor_structure({
    actionId: "tx_pentavalent_carbon",
    operation: "change_bond_order",
    arguments: { bondId: firstBondId, order: 3 },
  });
  assert(valFailRes.ok === false && valFailRes.validationFailed === true, "Pentavalent carbon is rejected by valence validation");
  assert(stateManager.getRevision() === beforeRev, "Revision unchanged after validation failure");
  assert(stateManager.exportCurrent().smiles === beforeSmiles, "Original structure SMILES preserved after validation failure");
  assert(stateManager.getHistory().past.length === 0, "Undo history is not polluted by validation failure");

  // 13b. User rejection when requireApproval: true
  approvalDecision = false;
  const rejectedRes = await bridge.mutate_editor_structure({
    actionId: "tx_user_declined",
    operation: "change_bond_order",
    arguments: { bondId: firstBondId, order: 2 },
    requireApproval: true,
  });
  assert(
    rejectedRes.ok === false && rejectedRes.rejected === true && rejectedRes.cancelled === true && rejectedRes.needsApproval === true,
    "User rejection returns ok: false, rejected: true, cancelled: true, needsApproval: true"
  );
  assert(stateManager.getRevision() === beforeRev, "Revision unchanged after user rejection");
  assert(stateManager.exportCurrent().smiles === beforeSmiles, "Original structure preserved after user rejection");
  assert(stateManager.getHistory().past.length === 0, "Undo history is not altered by user rejection");

  // 13c. Interrupted approval callback does not corrupt structure
  throwOnApproval = true;
  const intApprovalRes = await bridge.mutate_editor_structure({
    actionId: "tx_interrupted_approval",
    operation: "change_bond_order",
    arguments: { bondId: firstBondId, order: 2 },
    requireApproval: true,
  });
  throwOnApproval = false;
  assert(
    intApprovalRes.ok === false && intApprovalRes.interrupted === true,
    "Thrown approval error marks mutation as interrupted: true"
  );
  assert(stateManager.exportCurrent().smiles === beforeSmiles, "Original structure preserved after interrupted approval");
  assert(stateManager.getHistory().past.length === 0, "Undo history untouched after interrupted approval");

  // 13d. Interrupted commit (exception during commitMolecule) does not report success or corrupt structure
  throwOnCommit = true;
  const intCommitRes = await bridge.mutate_editor_structure({
    actionId: "tx_interrupted_commit",
    operation: "change_bond_order",
    arguments: { bondId: firstBondId, order: 2 },
  });
  throwOnCommit = false;
  assert(
    intCommitRes.ok === false && intCommitRes.interrupted === true,
    "Thrown commit error returns ok: false and interrupted: true"
  );
  assert(stateManager.exportCurrent().smiles === beforeSmiles, "Original structure preserved after thrown commit error");
  assert(stateManager.getHistory().past.length === 0, "Undo history untouched after thrown commit error");

  // 13e. Readback verification failure rolls back and refuses to report success
  corruptReadback = true;
  const badReadbackRes = await bridge.mutate_editor_structure({
    actionId: "tx_failed_readback",
    operation: "change_bond_order",
    arguments: { bondId: firstBondId, order: 2 },
  });
  corruptReadback = false;
  assert(
    badReadbackRes.ok === false && badReadbackRes.interrupted === true,
    "Readback mismatch returns ok: false and interrupted: true"
  );
  assert(
    stateManager.exportCurrent().smiles === beforeSmiles,
    "Structure rolled back to original snapshot when readback verification fails"
  );
}

// -----------------------------------------------------------------------------
// Test 14: Phase 3A — Revision Control & Action ID Idempotency
// -----------------------------------------------------------------------------
{
  const stateManager = createMoleculeStateManager(null, "CC"); // Ethane C-C
  let approvalGateResolve = null;
  const bridge = createEditorBridge({
    ...stateManager,
    getViewMode: () => "desktop",
    isReady: () => true,
    requestApproval: () =>
      new Promise((resolve) => {
        approvalGateResolve = resolve;
      }),
  });

  const read1 = await bridge.read_editor_structure();
  const ccBondId = read1.data.graph.bonds[0].id;
  assert(read1.data.revision === 1, "Initial Ethane revision is 1");
  assert(bridge.getActionStatus("act_rev_1") === "new", "Unseen actionId has status 'new'");

  // 14a. Successful mutation increments revision from 1 to 2
  const res1 = await bridge.mutate_editor_structure({
    actionId: "act_rev_1",
    operation: "change_bond_order",
    arguments: { bondId: ccBondId, order: 2 }, // Ethane -> Ethene (C=C)
    expectedRevision: 1,
  });
  assert(res1.ok === true && res1.revision === 2, "First mutation succeeds and increments revision to 2");
  assert(bridge.getActionStatus("act_rev_1") === "completed", "Completed actionId has status 'completed'");
  assert(stateManager.getHistory().past.length === 1, "Exactly 1 undo history entry created");

  // 14b. Replaying the exact same completed actionId is blocked and does not create duplicate history entries
  const replayCompleted = await bridge.mutate_editor_structure({
    actionId: "act_rev_1",
    operation: "change_bond_order",
    arguments: { bondId: ccBondId, order: 3 },
  });
  assert(
    replayCompleted.ok === false &&
      replayCompleted.duplicate === true &&
      replayCompleted.actionState === "completed" &&
      replayCompleted.failureCode === MUTATION_FAILURE_CODES.DUPLICATE_ACTION,
    "Replayed completed actionId is rejected with duplicate_action and actionState 'completed'"
  );
  assert(stateManager.getRevision() === 2, "Replayed action does not increment revision");
  assert(stateManager.getHistory().past.length === 1, "Replayed action does not create duplicate history entry");
  assert(stateManager.exportCurrent().smiles === "C=C", "Molecule remains Ethene (C=C)");

  // 14c. Stale revision is rejected
  const staleRes = await bridge.mutate_editor_structure({
    actionId: "act_stale_rev",
    operation: "change_bond_order",
    arguments: { bondId: ccBondId, order: 3 },
    expectedRevision: 1, // Outdated! Current is 2
  });
  assert(
    staleRes.ok === false && staleRes.failureCode === MUTATION_FAILURE_CODES.STALE_REVISION,
    "Mutation with outdated expectedRevision (1 vs 2) is rejected with stale_revision"
  );
  assert(bridge.getActionStatus("act_stale_rev") === "failed", "Failed stale actionId is recorded as 'failed'");
  assert(stateManager.getRevision() === 2, "Stale revision failure does not increment revision");

  // 14d. Replaying a previously failed actionId is rejected with actionState 'failed'
  const replayFailed = await bridge.mutate_editor_structure({
    actionId: "act_stale_rev",
    operation: "change_bond_order",
    arguments: { bondId: ccBondId, order: 3 },
    expectedRevision: 2,
  });
  assert(
    replayFailed.ok === false && replayFailed.duplicate === true && replayFailed.actionState === "failed",
    "Replayed failed actionId is rejected with actionState 'failed'"
  );

  // 14e. Concurrent in-progress action detection
  const inProgressPromise = bridge.mutate_editor_structure({
    actionId: "act_in_flight",
    operation: "change_bond_order",
    arguments: { bondId: ccBondId, order: 3 },
    requireApproval: true,
  });
  assert(bridge.getActionStatus("act_in_flight") === "in_progress", "Action awaiting approval has status 'in_progress'");

  const concurrentAttempt = await bridge.mutate_editor_structure({
    actionId: "act_in_flight",
    operation: "change_bond_order",
    arguments: { bondId: ccBondId, order: 3 },
  });
  assert(
    concurrentAttempt.ok === false &&
      concurrentAttempt.duplicate === true &&
      concurrentAttempt.actionState === "in_progress" &&
      concurrentAttempt.failureCode === MUTATION_FAILURE_CODES.ACTION_IN_PROGRESS,
    "Concurrent duplicate request with same actionId is rejected with action_in_progress"
  );

  // Decline the in-flight approval and verify 'rejected' status in ledger
  approvalGateResolve(false);
  const finishedInFlight = await inProgressPromise;
  assert(finishedInFlight.ok === false && finishedInFlight.cancelled === true, "In-flight action resolves as cancelled when declined");
  assert(bridge.getActionStatus("act_in_flight") === "rejected", "Declined actionId has status 'rejected' in ledger");

  const replayRejected = await bridge.mutate_editor_structure({
    actionId: "act_in_flight",
    operation: "change_bond_order",
    arguments: { bondId: ccBondId, order: 3 },
  });
  assert(
    replayRejected.ok === false && replayRejected.duplicate === true && replayRejected.actionState === "rejected",
    "Replaying a rejected actionId returns actionState 'rejected'"
  );
}

// -----------------------------------------------------------------------------
// Test 15: Phase 3A — Undo, Redo, and Recovery Integration
// -----------------------------------------------------------------------------
{
  const stateManager = createMoleculeStateManager(null, "CC"); // Ethane (C2H6)
  const bridge = createEditorBridge({
    ...stateManager,
    getViewMode: () => "desktop",
    isReady: () => true,
  });

  const r0 = await bridge.read_editor_structure();
  const bondId = r0.data.graph.bonds[0].id;
  assert(r0.data.formula === "C2H6" && r0.data.smiles === "CC", "Starts as Ethane (CC, C2H6)");
  assert(bridge.canUndo() === false && bridge.canRedo() === false, "Initially canUndo and canRedo are false");

  // Mutate Ethane (CC) -> Ethene (C=C)
  const m1 = await bridge.change_bond_order({
    actionId: "undo_test_1",
    bondId,
    order: 2,
  });
  assert(m1.ok === true && m1.data.formula === "C2H4", "Mutated Ethane to Ethene (C2H4)");
  assert(bridge.canUndo() === true && bridge.canRedo() === false, "canUndo is true after successful mutation");

  // Mutate Ethene (C=C) -> Ethyne (C#C)
  const m2 = await bridge.change_bond_order({
    actionId: "undo_test_2",
    bondId,
    order: 3,
  });
  assert(m2.ok === true && m2.data.formula === "C2H2", "Mutated Ethene to Ethyne (C2H2)");
  assert(stateManager.getHistory().past.length === 2, "History contains 2 past states");

  // Attempt an invalid mutation (order 5) — must NOT add a history entry or clear redo stack
  const badMut = await bridge.change_bond_order({
    actionId: "undo_test_bad",
    bondId,
    order: 5,
  });
  assert(badMut.ok === false, "Invalid bond order 5 fails");
  assert(stateManager.getHistory().past.length === 2, "Failed mutation did not add a history entry");

  // Undo 1: Ethyne (C2H2) -> Ethene (C2H4)
  const undo1 = bridge.undo();
  assert(undo1 === true, "First undo succeeds");
  const afterUndo1 = await bridge.read_editor_structure();
  assert(afterUndo1.data.formula === "C2H4" && afterUndo1.data.smiles === "C=C", "First undo restores Ethene (C=C)");
  assert(bridge.canRedo() === true, "canRedo is true after undo");

  // Undo 2: Ethene (C2H4) -> Ethane (C2H6)
  const undo2 = bridge.undo();
  assert(undo2 === true, "Second undo succeeds");
  const afterUndo2 = await bridge.read_editor_structure();
  assert(afterUndo2.data.formula === "C2H6" && afterUndo2.data.smiles === "CC", "Second undo restores Ethane (CC)");
  assert(bridge.canUndo() === false, "canUndo is false at initial state");

  // Redo 1: Ethane (C2H6) -> Ethene (C2H4)
  const redo1 = bridge.redo();
  assert(redo1 === true, "First redo succeeds");
  const afterRedo1 = await bridge.read_editor_structure();
  assert(afterRedo1.data.formula === "C2H4" && afterRedo1.data.smiles === "C=C", "First redo restores Ethene (C=C)");

  // Redo 2: Ethene (C2H4) -> Ethyne (C2H2)
  const redo2 = bridge.redo();
  assert(redo2 === true, "Second redo succeeds");
  const afterRedo2 = await bridge.read_editor_structure();
  assert(afterRedo2.data.formula === "C2H2" && afterRedo2.data.smiles === "C#C", "Second redo restores Ethyne (C#C)");
}

// -----------------------------------------------------------------------------
// Test 16: Phase 3A — Desktop and Mobile Consistency & Shared State Parity
// -----------------------------------------------------------------------------
{
  // Shared state manager backing Desktop and Mobile views (mirroring Editor.jsx)
  const sharedManager = createMoleculeStateManager(null, "CC=O"); // Acetaldehyde
  let activeView = "desktop";

  const sharedBridge = createEditorBridge({
    ...sharedManager,
    getViewMode: () => activeView,
    isReady: () => true,
  });

  // 16a. Execute mutation in Desktop mode: reduce C=O double bond to C-O single bond (Ethanol CCO)
  const desktopRead = await sharedBridge.read_editor_structure();
  const doubleBond = desktopRead.data.graph.bonds.find((b) => b.order === 2);
  assert(Boolean(doubleBond), "Found C=O double bond on desktop canvas");

  const desktopMut = await sharedBridge.executeAction("change_bond_order", {
    actionId: "desktop_reduce_carbonyl",
    atomId1: doubleBond.a1,
    atomId2: doubleBond.a2,
    order: 1,
    expectedRevision: desktopRead.data.revision,
  });
  assert(desktopMut.ok === true && desktopMut.data.viewMode === "desktop", "Mutation succeeds in desktop editor mode");
  assert(desktopMut.data.smiles === "CCO" && desktopMut.data.formula === "C2H6O", "Desktop mutation produces Ethanol (CCO, C2H6O)");

  // 16b. Switch to Mobile mode: verify structure, atom/bond IDs, and revision are preserved seamlessly
  activeView = "mobile";
  const mobileRead = await sharedBridge.read_editor_structure();
  assert(mobileRead.ok === true && mobileRead.data.viewMode === "mobile", "Mobile editor reads shared state");
  assert(mobileRead.data.smiles === "CCO" && mobileRead.data.revision === desktopMut.revision, "Mobile editor sees exact committed structure and revision from desktop");

  // 16c. Execute mutation in Mobile mode: oxidize C-O single bond back to C=O double bond
  const mobileMut = await sharedBridge.executeAction("change_bond_order", {
    actionId: "mobile_oxidize_alcohol",
    bondId: doubleBond.id,
    order: 2,
    expectedRevision: mobileRead.data.revision,
  });
  assert(mobileMut.ok === true && mobileMut.data.viewMode === "mobile", "Mutation succeeds in mobile editor mode");
  assert(
    (mobileMut.data.smiles === "CC=O" || mobileMut.data.smiles === "O=CC") && mobileMut.data.formula === "C2H4O",
    "Mobile mutation produces consistent Acetaldehyde (C2H4O) structure"
  );

  // 16d. Switch back to Desktop and undo mobile's mutation using shared history
  activeView = "desktop";
  sharedBridge.undo();
  const afterSharedUndo = await sharedBridge.read_editor_structure();
  assert(afterSharedUndo.data.smiles === "CCO", "Undoing on desktop reverts mobile's mutation via shared history");
}

console.log(`--- ChemAI Editor Bridge Tests: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
console.log("--- All ChemAI Editor Bridge Tests Passed Successfully! ---");
