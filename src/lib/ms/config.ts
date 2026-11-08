// Microsoft sign-in settings. The client id is not a secret: any web app's id is public (see the plan's P0 steps).

/**
 * The Application (client) ID of the "Hugo Chinese" app registration. Empty until Hugo registers the app: the Microsoft
 * UI then stays hidden and the diagnostics say "not configured". Paste the id between the quotes.
 * A build can also set it through VITE_MS_CLIENT_ID (the e2e fake uses this; the deployed build doesn't need it).
 */
const CLIENT_ID = '';

export const MS_CLIENT_ID: string = CLIENT_ID || ((import.meta.env.VITE_MS_CLIENT_ID as string | undefined) ?? '');

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
