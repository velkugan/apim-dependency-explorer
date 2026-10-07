/**
 * "Troubleshoot" feature: recent Application Insights logs (requests, traces,
 * exceptions) for a logger already resolved on an API, without leaving the
 * side panel.
 *
 * IMPORTANT — this needs a SECOND, DIFFERENT bearer token than the rest of
 * the extension.
 *
 * Every other call here goes to management.azure.com using an ARM-audience
 * token (aud=https://management.azure.com/). Application Insights telemetry
 * is not reachable through ARM at all — there is no ARM proxy for querying a
 * Microsoft.Insights/components resource's own logs (that action only exists
 * for resources that *send* diagnostic logs to a separate workspace). The
 * only way to query it is the dedicated data-plane API, which requires a
 * token whose audience is specifically https://api.applicationinsights.io:
 *
 *   GET/POST https://api.applicationinsights.io/v1/apps/{appId}/query
 *
 * https://learn.microsoft.com/azure/azure-monitor/app/app-insights-azure-ad-api
 *
 * So this module needs two things the ARM token can't provide on its own:
 *   1. The Application Insights "AppId" (not the ARM resource name) — fetched
 *      with the existing ARM token, since Components - Get is a normal ARM
 *      call.
 *   2. A bearer token whose audience is https://api.applicationinsights.io.
 *      The panel gets this the same way it gets the ARM token: captured
 *      passively from portal traffic, or pasted in (e.g. from
 *      `az account get-access-token --resource https://api.applicationinsights.io`).
 */

export const COMPONENT_API_VERSION = '2015-05-01';
export const LOGS_AUDIENCE = 'https://api.applicationinsights.io';

/** How far back to look, as options offered in the panel. Minutes. */
export const LOOKBACK_OPTIONS = [15, 30, 60, 240, 1440];

/** ISO8601 duration for the last N minutes, e.g. 30 -> "PT30M". */
export function lastMinutes(minutes) {
  const m = Math.max(1, Math.floor(Number(minutes)) || 30);
  return `PT${m}M`;
}

/** Escapes text for embedding inside a single-quoted KQL string literal. */
function escapeKql(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Recent requests + traces + exceptions, optionally narrowed to a free-text
 * filter (API display name, operation name, a word from a message, etc).
 * Columns are aligned across the three tables so they can render in one grid.
 */
export function buildTroubleshootQuery({ filterText = '', take = 100 } = {}) {
  const needle = escapeKql(String(filterText || '').trim());
  const filterClause = needle
    ? `| where tostring(customDimensions) has '${needle}' or operation_Name has '${needle}' ` +
      `or message has '${needle}' or name has '${needle}'`
    : '';
  const limit = Math.max(1, Math.min(500, Math.floor(Number(take)) || 100));

  return [
    'union isfuzzy=true',
    "  (requests | extend kind='request', message=name, level=''),",
    "  (traces | extend kind='trace', level=tostring(severityLevel)),",
    "  (exceptions | extend kind='exception', message=strcat(type, ': ', outerMessage), level='')",
    filterClause,
    '| project timestamp, kind, message, level, operation_Name, resultCode, success, duration',
    '| order by timestamp desc',
    `| take ${limit}`
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Application Insights "AppId" (the query API's app identifier) is not the
 * ARM resource name — it's a GUID on the component's properties. Read with
 * the normal ARM client/token, since Components - Get is an ordinary ARM
 * call, same audience as everything else in the panel.
 */
export async function getAppInsightsAppId(client, resourceId) {
  const res = await client.request(resourceId, {
    apiVersion: COMPONENT_API_VERSION,
    tolerate404: false
  });
  const appId = res?.properties?.AppId;
  if (!appId) throw new Error('Could not read an AppId from this Application Insights resource.');
  return appId;
}

export class LogsAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LogsAuthError';
  }
}

/**
 * Runs a KQL query against the Application Insights Query API directly.
 * This is a separate fetch, not the ArmClient, because it needs a token for
 * a different audience than every other call in the extension.
 *
 * @param token Bearer token with aud=https://api.applicationinsights.io
 * @param appId From getAppInsightsAppId(), not the ARM resource name
 */
export async function queryAppInsightsLogs(token, appId, { query, minutes = 30 } = {}) {
  if (!token) throw new LogsAuthError('No Application Insights token yet — see below.');

  const url = new URL(`${LOGS_AUDIENCE}/v1/apps/${encodeURIComponent(appId)}/query`);
  url.searchParams.set('timespan', lastMinutes(minutes));

  let res;
  try {
    res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ query })
    });
  } catch (err) {
    throw new Error(`Network error calling Application Insights: ${err.message}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new LogsAuthError(
      `Application Insights rejected the token (${res.status}). It has expired, is for the ` +
        'wrong audience, or the signed-in identity lacks read access to this resource.'
    );
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }

  if (!res.ok) {
    const message = json?.error?.message || text?.slice(0, 300) || res.statusText;
    throw new Error(message);
  }

  const table = json?.tables?.[0];
  if (!table) return { columns: [], rows: [] };
  return {
    columns: (table.columns || []).map((c) => c.name),
    rows: table.rows || []
  };
}

/** Deep link to the same resource's Logs blade in the portal, for "open and dig further". */
export function portalLogsUrl(resourceId) {
  return `https://portal.azure.com/#@/resource${resourceId}/logs`;
}
