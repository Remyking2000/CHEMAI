import { Link } from "react-router-dom";

function Header() {
  return (
    <header className="bg-white shadow-md py-6 text-center">
      <Link to="/" className="block cursor-pointer select-none">
        <h1 className="text-3xl font-bold text-blue-600">
          Chem<span className="text-cyan-600">AI</span>
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          Your Smart Chemistry Assistant
        </p>
      </Link>
    </header>
  );
}

export default Header;