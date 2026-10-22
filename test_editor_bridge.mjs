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
} from "./frontend/src/lib/editorBridge.js";
import {
  EMPTY_MOL,
  molFromSmiles,
  exportStructure,
  computeViewportTransform,
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

console.log(`--- ChemAI Editor Bridge Tests: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
console.log("--- All ChemAI Editor Bridge Tests Passed Successfully! ---");
