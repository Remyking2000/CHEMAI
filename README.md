# ChemAI 🧪✨

> **ChemAI** is a smart chemistry web application that allows users to analyze chemical compounds, inspect molecular properties (formula, molecular weight, SMILES, PubChem CID), and interact with chemical structure visualization tools.

---

## 📁 Project Structure

This project follows a clean decoupled full-stack architecture with dedicated **frontend** and **backend** workspaces:

```text
chemAI/
├── frontend/                     # React + Vite frontend application
│   ├── public/                   # Static public assets
│   ├── src/
│   │   ├── components/           # Reusable UI components (Header, etc.)
│   │   ├── pages/                # Application views (Home, Editor / Analyzer)
│   │   ├── App.jsx               # Route configuration
│   │   ├── index.css             # Tailwind CSS styles
│   │   └── main.jsx              # Application entry point
│   ├── index.html                # HTML entry template
│   ├── vite.config.js            # Vite configuration with Tailwind & Ketcher proxy
│   ├── eslint.config.js          # ESLint rules
│   └── package.json              # Frontend scripts and dependencies
│
├── backend/                      # Node.js + Express REST API
│   ├── cache/                    # Local response and image cache
│   │   ├── pubchem_images/       # Cached 2D structure images
│   │   └── pubchem_json/         # Cached PubChem JSON property responses
│   ├── ocl/                      # OpenChemLib standalone scripts and styles
│   ├── server.js                 # Express server & PubChem API integration
│   ├── .env.example              # Environment variables template
│   └── package.json              # Backend scripts and dependencies
│
├── .gitignore                    # Git rules for secrets, builds, and node_modules
├── package.json                  # Root orchestration scripts
└── README.md                     # Project documentation
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher

---

### 1. Install Dependencies

You can install all dependencies from the root directory with a single command:

```bash
npm run install:all
```

Alternatively, you can install them separately:

```bash
# Frontend
cd frontend
npm install

# Backend
cd ../backend
npm install
```

---

### 2. Environment Configuration

Create a `.env` file in the `backend/` directory by copying the example:

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` if you have custom API keys:

```env
CHEM_API_KEY=your_key_here
```

---

### 3. Running the Application

You can launch both services using root scripts or from their respective folders:

#### Root scripts:

| Command | Action | URL |
| :--- | :--- | :--- |
| `npm run dev:frontend` | Starts Vite development server | `http://localhost:5173` |
| `npm run dev:backend` | Starts Express API in watch mode | `http://localhost:5000` |
| `npm run start:backend`| Starts Express API in standard mode | `http://localhost:5000` |
| `npm run build:frontend` | Compiles frontend for production | Outputs to `frontend/dist` |

#### Or run independently:

```bash
# Terminal 1 - Frontend
cd frontend
npm run dev

# Terminal 2 - Backend
cd backend
npm run dev
```

---

## 🛠️ Tech Stack

### Frontend
- **Framework**: [React 18](https://react.dev/) + [Vite](https://vitejs.dev/)
- **Routing**: [React Router DOM v7](https://reactrouter.com/)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/)
- **Chemistry**: Ketcher React & OpenChemLib

### Backend
- **Runtime**: [Node.js](https://nodejs.org/) (ES Modules)
- **Framework**: [Express 5](https://expressjs.com/)
- **HTTP Client**: [Axios](https://axios-http.com/)
- **Data Source**: [PubChem REST API](https://pubchem.ncbi.nlm.nih.gov/)
- **Utilities**: CORS, Dotenv, File caching
