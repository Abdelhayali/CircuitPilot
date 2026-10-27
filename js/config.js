// Web version settings. `relay` is the address of the CircuitPilot relay (relay/worker.js, a free Cloudflare Worker)
// used for part search, web search and Ollama Cloud when the app runs without server.py (GitHub Pages).
// Users can override it in ⚙ Settings → Relay.
window.CP_CONFIG = {
  relay: 'https://circuitpilot-relay.circuitpilot.workers.dev',
  // Google sign-in (projects in the user's own Google Drive): the OAuth "Web application" client ID from Google Cloud
  // Console, with the authorized JavaScript origins https://pcbgo.site and http://localhost:5173. Not a secret.
  googleClientId: '773131004199-8ajg71r8fuv8l0463qmajip7o8bjeqjp.apps.googleusercontent.com',
};
