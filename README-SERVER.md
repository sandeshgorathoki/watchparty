Signaling server (Socket.IO)

This project includes a minimal signaling server at `server.js` for local testing. Notes for GitHub and deployment:

- The frontend can be hosted as a static site (Vite build / GitHub Pages).
- The signaling server must run on a separate Node host (e.g., a small VPS, Heroku, Render, Railway).
- Set the environment variable `VITE_SIGNALING_SERVER` in your deployed frontend to the server URL, e.g. `https://my-signaling.example.com`.

Local dev:

1. Install dependencies:

```bash
npm install
```

2. Start the signaling server (runs on port 3001):

```bash
npm run start:server
```

3. Start the frontend dev server:

```bash
npm run dev
```

When pushing to GitHub: commit the `server.js` file if you want to keep it in the repo, but remember GitHub Pages won't run it. Deploy the server to a separate host and set `VITE_SIGNALING_SERVER` in your frontend environment (or replace the URL in `src/App.jsx`).
