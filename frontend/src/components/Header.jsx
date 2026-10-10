import React from "react";
import { Link, useLocation } from "react-router-dom";
import { ChemAILogoIcon } from "./ChemAIIcons";

function Header() {
  const location = useLocation();
  const isHome = location.pathname === "/";
  const isEditor = location.pathname === "/editor";

  return (
    <header
      className={`sticky top-0 z-40 transition-colors duration-300 ${
        isHome
          ? "bg-slate-950/80 backdrop-blur-md border-b border-cyan-500/20 text-white"
          : "bg-white/95 backdrop-blur-md border-b border-gray-200 text-gray-900 shadow-2xs"
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between gap-4">
        {/* Brand Logo with Custom ChemAI Flask + Neural Benzene Emblem */}
        <Link to="/" className="flex items-center gap-3 group select-none">
          <div className="relative flex items-center justify-center group-hover:scale-105 transition-transform">
            <ChemAILogoIcon className="w-11 h-11 drop-shadow-md" />
            <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-slate-950"></span>
          </div>

          <div className="text-left">
            <div className="flex items-center gap-2">
              <span
                className={`text-2xl font-extrabold tracking-tight ${
                  isHome ? "text-white" : "text-gray-900"
                }`}
              >
                Chem
                <span className="bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">
                  AI
                </span>
              </span>
              <span
                className={`hidden sm:inline-block text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full border ${
                  isHome
                    ? "bg-cyan-500/10 text-cyan-300 border-cyan-500/30"
                    : "bg-blue-50 text-blue-700 border-blue-200"
                }`}
              >
                Lab Suite
              </span>
            </div>
            <p
              className={`text-xs ${
                isHome ? "text-slate-400" : "text-gray-500"
              }`}
            >
              Your Smart Chemistry Assistant
            </p>
          </div>
        </Link>

        {/* Navigation Links */}
        <nav className="flex items-center gap-2 sm:gap-3">
          <Link
            to="/"
            className={`px-3.5 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
              isHome
                ? "bg-white/10 text-cyan-300 border border-cyan-400/30"
                : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
            }`}
          >
            Home
          </Link>
          <Link
            to="/editor"
            className={`px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-all flex items-center gap-1.5 ${
              isEditor
                ? "bg-indigo-600 text-white shadow-xs"
                : "bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white shadow-md shadow-cyan-500/25 hover:scale-[1.02]"
            }`}
          >
            <span>🧪</span>
            <span>{isEditor ? "Workspace Active" : "Open Editor"}</span>
          </Link>
        </nav>
      </div>
    </header>
  );
}

export default Header;