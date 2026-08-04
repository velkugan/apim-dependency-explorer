# APIM Dependency Explorer

A Chrome side panel that lists the APIs in an Azure API Management instance and, on
expand, resolves what each one actually depends on: backends, products, policy
fragments, named values, certificates, loggers and the Key Vault secrets behind them.

Nothing loads until you expand an API. Service-wide lookup tables (named values,
backends, fragments, certificates, loggers) load once on the first expand and are
reused for every API after that.

## Install

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Click the toolbar icon to open the side panel.

Requires Chrome 116+ (side panel API). Works in Edge 116+ too.

## Getting a token

The extension talks to `https://management.azure.com`, so it needs an ARM access
token — audience `https://management.azure.com/`. Three ways to get one:

- **Copy from the portal.** Open the Azure portal, DevTools → Network, filter on
  `management.azure.com`, open any request, copy the `Authorization` header value
  minus the leading `Bearer `. Paste it in the panel.
- **Capture automatically.** Tick "Capture token from Azure portal traffic", then
  reload any portal page. The service worker reads the `Authorization` header off
  ARM requests and offers it in the panel. The token is stored in
  `chrome.storage.session` (memory only, cleared when Chrome closes) and is only
  ever sent back to `management.azure.com`.
- **Azure CLI.** `az account get-access-token --resource https://management.azure.com --query accessToken -o tsv`

Portal tokens usually last 60–90 minutes. The panel decodes the JWT locally and
shows a countdown so you know when to refresh.

## Permissions and why

| Permission | Reason |
| --- | --- |
| `sidePanel` | The UI itself |
| `storage` | Settings in local storage, token in session storage |
| `webRequest` | Optional token capture from ARM traffic (observe only — MV3 has no blocking webRequest) |
| `host_permissions: management.azure.com` | The only host the extension calls |

Extension pages get the declared host permissions, so ARM calls are made directly
from the panel without CORS problems.

## Telling named values apart from variables

This is the part that goes wrong in naive tooling. Four different things use
similar-looking syntax in a policy document:

| In the policy | What it is |
| --- | --- |
| `{{MyNamedValue}}` | A named value |
| `{{ order.customer.name }}` inside `<set-body template="liquid">` | A Liquid variable |
| `@{ return $"{{\"id\":\"{x}\"}}"; }` | C# brace escaping in an interpolated string |
| `context.Variables["x"]`, `<set-variable name="x">` | A policy variable |

`src/lib/policy-analyzer.js` walks the parsed XML rather than regexing the raw text,
and applies these rules in order:

1. Text inside a Liquid-templated `set-body` is walked as Liquid — except where the
   moustache exactly matches a real named value, because APIM substitutes named
   values before Liquid renders. That case is reported as a named value with a note,
   since the Liquid variable of that name would be clobbered at runtime.
2. Expression bodies (`@{...}`, `@(...)`) are located with a brace/paren-balanced
   scan that skips string literals, so JSON inside an expression cannot terminate a
   region early. A moustache found inside an expression must match a real named value
   on the instance, otherwise it is listed under **Excluded moustaches** rather than
   counted as a dependency.
3. Outside expressions, a moustache containing whitespace, a pipe or brackets is
   Liquid-ish syntax, not a named value name.
4. A moustache whose name matches a variable declared by `<set-variable>` and is not
   a named value is flagged as a **variable lookalike** — `{{ }}` never resolves
   variables in APIM, so that reference is a live bug in the policy.
5. Anything else shaped like a named value but not defined on the instance is
   reported under **Broken links** as unresolved.

Variables are collected separately (written via `set-variable` and the
`*-variable-name` attributes, read via `context.Variables[...]`,
`GetValueOrDefault`, `ContainsKey`, `TryGetValue`) and never merged into the named
value list.

Run the classifier outside Chrome:

```bash
npm install linkedom
node tools/test-analyzer.mjs
```

## What gets resolved per API

- API policy, plus every operation policy (toggleable), product policies, and
  policy fragments resolved recursively with cycle detection
- Global policy, included only when a `<base />` is present
- Backends from `set-backend-service` and AI-gateway `backend-id` attributes, plus
  the backend matched by the API's own `serviceUrl`
- Named values, including ones referenced indirectly through backend credentials
- Key Vault secrets behind named values and certificates, with the identity used and
  the last refresh status
- Certificates, loggers and API diagnostics, OAuth servers and OpenID providers,
  version set, caches, managed identity resources, and outbound URLs

The coloured bar on each collapsed row is a fingerprint: one segment per dependency
class, sized by count, with a red marker when something is broken.

## Files

```
manifest.json
src/background.js            service worker: side panel behaviour + token capture
src/sidepanel.html/.css/.js  UI
src/lib/util.js              helpers, JWT decode, concurrency pool
src/lib/arm.js               ARM client: paging, 429 retry, caching
src/lib/apim.js              APIM endpoints, resource-ID parsing, service discovery
src/lib/policy-analyzer.js   the named value / variable / Liquid classifier
src/lib/resolver.js          catalog load + per-API dependency resolution
tools/test-analyzer.mjs      classifier tests, runnable in Node
```

## Known limits

- Operation policies are one request each. An API with 200 operations means 200
  calls; the pool caps concurrency at 5 and backs off on 429. Turn the toggle off
  for a fast first pass.
- Only the current revision returned by the APIM list call is read.
- `{{...}}` inside a named value's own value is not followed transitively.
- The default ARM API version is `2022-08-01`; policy fragments need
  `2021-12-01-preview` or later, so leave it at the default or newer.
