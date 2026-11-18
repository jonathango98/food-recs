// Where the frontend finds the API. When the static guide is hosted on Netlify
// (for the domain), it calls the Railway backend for live data. Served from
// Railway itself, this same absolute URL is just same-origin — also fine.
// On localhost, use the local server (npm run dev) so local changes show up.
window.API_BASE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? "http://localhost:3000"
  : "https://web-production-0d735.up.railway.app";
