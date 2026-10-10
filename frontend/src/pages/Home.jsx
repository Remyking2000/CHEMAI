import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChemAINeuralHexIcon } from "../components/ChemAIIcons";
import ProcessTimeline from "../components/ProcessTimeline";

const SHOWCASE_MOLECULES = [
  {
    name: "Benzene",
    formula: "C₆H₆",
    iupac: "benzene",
    cid: 241,
    weight: "78.11 g/mol",
    smiles: "c1ccccc1",
    badge: "Aromatic Hydrocarbon",
    accent: "from-cyan-400 to-blue-500",
    groups: ["Conjugated π-Ring", "Planar Hexagonal Core", "sp² Hybridized Carbons"],
    summary:
      "The foundational six-carbon aromatic ring with delocalized pi electrons that confer exceptional thermodynamic stability.",
  },
  {
    name: "Aspirin",
    formula: "C₉H₈O₄",
    iupac: "2-acetyloxybenzoic acid",
    cid: 2244,
    weight: "180.16 g/mol",
    smiles: "CC(=O)Oc1ccccc1C(=O)O",
    badge: "Analgesic & Anti-inflammatory",
    accent: "from-indigo-400 to-violet-500",
    groups: ["Carboxylic Acid (-COOH)", "Ester Group (-COO-)", "Benzene Ring"],
    summary:
      "An aromatic ester derivative of salicylic acid combining a polar carboxylic acid group with an acetyl ester functionality.",
  },
  {
    name: "Caffeine",
    formula: "C₈H₁₀N₄O₂",
    iupac: "1,3,7-trimethylpurine-2,6-dione",
    cid: 2519,
    weight: "194.19 g/mol",
    smiles: "Cn1cnc2c1c(=O)n(c(=O)n2C)C",
    badge: "Purine Alkaloid",
    accent: "from-emerald-400 to-teal-500",
    groups: ["Xanthine Core", "Imidazole Ring", "Amide Carbonyls (C=O)"],
    summary:
      "A bicyclic nitrogen-rich heterocycle featuring fused pyrimidinedione and imidazole rings with three N-methyl substituents.",
  },
  {
    name: "Ethanol",
    formula: "C₂H₆O",
    iupac: "ethanol",
    cid: 702,
    weight: "46.07 g/mol",
    smiles: "CCO",
    badge: "Primary Alcohol",
    accent: "from-amber-400 to-orange-500",
    groups: ["Hydroxyl Group (-OH)", "Ethyl Chain (-C₂H₅)", "Hydrogen-Bond Donor"],
    summary:
      "A versatile polar protic solvent whose hydroxyl functional group enables extensive intermolecular hydrogen bonding.",
  },
];

const ATOM_PALETTE = [
  { symbol: "C", color: "#38bdf8", glow: "rgba(56, 189, 248, 0.45)", radius: 13 },
  { symbol: "O", color: "#fb7185", glow: "rgba(251, 113, 133, 0.45)", radius: 12 },
  { symbol: "N", color: "#818cf8", glow: "rgba(129, 140, 248, 0.45)", radius: 12 },
  { symbol: "H", color: "#e2e8f0", glow: "rgba(226, 232, 240, 0.35)", radius: 8.5 },
  { symbol: "P", color: "#fbbf24", glow: "rgba(251, 191, 36, 0.4)", radius: 13 },
  { symbol: "S", color: "#34d399", glow: "rgba(52, 211, 153, 0.4)", radius: 12.5 },
];

