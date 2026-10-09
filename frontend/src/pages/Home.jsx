import React from "react";
import { Link } from "react-router-dom";

const Home = () => {
  return (
    <div className="p-6 text-center">
      <h1 className="text-2xl font-bold">Welcome to ChemAI</h1>
      <p className="mt-4">Click below to open the molecule editor.</p>
      <Link
        to="/editor"
        className="mt-4 inline-block bg-blue-600 text-white px-4 py-2 rounded"
      >
        Open Editor
      </Link>
    </div>
  );
};

export default Home;
