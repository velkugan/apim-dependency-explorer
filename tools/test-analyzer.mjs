/**
 * Runs the policy classifier outside Chrome.
 *
 *   npm install linkedom
 *   node tools/test-analyzer.mjs
 *
 * Chrome supplies DOMParser and Node natively; here linkedom stands in.
 */
import { DOMParser } from 'linkedom';
import { analyzePolicy, findExpressionRegions } from '../src/lib/policy-analyzer.js';

globalThis.DOMParser = DOMParser;
globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, CDATA_SECTION_NODE: 4 };

const known = new Set(['BackendUrl', 'ApiKey', 'Tenant.Id', 'kv-client-secret']);

const policy = `
<policies>
  <inbound>
    <base />
    <set-variable name="correlationId" value="@(context.RequestId.ToString())" />
    <set-variable name="tier" value="gold" />
    <set-backend-service backend-id="orders-backend" />
    <include-fragment fragment-id="common-auth" />
    <set-header name="x-key" exists-action="override">
      <value>{{ApiKey}}</value>
    </set-header>
    <set-header name="x-corr" exists-action="override">
      <value>@(context.Variables["correlationId"])</value>
    </set-header>
    <set-header name="x-tier" exists-action="override">
      <value>{{tier}}</value>
    </set-header>
    <set-header name="x-missing" exists-action="override">
      <value>{{NotDefinedAnywhere}}</value>
    </set-header>
    <validate-jwt header-name="Authorization">
      <openid-config url="https://login.microsoftonline.com/{{Tenant.Id}}/v2.0/.well-known/openid-configuration" />
    </validate-jwt>
    <rewrite-uri template="@{
      var payload = $"{{\\"id\\":\\"{context.RequestId}\\"}}";
      return "/v1" + context.Request.Url.Path;
    }" />
    <cache-lookup-value key="k" variable-name="cached" />
    <authentication-managed-identity resource="https://vault.azure.net" />
  </inbound>
  <backend>
    <forward-request timeout="30" />
  </backend>
  <outbound>
    <set-body template="liquid">
      { "customer": "{{ body.customer.name }}", "key": "{{ApiKey}}" }
    </set-body>
    <log-to-eventhub logger-id="audit-logger">@("done " + context.Variables.GetValueOrDefault&lt;string&gt;("tier"))</log-to-eventhub>
  </outbound>
  <on-error>
    <base />
  </on-error>
</policies>`;

const analysis = analyzePolicy(policy, { knownNamedValues: known, scope: 'test', label: 'test' });

const names = (map) => [...map.keys()].sort();
const results = {
  namedValues: names(analysis.namedValues),
  unresolved: names(analysis.unresolvedNamedValues),
  variableLookalikes: names(analysis.variableLookalikes),
  liquid: names(analysis.liquidTokens),
  ambiguous: names(analysis.ambiguousTokens),
  variablesWritten: names(analysis.variablesWritten),
  variablesRead: names(analysis.variablesRead),
  backends: names(analysis.backends),
  fragments: names(analysis.fragments),
  loggers: names(analysis.loggers),
  identities: names(analysis.identities),
  urls: names(analysis.urls),
  caches: names(analysis.caches),
  sections: Object.fromEntries(
    Object.entries(analysis.sections).map(([k, v]) => [k, v.hasBase])
  )
};

console.log(JSON.stringify(results, null, 2));

const expectations = [
  ['ApiKey is a named value', results.namedValues.includes('ApiKey')],
  ['Tenant.Id is a named value', results.namedValues.includes('Tenant.Id')],
  ['tier is flagged as a variable lookalike', results.variableLookalikes.includes('tier')],
  ['tier is NOT a named value', !results.namedValues.includes('tier')],
  ['NotDefinedAnywhere is unresolved', results.unresolved.includes('NotDefinedAnywhere')],
  ['liquid moustache is not a named value', !results.namedValues.includes('body.customer.name')],
  ['liquid moustache captured as liquid', results.liquid.some((t) => t.includes('body.customer.name'))],
  ['a real named value inside liquid is still a named value', results.namedValues.includes('ApiKey')],
  ['ApiKey is not double-counted as liquid', !results.liquid.includes('ApiKey')],
  ['brace escaping did not become a named value', !results.namedValues.some((n) => n.includes('id'))],
  ['correlationId read detected', results.variablesRead.includes('correlationId')],
  ['tier read via GetValueOrDefault detected', results.variablesRead.includes('tier')],
  ['cached variable written', results.variablesWritten.includes('cached')],
  ['backend detected', results.backends.includes('orders-backend')],
  ['fragment detected', results.fragments.includes('common-auth')],
  ['logger detected', results.loggers.includes('audit-logger')],
  ['inbound base detected', analysis.sections.inbound?.hasBase === true]
];

let failed = 0;
for (const [label, pass] of expectations) {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
}

console.log(`\nexpression regions found: ${findExpressionRegions('@(a) plain @{ "{" } tail').length}`);
process.exit(failed ? 1 : 0);