function FloatingAtomsCanvas() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId;
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    const mouse = { x: -9999, y: -9999 };

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    };

    const handleMouseMove = (e) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    };

    const handleMouseLeave = () => {
      mouse.x = -9999;
      mouse.y = -9999;
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseleave", handleMouseLeave);

    const count = Math.min(42, Math.max(24, Math.floor((width * height) / 36000)));
    const atoms = Array.from({ length: count }, (_, idx) => {
      const spec = ATOM_PALETTE[idx % ATOM_PALETTE.length];
      return {
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.65,
        vy: (Math.random() - 0.5) * 0.65,
        symbol: spec.symbol,
        color: spec.color,
        glow: spec.glow,
        radius: spec.radius,
        orbitAngle: Math.random() * Math.PI * 2,
        orbitSpeed: (Math.random() * 0.02 + 0.01) * (idx % 2 === 0 ? 1 : -1),
        doubleBondCandidate: idx % 4 === 0,
      };
    });

    const render = () => {
      ctx.clearRect(0, 0, width, height);

      // Update positions
      for (let i = 0; i < atoms.length; i++) {
        const a = atoms[i];
        a.x += a.vx;
        a.y += a.vy;
        a.orbitAngle += a.orbitSpeed;

        // Soft bounce at screen edges
        if (a.x < -30) a.x = width + 30;
        if (a.x > width + 30) a.x = -30;
        if (a.y < -30) a.y = height + 30;
        if (a.y > height + 30) a.y = -30;

        // Gentle mouse interaction
        const dx = a.x - mouse.x;
        const dy = a.y - mouse.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 150 && dist > 1) {
          const force = (150 - dist) / 150;
          a.x += (dx / dist) * force * 1.4;
          a.y += (dy / dist) * force * 1.4;
        }
      }

      // Draw dynamic covalent bonds between nearby atoms
      const maxBondDist = 175;
      for (let i = 0; i < atoms.length; i++) {
        for (let j = i + 1; j < atoms.length; j++) {
          const a = atoms[i];
          const b = atoms[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < maxBondDist) {
            const alpha = (1 - dist / maxBondDist) * 0.42;
            ctx.strokeStyle = `rgba(103, 232, 249, ${alpha})`;

            if (a.doubleBondCandidate && b.doubleBondCandidate && dist < 130) {
              // Draw parallel double bond
              const nx = (-dy / dist) * 2.6;
              const ny = (dx / dist) * 2.6;
              ctx.lineWidth = 1.4;
              ctx.beginPath();
              ctx.moveTo(a.x + nx, a.y + ny);
              ctx.lineTo(b.x + nx, b.y + ny);
              ctx.moveTo(a.x - nx, a.y - ny);
              ctx.lineTo(b.x - nx, b.y - ny);
              ctx.stroke();
            } else {
              // Single bond
              ctx.lineWidth = 1.3;
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
              ctx.stroke();
            }
          }
        }
      }

      // Draw each atom sphere, electron orbital, and chemical symbol
      for (let i = 0; i < atoms.length; i++) {
        const a = atoms[i];

        // Outer glow
        const grad = ctx.createRadialGradient(a.x, a.y, 1, a.x, a.y, a.radius * 2.4);
        grad.addColorStop(0, a.glow);
        grad.addColorStop(1, "rgba(15, 23, 42, 0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.radius * 2.4, 0, Math.PI * 2);
        ctx.fill();

        // Subtle orbital ring and orbiting electron for larger atoms
        if (a.radius >= 12) {
          ctx.strokeStyle = "rgba(148, 163, 184, 0.2)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(a.x, a.y, a.radius + 7, 0, Math.PI * 2);
          ctx.stroke();

          const ex = a.x + Math.cos(a.orbitAngle) * (a.radius + 7);
          const ey = a.y + Math.sin(a.orbitAngle) * (a.radius + 7);
          ctx.fillStyle = a.color;
          ctx.beginPath();
          ctx.arc(ex, ey, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }

        // Core nucleus sphere
        ctx.fillStyle = "rgba(15, 23, 42, 0.88)";
        ctx.strokeStyle = a.color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Element symbol
        ctx.fillStyle = a.color;
        ctx.font = `bold ${a.radius > 10 ? 10 : 8}px ui-monospace, SFMono-Regular, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(a.symbol, a.x, a.y + 0.5);
      }

      animationFrameId = window.requestAnimationFrame(render);
    };

    render();

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none z-0"
      aria-hidden="true"
    />
  );
}

const Home = () => {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const activeMol = SHOWCASE_MOLECULES[selectedIdx];

  return (
    <div className="relative min-h-[calc(100vh-69px)] bg-slate-950 text-white overflow-hidden flex flex-col justify-between">
      {/* Interactive Floating Atoms & Covalent Bonds Canvas */}
      <FloatingAtomsCanvas />

      {/* Ambient Glowing Nebulae & Floating SVG Benzene Ring */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full bg-cyan-500/15 blur-3xl animate-pulse-glow" />
        <div className="absolute top-1/3 -right-32 w-[28rem] h-[28rem] rounded-full bg-indigo-600/15 blur-3xl animate-pulse-glow" />
        <div className="absolute -bottom-32 left-1/3 w-96 h-96 rounded-full bg-blue-600/15 blur-3xl animate-pulse-glow" />

        {/* Floating decorative benzene SVG top-right */}
        <svg
          viewBox="0 0 120 120"
          className="hidden lg:block absolute top-24 right-16 w-28 h-28 text-cyan-400/15 animate-float-slow"
          fill="none"
        >
          <polygon
            points="60,12 102,36 102,84 60,108 18,84 18,36"
            stroke="currentColor"
            strokeWidth="2.5"
          />
          <circle
            cx="60"
            cy="60"
            r="26"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="6 4"
          />
        </svg>

        {/* Floating decorative molecule bottom-left */}
        <svg
          viewBox="0 0 120 120"
          className="hidden lg:block absolute bottom-20 left-12 w-24 h-24 text-indigo-400/15 animate-float-reverse"
          fill="none"
        >
          <line x1="60" y1="60" x2="25" y2="32" stroke="currentColor" strokeWidth="2.5" />
          <line x1="60" y1="60" x2="95" y2="32" stroke="currentColor" strokeWidth="2.5" />
          <line x1="60" y1="60" x2="60" y2="102" stroke="currentColor" strokeWidth="2.5" />
          <circle cx="60" cy="60" r="10" fill="currentColor" />
          <circle cx="25" cy="32" r="7" fill="currentColor" />
          <circle cx="95" cy="32" r="7" fill="currentColor" />
          <circle cx="60" cy="102" r="7" fill="currentColor" />
        </svg>
      </div>

      {/* Main Content Container */}
      <main className="relative z-10 max-w-7xl mx-auto w-full px-4 sm:px-6 pt-10 pb-16 space-y-16">
        {/* Hero Grid */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-center pt-2">
          {/* Left Column: Hero Copy & Primary CTAs */}
          <div className="lg:col-span-7 space-y-6 text-center lg:text-left">
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-400/30 text-cyan-300 text-xs font-semibold tracking-wide shadow-sm">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
              <span>Interactive Molecular Studio · Smart Chemistry Companion</span>
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight leading-[1.1]">
              Welcome to{" "}
              <span className="bg-gradient-to-r from-cyan-400 via-blue-400 to-indigo-400 bg-clip-text text-transparent">
                ChemAI
              </span>
              <span className="block text-2xl sm:text-3xl lg:text-4xl font-bold text-slate-200 mt-3">
                Draw, Identify &amp; Understand Molecules Live
              </span>
            </h1>

            <p className="text-slate-300 text-base sm:text-lg max-w-2xl mx-auto lg:mx-0 leading-relaxed">
              Sketch organic structures on an intuitive 2D canvas, uncover their{" "}
              <span className="text-cyan-300 font-semibold">chemical identity in seconds</span>,
              and explore clear, guided insights into functional groups and{" "}
              <span className="text-indigo-300 font-semibold">molecular behavior</span>.
            </p>

            {/* Primary CTA Buttons */}
            <div className="flex flex-wrap items-center justify-center lg:justify-start gap-4 pt-2">
              <Link
                to="/editor"
                className="group relative inline-flex items-center gap-3 px-7 py-3.5 rounded-xl bg-gradient-to-r from-cyan-500 via-blue-600 to-indigo-600 hover:from-cyan-400 hover:via-blue-500 hover:to-indigo-500 text-white font-bold text-base shadow-lg shadow-cyan-500/25 hover:shadow-cyan-400/40 hover:-translate-y-0.5 transition-all"
              >
                <span>🧪</span>
                <span>Open Editor</span>
                <span className="group-hover:translate-x-1 transition-transform">→</span>
              </Link>

              <a
                href="#how-it-works"
                className="inline-flex items-center gap-2.5 px-5 py-3.5 rounded-xl bg-slate-900/80 hover:bg-slate-800/90 text-slate-200 border border-slate-700/80 hover:border-cyan-500/40 font-semibold text-sm transition-all"
              >
                <ChemAINeuralHexIcon className="w-5 h-5 text-cyan-400" />
                <span>Explore Capabilities</span>
              </a>
            </div>

            {/* Quick Feature Badges */}
            <div className="pt-4 flex flex-wrap items-center justify-center lg:justify-start gap-3 text-xs text-slate-400">
              <span className="uppercase tracking-wider font-bold text-slate-500">
                Highlights:
              </span>
              <span className="px-2.5 py-1 rounded-md bg-slate-900/90 border border-slate-800 text-cyan-300 font-mono">
                2D Structure Canvas
              </span>
              <span className="px-2.5 py-1 rounded-md bg-slate-900/90 border border-slate-800 text-blue-300 font-mono">
                Instant Recognition
              </span>
              <span className="px-2.5 py-1 rounded-md bg-slate-900/90 border border-slate-800 text-indigo-300 font-mono">
                Guided Explanations
              </span>
              <span className="px-2.5 py-1 rounded-md bg-slate-900/90 border border-slate-800 text-violet-300 font-mono">
                One-Click Export
              </span>
            </div>
          </div>

          {/* Right Column: Interactive Live Molecule Explorer Card */}
          <div className="lg:col-span-5">
            <div className="rounded-2xl bg-slate-900/75 backdrop-blur-xl border border-cyan-500/25 shadow-2xl shadow-cyan-950/50 overflow-hidden">
              {/* Card Top Bar */}
              <div className="px-5 py-3.5 bg-slate-950/70 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-rose-500" />
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                  <span className="ml-2 text-xs font-bold uppercase tracking-wider text-slate-400">
                    Molecule Spotlight
                  </span>
                </div>
                <span className="text-[11px] font-mono text-cyan-300 bg-cyan-500/10 px-2.5 py-0.5 rounded-full border border-cyan-500/20">
                  Live Preview
                </span>
              </div>

              {/* Molecule Selector Tabs */}
              <div className="px-5 pt-4 flex flex-wrap gap-2">
                {SHOWCASE_MOLECULES.map((mol, idx) => (
                  <button
                    key={mol.name}
                    onClick={() => setSelectedIdx(idx)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                      selectedIdx === idx
                        ? "bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-sm"
                        : "bg-slate-800/80 text-slate-400 hover:text-white hover:bg-slate-800"
                    }`}
                  >
                    {mol.name}
                  </button>
                ))}
              </div>

              {/* Active Molecule Card Body */}
              <div className="p-5 space-y-4">
                <div className="flex items-baseline justify-between gap-2 border-b border-slate-800/80 pb-3">
                  <div>
                    <span className="text-[11px] font-bold uppercase tracking-wider text-cyan-400">
                      {activeMol.badge}
                    </span>
                    <h2 className="text-2xl font-extrabold text-white mt-0.5">
                      {activeMol.name}
                    </h2>
                    <p className="text-xs text-slate-400 font-mono">
                      {activeMol.iupac}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-extrabold font-mono bg-gradient-to-r from-cyan-300 to-indigo-300 bg-clip-text text-transparent">
                      {activeMol.formula}
                    </div>
                    <div className="text-xs text-slate-400 font-mono">
                      {activeMol.weight}
                    </div>
                  </div>
                </div>

                <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
                  {activeMol.summary}
                </p>

                {/* Functional Groups Pills */}
                <div>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block mb-2">
                    Key Structural Features
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {activeMol.groups.map((grp) => (
                      <span
                        key={grp}
                        className="text-xs px-2.5 py-1 rounded-md bg-slate-800/90 border border-slate-700 text-cyan-200 font-medium"
                      >
                        {grp}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Quick Action Box */}
                <div className="bg-slate-950/90 rounded-lg p-3 border border-slate-800 flex items-center justify-between gap-2">
                  <div className="overflow-hidden">
                    <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500 block">
                      Structure Notation
                    </span>
                    <code className="text-xs font-mono text-emerald-300 truncate block">
                      {activeMol.smiles}
                    </code>
                  </div>
                  <Link
                    to="/editor"
                    className="shrink-0 px-3 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 text-xs font-semibold transition-colors"
                  >
                    Draw in Editor →
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Workflow & Interactive Timeline Section */}
        <section id="how-it-works" className="space-y-8">
          <div className="text-center max-w-2xl mx-auto space-y-2">
            <span className="text-xs font-bold uppercase tracking-widest text-cyan-400">
              Seamless Experience
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-white">
              Everything You Need to Explore Chemical Structures
            </h2>
            <p className="text-sm text-slate-400">
              From freehand sketching to instant recognition and clear structural insights.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Card 1 */}
            <div className="group rounded-2xl bg-slate-900/70 backdrop-blur-md border border-slate-800 hover:border-cyan-500/40 p-6 transition-all hover:-translate-y-1">
              <div className="w-12 h-12 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-2xl mb-4 group-hover:scale-110 transition-transform">
                ✏️
              </div>
              <span className="text-xs font-bold uppercase tracking-wider text-cyan-400">
                01 · Interactive Canvas
              </span>
              <h3 className="text-lg font-bold text-white mt-1 mb-2">
                2D Molecular Sketching
              </h3>
              <p className="text-sm text-slate-300 leading-relaxed">
                Draw single, double, and triple bonds, aromatic rings, and functional groups
                on a fluid workspace built for speed and clarity.
              </p>
            </div>

            {/* Card 2 */}
            <div className="group rounded-2xl bg-slate-900/70 backdrop-blur-md border border-slate-800 hover:border-blue-500/40 p-6 transition-all hover:-translate-y-1">
              <div className="w-12 h-12 rounded-xl bg-blue-500/15 border border-blue-500/30 flex items-center justify-center text-2xl mb-4 group-hover:scale-110 transition-transform">
                🔬
              </div>
              <span className="text-xs font-bold uppercase tracking-wider text-blue-400">
                02 · Smart Recognition
              </span>
              <h3 className="text-lg font-bold text-white mt-1 mb-2">
                Instant Compound Identity
              </h3>
              <p className="text-sm text-slate-300 leading-relaxed">
                Identify drawn molecules with a single click to reveal their systematic names,
                formulas, molecular weights, and key traits.
              </p>
            </div>

            {/* Card 3 */}
            <div className="group rounded-2xl bg-slate-900/70 backdrop-blur-md border border-slate-800 hover:border-violet-500/40 p-6 transition-all hover:-translate-y-1">
              <div className="w-12 h-12 rounded-xl bg-violet-500/15 border border-violet-500/30 flex items-center justify-center text-violet-300 mb-4 group-hover:scale-110 transition-transform">
                <ChemAINeuralHexIcon className="w-7 h-7" />
              </div>
              <span className="text-xs font-bold uppercase tracking-wider text-violet-400">
                03 · Guided Learning
              </span>
              <h3 className="text-lg font-bold text-white mt-1 mb-2">
                Smart Structure Insights
              </h3>
              <p className="text-sm text-slate-300 leading-relaxed">
                Understand what a compound is, how its functional groups behave, and why its
                bonding features matter in plain, approachable language.
              </p>
            </div>
          </div>

          {/* Interactive Horizontally Scrolling Process Timeline */}
          <ProcessTimeline />
        </section>

        {/* Bottom Call-to-Action Banner */}
        <section className="rounded-2xl bg-gradient-to-r from-cyan-950/80 via-slate-900/90 to-indigo-950/80 border border-cyan-500/30 p-8 text-center space-y-4 shadow-xl">
          <h2 className="text-2xl sm:text-3xl font-extrabold text-white">
            Ready to Sketch Your First Molecule?
          </h2>
          <p className="text-slate-300 text-sm sm:text-base max-w-xl mx-auto">
            Jump right into the 2D workspace or start from a built-in template to explore
            live molecular recognition.
          </p>
          <div className="pt-2">
            <Link
              to="/editor"
              className="inline-flex items-center gap-2.5 px-8 py-3.5 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-bold text-base shadow-lg shadow-cyan-500/25 transition-all hover:scale-105"
            >
              <span>Launch Molecular Workspace</span>
              <span>→</span>
            </Link>
          </div>
        </section>
      </main>

      {/* Subtle Footer */}
      <footer className="relative z-10 border-t border-slate-800/80 bg-slate-950/80 backdrop-blur-sm py-4 px-6 text-center text-xs text-slate-500">
        ChemAI · Interactive Molecular Studio &amp; Smart Chemistry Companion
      </footer>
    </div>
  );
};

export default Home;
