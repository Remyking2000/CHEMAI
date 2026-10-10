import React, { useEffect, useRef, useState, useCallback } from "react";
import { ChemAINeuralHexIcon } from "./ChemAIIcons";

/**
 * High-level, user-focused experience stages that preserve the magic of ChemAI
 * without exposing underlying libraries, APIs, or backend mechanics.
 */
const TIMELINE_STEPS = [
  {
    id: 1,
    number: "01",
    title: "Sketch",
    subtitle: "Canvas",
    role: "Create",
    description: "Draw freehand or pick a starter molecule to begin.",
    icon: (props) => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    ),
  },
  {
    id: 2,
    number: "02",
    title: "Shape",
    subtitle: "Structure",
    role: "Refine",
    description: "Snap rings, chains, and bonds together effortlessly.",
    icon: (props) => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <polygon points="12 2 20.66 7 20.66 17 12 22 3.34 17 3.34 7 12 2" />
        <circle cx="12" cy="12" r="4.5" strokeDasharray="3 2" />
      </svg>
    ),
  },
  {
    id: 3,
    number: "03",
    title: "Recognize",
    subtitle: "Identity",
    role: "Discover",
    description: "Uncover the compound's chemical identity in an instant.",
    icon: (props) => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
    ),
  },
  {
    id: 4,
    number: "04",
    title: "Profile",
    subtitle: "Properties",
    role: "Measure",
    description: "See key formulas and molecular traits at a glance.",
    icon: (props) => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="M9 3h6" />
        <path d="M10 3v5.2a2 2 0 0 1-.5 1.3L4.7 16a2.5 2.5 0 0 0 1.9 4.1h10.8a2.5 2.5 0 0 0 1.9-4.1l-4.8-6.5a2 2 0 0 1-.5-1.3V3" />
        <path d="M7.5 15h9" />
      </svg>
    ),
  },
  {
    id: 5,
    number: "05",
    title: "Understand",
    subtitle: "Smart Insight",
    role: "Learn",
    description: "Explore clear, intuitive breakdowns of how the molecule behaves.",
    icon: (props) => <ChemAINeuralHexIcon {...props} />,
  },
  {
    id: 6,
    number: "06",
    title: "Export",
    subtitle: "Takeaway",
    role: "Share",
    description: "Save your structure and continue your work anywhere.",
    icon: (props) => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    ),
  },
];

// Geometry constants for a deep, dramatic sinusoidal wave
const STEP_SPACING = 260;
const PADDING_X = 160;
const CENTER_Y = 230;
const WAVE_CONTROL_AMPLITUDE = 115;
const TRACK_HEIGHT = 440;

function buildWavyPath(stepCount) {
  if (stepCount < 2) return "";
  let d = `M ${PADDING_X} ${CENTER_Y}`;

  for (let i = 0; i < stepCount - 1; i++) {
    const x0 = PADDING_X + i * STEP_SPACING;
    const x1 = PADDING_X + (i + 1) * STEP_SPACING;
    const xMid = (x0 + x1) / 2;
    const halfSpan = STEP_SPACING / 2;
    const cpOffset = halfSpan * 0.38;

    // First half-wave: dramatic upward crest (x0 -> xMid)
    const crestCp1x = x0 + cpOffset;
    const crestCp1y = CENTER_Y - WAVE_CONTROL_AMPLITUDE;
    const crestCp2x = xMid - cpOffset;
    const crestCp2y = CENTER_Y - WAVE_CONTROL_AMPLITUDE;

    // Second half-wave: dramatic downward trough (xMid -> x1)
    const troughCp1x = xMid + cpOffset;
    const troughCp1y = CENTER_Y + WAVE_CONTROL_AMPLITUDE;
    const troughCp2x = x1 - cpOffset;
    const troughCp2y = CENTER_Y + WAVE_CONTROL_AMPLITUDE;

    d += ` C ${crestCp1x} ${crestCp1y}, ${crestCp2x} ${crestCp2y}, ${xMid} ${CENTER_Y}`;
    d += ` C ${troughCp1x} ${troughCp1y}, ${troughCp2x} ${troughCp2y}, ${x1} ${CENTER_Y}`;
  }

  return d;
}

