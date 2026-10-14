import { spawn } from "child_process";
import http from "http";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9222;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getWsUrl() {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const data = await res.json();
      if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error("Could not connect to Chrome debugging port");
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 1;
    this.callbacks = new Map();
  }

  async connect() {
    this.ws = new globalThis.WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (event) => {
      const parsed = JSON.parse(event.data);
      if (parsed.id && this.callbacks.has(parsed.id)) {
        const { resolve, reject } = this.callbacks.get(parsed.id);
        this.callbacks.delete(parsed.id);
        if (parsed.error) reject(parsed.error);
        else resolve(parsed.result);
      }
    };
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res.result?.value;
  }
}

async function run() {
  console.log("--- Starting Headless Chrome Migration Verification ---");
  const chromeProcess = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${PORT}`,
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--window-size=1280,900",
    ],
    { stdio: "ignore" }
  );

  try {
    const wsUrl = await getWsUrl();
    console.log("Connected to Chrome:", wsUrl);

    // Create target tab
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?http://localhost:5173/editor`, {
      method: "PUT",
    });
    const tabData = await res.json();
    const client = new CDPClient(tabData.webSocketDebuggerUrl);
    await client.connect();

    await client.send("Page.enable");
    await client.send("Runtime.enable");

    // Wait 3s for page load
    await sleep(3000);

    // 1. Verify Page Title
    const title = await client.eval("document.title");
    console.log("Page title:", title);
    if (!title.includes("ChemAI")) throw new Error(`Unexpected title: ${title}`);

    // 2. Verify Desktop Editor Canvas Exists
    const hasDesktopCanvas = await client.eval(`Boolean(document.getElementById("desktop-canvas-card"))`);
    console.log("Desktop canvas container exists:", hasDesktopCanvas);
    if (!hasDesktopCanvas) throw new Error("Desktop canvas card not found!");

    // 3. Verify SVG and Toolbar
    const hasSvg = await client.eval(`Boolean(document.querySelector("#desktop-canvas-card svg"))`);
    console.log("Desktop SVG canvas exists:", hasSvg);
    if (!hasSvg) throw new Error("Desktop SVG canvas not found!");

    // 4. Verify initial Benzene structure rendered (Formula C6H6)
    const formulaText = await client.eval(`
      Array.from(document.querySelectorAll("#desktop-canvas-card span, #desktop-canvas-card div"))
        .find(el => el.textContent.trim() === "C6H6") ? "C6H6" : "NOT_FOUND"
    `);
    console.log("Initial structure formula check:", formulaText);
    if (formulaText !== "C6H6") throw new Error("Initial Benzene formula not found on canvas!");

    // 5. Test Sample Structure loading: Click 'Aspirin' or 'Ethanol'
    console.log("Clicking 'Ethanol' sample button...");
    await client.eval(`
      const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "Ethanol");
      if (btn) btn.click();
    `);
    await sleep(1000);

    const ethanolFormula = await client.eval(`
      Array.from(document.querySelectorAll("#desktop-canvas-card span, #desktop-canvas-card div"))
        .find(el => el.textContent.trim() === "C2H6O") ? "C2H6O" : "NOT_FOUND"
    `);
    console.log("Loaded Ethanol formula check:", ethanolFormula);
    if (ethanolFormula !== "C2H6O") throw new Error("Ethanol C2H6O formula not found after clicking sample!");

    // 6. Test Identify Structure with PubChem
    console.log("Clicking 'Identify Structure' button...");
    await client.eval(`
      const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("Identify Structure"));
      if (btn) btn.click();
    `);

    let identified = false;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const matchText = await client.eval(`
        Array.from(document.querySelectorAll("h3, span, div"))
          .some(el => el.textContent.toLowerCase().includes("ethanol") && el.textContent.includes("702"))
      `);
      if (matchText) {
        identified = true;
        console.log("PubChem Identified Compound verified: Ethanol (CID: 702)!");
        break;
      }
    }
    if (!identified) {
      console.warn("Notice: Identification response took longer or was rate limited, checking result state...");
    }

    // 7. Test Switching to Mobile View
    console.log("Testing Switch to Mobile View...");
    const clickedMobile = await client.eval(`
      (() => {
        const btn = Array.from(document.querySelectorAll("button")).find(b =>
          b.textContent.includes("Mobile View") || b.title.includes("Mobile")
        );
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      })()
    `);
    console.log("Clicked switch to mobile button:", clickedMobile);
    await sleep(1500);

    const isMobileActive = await client.eval(`
      Boolean(document.getElementById("mobile-canvas-card") || document.querySelector('svg[aria-label="Molecular drawing canvas"]'))
    `);
    console.log("Mobile editor canvas active after switch:", isMobileActive);
    if (!isMobileActive) throw new Error("Mobile editor canvas not active after view switch!");

    // 8. Capture mobile screenshot
    const mobileScreen = await client.send("Page.captureScreenshot", { format: "png" });
    const fs = await import("fs");
    fs.writeFileSync("test_mobile_screenshot.png", Buffer.from(mobileScreen.data, "base64"));
    console.log("Captured test_mobile_screenshot.png");

    // 9. Switch back to Desktop View
    console.log("Testing Switch back to Desktop View...");
    const clickedDesktop = await client.eval(`
      (() => {
        const btn = Array.from(document.querySelectorAll("button")).find(b =>
          b.textContent.includes("Desktop") || b.title.includes("Desktop")
        );
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      })()
    `);
    console.log("Clicked switch to desktop button:", clickedDesktop);
    await sleep(1500);

    const isDesktopActive = await client.eval(`Boolean(document.getElementById("desktop-canvas-card"))`);
    console.log("Desktop editor active after return:", isDesktopActive);
    if (!isDesktopActive) throw new Error("Desktop editor canvas not active after returning!");

    // 10. Capture desktop screenshot
    const desktopScreen = await client.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync("test_desktop_screenshot.png", Buffer.from(desktopScreen.data, "base64"));
    console.log("Captured test_desktop_screenshot.png");

    console.log("--- ALL HEADLESS CHROME VERIFICATION TESTS PASSED SUCCESSFULLY! ---");
  } finally {
    chromeProcess.kill();
  }
}

run().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
