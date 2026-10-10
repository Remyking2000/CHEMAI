import React from "react";

/**
 * Icon 1: Brand Logo & Favicon Component
 * Combines an Erlenmeyer chemistry flask, an aromatic benzene hexagon,
 * an electron orbital ellipse, and AI neural circuit pathways.
 */
export function ChemAILogoIcon({ className = "w-9 h-9" }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="chemaiLogoBg" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#0f172a" />
          <stop offset="50%" stopColor="#1e1b4b" />
          <stop offset="100%" stopColor="#090d16" />
        </linearGradient>
        <linearGradient id="chemaiLogoStroke" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="50%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
        <linearGradient id="chemaiNodeGlow" x1="16" y1="16" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#22d3ee" />
        </linearGradient>
      </defs>

      {/* Squircle Emblem Base */}
      <rect
        x="2"
        y="2"
        width="60"
        height="60"
        rx="16"
        fill="url(#chemaiLogoBg)"
        stroke="url(#chemaiLogoStroke)"
        strokeWidth="2.5"
      />

      {/* Tilted Electron Orbital */}
      <ellipse
        cx="32"
        cy="34"
        rx="23"
        ry="9"
        transform="rotate(-28 32 34)"
        stroke="url(#chemaiLogoStroke)"
        strokeWidth="1.5"
        strokeOpacity="0.45"
        strokeDasharray="3 2"
      />

      {/* Erlenmeyer Flask Silhouette */}
      <path
        d="M26 11H38M29 11V19L15 43C13.5 45.6 15.4 49 18.5 49H45.5C48.6 49 50.5 45.6 49 43L35 19V11"
        stroke="url(#chemaiLogoStroke)"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Inner Benzene Ring */}
      <polygon
        points="32,24 41,29.2 41,39.6 32,44.8 23,39.6 23,29.2"
        fill="#0f172a"
        fillOpacity="0.88"
        stroke="url(#chemaiNodeGlow)"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />

      {/* AI Neural Circuit Connections */}
      <line x1="32" y1="34.4" x2="32" y2="24" stroke="#22d3ee" strokeWidth="1.6" />
      <line x1="32" y1="34.4" x2="41" y2="29.2" stroke="#38bdf8" strokeWidth="1.6" />
      <line x1="32" y1="34.4" x2="41" y2="39.6" stroke="#818cf8" strokeWidth="1.6" />
      <line x1="32" y1="34.4" x2="23" y2="39.6" stroke="#34d399" strokeWidth="1.6" />
      <line x1="32" y1="34.4" x2="23" y2="29.2" stroke="#22d3ee" strokeWidth="1.6" />

      {/* Central AI Nucleus */}
      <circle cx="32" cy="34.4" r="4" fill="url(#chemaiNodeGlow)" />
      <circle cx="32" cy="34.4" r="1.8" fill="#0f172a" />

      {/* Molecular / Neural Vertex Nodes */}
      <circle cx="32" cy="24" r="2.3" fill="#22d3ee" />
      <circle cx="41" cy="29.2" r="2.3" fill="#38bdf8" />
      <circle cx="41" cy="39.6" r="2.3" fill="#818cf8" />
      <circle cx="32" cy="44.8" r="2.3" fill="#a78bfa" />
      <circle cx="23" cy="39.6" r="2.3" fill="#34d399" />
      <circle cx="23" cy="29.2" r="2.3" fill="#22d3ee" />
    </svg>
  );
}

/**
 * Icon 2: AI + Chemistry Molecular Neural Hex Icon
 * Replaces all generic star/sparkle icons across the application.
 * Combines a conjugated benzene ring on the left with AI neural circuit synapses on the right.
 */
export function ChemAINeuralHexIcon({ className = "w-5 h-5" }) {
  return (
    <svg
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Benzene Hexagon Core */}
      <polygon
        points="12,4.5 19.5,8.8 19.5,17.4 12,21.7 4.5,17.4 4.5,8.8"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />

      {/* Inner Aromatic Double-Bond Arc / Delocalized Ring */}
      <path
        d="M8 10.6V15.6M12 7.6L16.2 10.1M12 18.6L16.2 16.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeOpacity="0.75"
      />

      {/* Central AI Node inside Ring */}
      <circle cx="12" cy="13.1" r="2" fill="currentColor" />

      {/* Neural Circuit Branches Extending Rightward */}
      <path
        d="M19.5 8.8L23.5 6.2M19.5 17.4L23.5 20M19.5 13.1H24.2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />

      {/* Covalent & Neural Terminal Nodes */}
      <circle cx="12" cy="4.5" r="1.6" fill="currentColor" />
      <circle cx="4.5" cy="8.8" r="1.6" fill="currentColor" />
      <circle cx="4.5" cy="17.4" r="1.6" fill="currentColor" />
      <circle cx="12" cy="21.7" r="1.6" fill="currentColor" />
      <circle cx="24.2" cy="5.8" r="1.9" fill="currentColor" />
      <circle cx="24.8" cy="13.1" r="1.9" fill="currentColor" />
      <circle cx="24.2" cy="20.4" r="1.9" fill="currentColor" />
    </svg>
  );
}