export default function ProcessTimeline() {
  const [activeNodeIndex, setActiveNodeIndex] = useState(1);
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const [panDirection, setPanDirection] = useState(0);

  const scrollContainerRef = useRef(null);
  const activePathRef = useRef(null);
  const pulseOrbRef = useRef(null);
  const pulseHaloRef = useRef(null);

  const totalPathLengthRef = useRef(0);
  const targetProgressRef = useRef(1 / (TIMELINE_STEPS.length - 1));
  const currentProgressRef = useRef(1 / (TIMELINE_STEPS.length - 1));
  const panVelocityRef = useRef(0);
  const isMouseInsideRef = useRef(false);
  const lastMouseViewportXRef = useRef(0);
  const rafIdRef = useRef(null);

  const totalSpanX = (TIMELINE_STEPS.length - 1) * STEP_SPACING;
  const totalWidth = PADDING_X * 2 + totalSpanX;
  const wavyPathData = buildWavyPath(TIMELINE_STEPS.length);

  useEffect(() => {
    if (activePathRef.current) {
      const len = activePathRef.current.getTotalLength();
      totalPathLengthRef.current = len;
      activePathRef.current.style.strokeDasharray = `${len}`;
      activePathRef.current.style.strokeDashoffset = `${
        len * (1 - currentProgressRef.current)
      }`;
    }

    let lastReportedIndex = 1;

    const tick = () => {
      const container = scrollContainerRef.current;
      const pathEl = activePathRef.current;
      const totalLen = totalPathLengthRef.current;

      if (container && panVelocityRef.current !== 0) {
        container.scrollLeft += panVelocityRef.current;
      }

      if (container && isMouseInsideRef.current) {
        const trackMouseX =
          lastMouseViewportXRef.current + container.scrollLeft;
        const rawProgress = (trackMouseX - PADDING_X) / totalSpanX;
        targetProgressRef.current = Math.max(0, Math.min(1, rawProgress));
      }

      const diff = targetProgressRef.current - currentProgressRef.current;
      if (Math.abs(diff) > 0.0005) {
        currentProgressRef.current += diff * 0.14;
      } else {
        currentProgressRef.current = targetProgressRef.current;
      }

      if (pathEl && totalLen > 0) {
        const drawnLen = totalLen * currentProgressRef.current;
        pathEl.style.strokeDashoffset = `${totalLen - drawnLen}`;

        if (pulseOrbRef.current && pulseHaloRef.current) {
          const pt = pathEl.getPointAtLength(drawnLen);
          pulseOrbRef.current.setAttribute("cx", pt.x);
          pulseOrbRef.current.setAttribute("cy", pt.y);
          pulseHaloRef.current.setAttribute("cx", pt.x);
          pulseHaloRef.current.setAttribute("cy", pt.y);
        }
      }

      const reachedIndex = Math.floor(
        currentProgressRef.current * (TIMELINE_STEPS.length - 1) + 0.08
      );
      if (reachedIndex !== lastReportedIndex) {
        lastReportedIndex = reachedIndex;
        setActiveNodeIndex(reachedIndex);
      }

      rafIdRef.current = requestAnimationFrame(tick);
    };

    rafIdRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    };
  }, [totalSpanX]);

  const handleMouseMove = useCallback((e) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    isMouseInsideRef.current = true;
    const rect = container.getBoundingClientRect();
    const mouseViewportX = e.clientX - rect.left;
    lastMouseViewportXRef.current = mouseViewportX;

    const edgeThreshold = Math.min(175, rect.width * 0.18);
    const maxSpeed = 8.5;

    if (mouseViewportX < edgeThreshold) {
      const intensity = Math.max(0, 1 - mouseViewportX / edgeThreshold);
      panVelocityRef.current = -intensity * maxSpeed;
      setPanDirection(-1);
    } else if (mouseViewportX > rect.width - edgeThreshold) {
      const distanceFromRight = rect.width - mouseViewportX;
      const intensity = Math.max(0, 1 - distanceFromRight / edgeThreshold);
      panVelocityRef.current = intensity * maxSpeed;
      setPanDirection(1);
    } else {
      panVelocityRef.current = 0;
      setPanDirection(0);
    }

    const trackMouseX = mouseViewportX + container.scrollLeft;
    const nearestIdx = Math.round((trackMouseX - PADDING_X) / STEP_SPACING);
    if (nearestIdx >= 0 && nearestIdx < TIMELINE_STEPS.length) {
      const nodeX = PADDING_X + nearestIdx * STEP_SPACING;
      if (Math.abs(trackMouseX - nodeX) < 75) {
        setHoveredIndex(nearestIdx);
      } else {
        setHoveredIndex(null);
      }
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    isMouseInsideRef.current = false;
    panVelocityRef.current = 0;
    setPanDirection(0);
    setHoveredIndex(null);
  }, []);

  return (
    <div className="w-full rounded-2xl bg-slate-900/60 backdrop-blur-xl border border-slate-800/90 shadow-2xl shadow-cyan-950/20 overflow-hidden select-none">
      {/* Minimal, Inviting Header */}
      <div className="px-6 sm:px-8 pt-6 pb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800/80">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-[11px] font-mono uppercase tracking-widest text-cyan-300 mb-2">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
            Interactive Flow
          </div>
          <h3 className="text-xl sm:text-2xl font-extrabold tracking-tight text-white">
            From Sketch to Discovery
          </h3>
          <p className="text-xs sm:text-sm text-slate-400 mt-0.5">
            Glide your cursor across the wave to experience the flow.
          </p>
        </div>

        <div className="text-right px-3.5 py-1.5 rounded-xl bg-slate-950/70 border border-slate-800 self-start sm:self-center">
          <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500 block">
            Stage
          </span>
          <span className="text-xs font-mono font-bold text-cyan-300">
            0{Math.max(1, activeNodeIndex + 1)} / 0{TIMELINE_STEPS.length}
          </span>
        </div>
      </div>

      {/* Scrollable Timeline Viewport */}
      <div className="relative">
        {/* Left Edge Fade */}
        <div
          className={`pointer-events-none absolute inset-y-0 left-0 w-24 bg-gradient-to-r from-slate-950/90 via-slate-900/50 to-transparent z-20 flex items-center justify-start pl-4 transition-opacity duration-300 ${
            panDirection === -1 ? "opacity-100" : "opacity-55"
          }`}
        >
          <div
            className={`w-8 h-8 rounded-full border bg-slate-900/90 backdrop-blur-md flex items-center justify-center text-xs transition-all duration-300 ${
              panDirection === -1
                ? "scale-110 border-cyan-400 text-cyan-300 shadow-lg shadow-cyan-500/30"
                : "border-slate-700 text-slate-400"
            }`}
          >
            ←
          </div>
        </div>

        {/* Right Edge Fade */}
        <div
          className={`pointer-events-none absolute inset-y-0 right-0 w-24 bg-gradient-to-l from-slate-950/90 via-slate-900/50 to-transparent z-20 flex items-center justify-end pr-4 transition-opacity duration-300 ${
            panDirection === 1 ? "opacity-100" : "opacity-55"
          }`}
        >
          <div
            className={`w-8 h-8 rounded-full border bg-slate-900/90 backdrop-blur-md flex items-center justify-center text-xs transition-all duration-300 ${
              panDirection === 1
                ? "scale-110 border-cyan-400 text-cyan-300 shadow-lg shadow-cyan-500/30"
                : "border-slate-700 text-slate-400"
            }`}
          >
            →
          </div>
        </div>

        {/* Horizontally Scrollable Track */}
        <div
          ref={scrollContainerRef}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          className="overflow-x-auto overflow-y-hidden cursor-crosshair [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div
            className="relative"
            style={{
              width: `${totalWidth}px`,
              height: `${TRACK_HEIGHT}px`,
            }}
          >
            {/* Subtle Molecular Grid Backdrop */}
            <div
              className="absolute inset-0 opacity-25 pointer-events-none"
              style={{
                backgroundImage:
                  "radial-gradient(rgba(56, 189, 248, 0.35) 1px, transparent 1px)",
                backgroundSize: "28px 28px",
              }}
            />

            {/* Deep Sinusoidal SVG Wavy Connecting Line Layer */}
            <svg
              width={totalWidth}
              height={TRACK_HEIGHT}
              viewBox={`0 0 ${totalWidth} ${TRACK_HEIGHT}`}
              className="absolute inset-0 pointer-events-none"
            >
              <defs>
                <linearGradient
                  id="chemai-wave-gradient"
                  x1="0%"
                  y1="0%"
                  x2="100%"
                  y2="0%"
                >
                  <stop offset="0%" stopColor="#22d3ee" />
                  <stop offset="50%" stopColor="#3b82f6" />
                  <stop offset="100%" stopColor="#a855f7" />
                </linearGradient>
                <filter
                  id="chemai-wave-glow"
                  x="-10%"
                  y="-30%"
                  width="120%"
                  height="160%"
                >
                  <feGaussianBlur stdDeviation="5" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>

              {/* Base Track */}
              <path
                d={wavyPathData}
                fill="none"
                stroke="rgba(51, 65, 85, 0.85)"
                strokeWidth="3.5"
                strokeLinecap="round"
              />

              {/* Cursor-Following Flowing Wave */}
              <path
                ref={activePathRef}
                d={wavyPathData}
                fill="none"
                stroke="url(#chemai-wave-gradient)"
                strokeWidth="4.5"
                strokeLinecap="round"
                filter="url(#chemai-wave-glow)"
              />

              {/* Leading Energy Orb */}
              <circle
                ref={pulseHaloRef}
                cx={PADDING_X}
                cy={CENTER_Y}
                r="13"
                fill="rgba(34, 211, 238, 0.25)"
              />
              <circle
                ref={pulseOrbRef}
                cx={PADDING_X}
                cy={CENTER_Y}
                r="5.5"
                fill="#ffffff"
                stroke="#22d3ee"
                strokeWidth="2.5"
                filter="url(#chemai-wave-glow)"
              />
            </svg>

            {/* Circular Nodes, Compact Tooltips, and Labels */}
            {TIMELINE_STEPS.map((step, index) => {
              const nodeX = PADDING_X + index * STEP_SPACING;
              const isCompleted = index <= activeNodeIndex;
              const isHovered = hoveredIndex === index;
              const IconComponent = step.icon;

              return (
                <div
                  key={step.id}
                  style={{
                    left: `${nodeX}px`,
                    top: `${CENTER_Y}px`,
                  }}
                  className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center z-10"
                >
                  {/* Compact, Minimal Floating Tooltip */}
                  <div
                    role="tooltip"
                    className={`pointer-events-none absolute bottom-full mb-7 w-52 rounded-2xl bg-slate-950/95 backdrop-blur-xl text-white p-3.5 shadow-2xl shadow-cyan-950/80 border border-cyan-500/35 transition-all duration-300 ease-out origin-bottom ${
                      isHovered
                        ? "opacity-100 translate-y-0 scale-100"
                        : "opacity-0 translate-y-3 scale-95"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 font-bold">
                        {step.number}
                      </span>
                      <span className="text-[11px] font-medium text-slate-300">
                        {step.role}
                      </span>
                    </div>
                    <p className="text-xs text-slate-300 leading-snug font-normal">
                      {step.description}
                    </p>

                    <div className="absolute left-1/2 -bottom-2 -translate-x-1/2 w-3.5 h-3.5 bg-slate-950 border-r border-b border-cyan-500/35 rotate-45" />
                  </div>

                  {/* Node Element */}
                  <div
                    onMouseEnter={() => setHoveredIndex(index)}
                    className="relative group"
                  >
                    {/* Semi-Transparent Glowing Halo */}
                    <span
                      className={`pointer-events-none absolute -inset-3.5 rounded-full bg-cyan-400/20 ring-1 ring-cyan-400/40 transition-all duration-300 ease-out ${
                        isHovered || index === activeNodeIndex
                          ? "opacity-100 scale-100"
                          : "opacity-0 scale-75"
                      }`}
                    />

                    {/* Main Circular Node */}
                    <div
                      className={`relative w-20 h-20 rounded-full flex flex-col items-center justify-center transition-all duration-300 ease-out border-2 ${
                        isCompleted
                          ? "bg-gradient-to-br from-cyan-500 via-blue-600 to-indigo-600 border-cyan-300/90 text-white shadow-[0_0_25px_rgba(34,211,238,0.45)]"
                          : "bg-slate-900/95 border-slate-700 text-slate-400"
                      }`}
                    >
                      <IconComponent
                        className={`w-6 h-6 mb-1 transition-transform duration-300 ${
                          isHovered || isCompleted ? "scale-110" : "scale-100"
                        } ${isCompleted ? "text-white" : "text-slate-400"}`}
                      />
                      <span
                        className={`text-[11px] font-mono font-bold tracking-widest transition-colors duration-300 ${
                          isCompleted ? "text-cyan-100" : "text-slate-500"
                        }`}
                      >
                        {step.number}
                      </span>
                    </div>
                  </div>

                  {/* Node Labels Below */}
                  <div className="absolute top-full mt-6 w-36 text-center pointer-events-none">
                    <h4
                      className={`text-sm font-bold tracking-tight transition-colors duration-300 ${
                        isCompleted ? "text-white" : "text-slate-400"
                      }`}
                    >
                      {step.title}
                    </h4>
                    <p
                      className={`text-xs font-medium mt-0.5 transition-colors duration-300 ${
                        isCompleted ? "text-cyan-400/90" : "text-slate-500"
                      }`}
                    >
                      {step.subtitle}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
