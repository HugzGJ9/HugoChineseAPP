// Microsoft sign-in settings. The client id is not a secret: any web app's id is public (see the plan's P0 steps).

/**
 * The Application (client) ID of the "Hugo Chinese" app registration. Empty → the Microsoft UI stays hidden and the
 * diagnostics say "not configured".
 * VITE_MS_CLIENT_ID, when set (even to ''), replaces it: unit tests use it so they never depend on the committed id
 * ('' = not configured). The deployed build and the e2e build leave it unset and use the real id.
 */
const CLIENT_ID = '9e9c8192-b2fe-44d1-b246-9e39471e12f6';

const ENV_ID = import.meta.env.VITE_MS_CLIENT_ID as string | undefined;
export const MS_CLIENT_ID: string = typeof ENV_ID === 'string' ? ENV_ID : CLIENT_ID;

/** Personal Microsoft accounts only (D8). A work account would use `organizations` (D12). */
export const MS_AUTHORITY = 'https://login.microsoftonline.com/consumers';

/** Whole OneDrive access (Q4 default). */
export const MS_SCOPES: string[] = ['openid', 'profile', 'offline_access', 'User.Read', 'Files.ReadWrite'];

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** True when a client id has been filled in (a GUID; the all-zero GUID counts as a placeholder). */
export function clientIdValid(id: string = MS_CLIENT_ID): boolean {
  const s = id.trim();
  if (!s || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(s)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || /^[\w.-]{3,64}$/.test(s);
}
