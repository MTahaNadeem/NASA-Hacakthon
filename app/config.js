/* Deployment settings. Safe to publish: this file must NEVER hold a secret.
 *
 * backendUrl: address of the NASA data backend (see backend/README.md), e.g. "https://agrishift-api.onrender.com".
 *             Leave empty to run without it: the app then uses the direct NASA POWER / SoilGrids calls it always had.
 * NASA Earthdata logins and tokens belong ONLY in the backend's environment variables, never here. */
window.AGRISHIFT = { backendUrl: "https://agrishift-api.onrender.com" };
