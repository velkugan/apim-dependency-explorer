/**
 * Azure API Management control-plane calls.
 * Docs: https://learn.microsoft.com/rest/api/apimanagement/
 */

export const DEFAULT_API_VERSION = '2022-08-01';

export const API_VERSIONS = [
  '2024-05-01',
  '2023-05-01-preview',
  '2022-08-01',
  '2021-08-01'
];

const SERVICE_ID_RE =
  /\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ApiManagement\/service\/([^/?#]+)/i;

/**
 * Accepts a full resource ID, a portal URL, or "subscriptionId/resourceGroup/serviceName".
 */
export function parseServiceRef(input) {
  if (!input) return null;
  const text = decodeURIComponent(String(input).trim());

  const match = text.match(SERVICE_ID_RE);
  if (match) {
    return { subscriptionId: match[1], resourceGroup: match[2], serviceName: match[3] };
  }

  const parts = text.split('/').filter(Boolean);
  if (parts.length === 3) {
    return { subscriptionId: parts[0], resourceGroup: parts[1], serviceName: parts[2] };
  }
  return null;
}

export class ApimService {
  constructor(client, ref, apiVersion = DEFAULT_API_VERSION) {
    this.client = client;
    this.ref = ref;
    this.apiVersion = apiVersion;
  }

  get base() {
    const { subscriptionId, resourceGroup, serviceName } = this.ref;
    return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
      `/providers/Microsoft.ApiManagement/service/${serviceName}`;
  }

  get label() {
    return this.ref.serviceName;
  }

  _get(path, params) {
    return this.client.request(this.base + path, { apiVersion: this.apiVersion, params });
  }

  _list(path, params) {
    return this.client.list(this.base + path, { apiVersion: this.apiVersion, params });
  }

  /**
   * Policy GETs return null when no policy is defined at that scope.
   *
   * format=xml, not rawxml. rawxml returns the policy exactly as authored, and
   * APIM permits raw <, > and && inside expression attributes, which is not
   * well-formed XML and fails every parser. format=xml escapes them.
   */
  async _policy(path) {
    const res = await this.client.request(this.base + path, {
      apiVersion: this.apiVersion,
      params: { format: 'xml' }
    });
    return res?.properties?.value ?? null;
  }

  getService() {
    return this._get('');
  }

  listApis() {
    return this._list('/apis', { $top: 500 });
  }

  getGlobalPolicy() {
    return this._policy('/policies/policy');
  }

  getApiPolicy(apiId) {
    return this._policy(`/apis/${encodeURIComponent(apiId)}/policies/policy`);
  }

  listOperations(apiId) {
    return this._list(`/apis/${encodeURIComponent(apiId)}/operations`, { $top: 500 });
  }

  getOperationPolicy(apiId, operationId) {
    return this._policy(
      `/apis/${encodeURIComponent(apiId)}/operations/${encodeURIComponent(operationId)}/policies/policy`
    );
  }

  /** Single API, or null when it does not exist. Used by the target compare. */
  getApi(apiId) {
    return this._get(`/apis/${encodeURIComponent(apiId)}`);
  }

  listProducts() {
    return this._list('/products', { $top: 500 });
  }

  listApiProducts(apiId) {
    return this._list(`/apis/${encodeURIComponent(apiId)}/products`);
  }

  getProductPolicy(productId) {
    return this._policy(`/products/${encodeURIComponent(productId)}/policies/policy`);
  }

  listApiDiagnostics(apiId) {
    return this._list(`/apis/${encodeURIComponent(apiId)}/diagnostics`);
  }

  listApiSchemas(apiId) {
    return this._list(`/apis/${encodeURIComponent(apiId)}/schemas`);
  }

  listNamedValues() {
    return this._list('/namedValues', { $top: 500 });
  }

  /** Named values marked secret hide their value; this reveals it on demand. */
  async revealNamedValue(namedValueId) {
    const res = await this.client.request(
      `${this.base}/namedValues/${encodeURIComponent(namedValueId)}/listValue`,
      { apiVersion: this.apiVersion, method: 'POST', cache: false, tolerate404: false }
    );
    return res?.value ?? null;
  }

  listBackends() {
    return this._list('/backends', { $top: 500 });
  }

  listPolicyFragments() {
    return this._list('/policyFragments', { $top: 500 });
  }

  /** Full fragment resource, or null when it genuinely does not exist. */
  getPolicyFragment(fragmentId) {
    return this.client.request(
      `${this.base}/policyFragments/${encodeURIComponent(fragmentId)}`,
      { apiVersion: this.apiVersion, params: { format: 'xml' } }
    );
  }

  async getFragmentPolicy(fragmentId) {
    const res = await this.getPolicyFragment(fragmentId);
    return res?.properties?.value ?? null;
  }

  // Direct lookups used to confirm a reference before calling it broken. ARM
  // resource names are case-insensitive, so these succeed where a case-sensitive
  // match against the list response fails.
  getBackend(backendId) {
    return this._get(`/backends/${encodeURIComponent(backendId)}`);
  }

  getNamedValue(namedValueId) {
    return this._get(`/namedValues/${encodeURIComponent(namedValueId)}`);
  }

  getCertificate(certificateId) {
    return this._get(`/certificates/${encodeURIComponent(certificateId)}`);
  }

  listCertificates() {
    return this._list('/certificates');
  }

  listLoggers() {
    return this._list('/loggers');
  }

  listAuthorizationServers() {
    return this._list('/authorizationServers');
  }

  listOpenIdConnectProviders() {
    return this._list('/openidConnectProviders');
  }

  listApiVersionSets() {
    return this._list('/apiVersionSets');
  }

  listCaches() {
    return this._list('/caches');
  }
}

/** Lists every APIM instance the token can see. Used by the "Find services" button. */
export async function discoverServices(client, apiVersion = DEFAULT_API_VERSION) {
  const subs = await client.list('/subscriptions', { apiVersion: '2022-12-01' });
  const results = [];
  await Promise.all(
    subs.map(async (sub) => {
      try {
        const services = await client.list(
          `/subscriptions/${sub.subscriptionId}/providers/Microsoft.ApiManagement/service`,
          { apiVersion }
        );
        for (const svc of services) {
          const ref = parseServiceRef(svc.id);
          if (ref) {
            results.push({
              ...ref,
              id: svc.id,
              location: svc.location,
              sku: svc.sku?.name,
              subscriptionName: sub.displayName
            });
          }
        }
      } catch {
        /* subscription not readable — skip */
      }
    })
  );
  return results.sort((a, b) => a.serviceName.localeCompare(b.serviceName));
}
