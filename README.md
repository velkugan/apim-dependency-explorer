# APIM Dependency Explorer

A Chrome side panel that answers three questions Azure API Management cannot answer on
its own:

1. **What does this API actually depend on?** Backends, products, policy fragments,
   named values, certificates, loggers, Key Vault secrets — resolved from the API
   policy, every operation policy, every product policy, every fragment (recursively),
   and the global policy when `<base />` is present.
2. **What is missing in my target environment?** Compare against another instance for
   missing, broken, unlinked and drifted dependencies, plus operation-level and
   API-settings diffs.
3. **What do I have to create to close the gap?** One ARM template per missing resource,
   downloaded as a zip, deployable from Azure DevOps.

Nothing loads until you expand an API. Service-wide lookup tables load once on the first
expand and are reused for every API after that.

## Install

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Click the toolbar icon to open the side panel.

Requires Chrome 116+ (side panel API). Works in Edge 116+ too. After a `manifest.json`
change, reload the extension; host permission changes may require re-enabling it.

## Getting a token

The extension talks to `https://management.azure.com`, so it needs an ARM access token —
audience `https://management.azure.com/`. Three ways to get one:

- **Copy from the portal.** Azure portal → DevTools → Network, filter on
  `management.azure.com`, open any request, copy the `Authorization` header value minus
  the leading `Bearer `. Paste it in the panel.
- **Capture automatically.** Tick "Capture token from Azure portal traffic", then reload
  any portal tab. The service worker reads the `Authorization` header off ARM requests
  and offers it in the panel. A status line reports which state you are in: capture off /
  no ARM traffic seen / traffic seen without an `Authorization` header / captured N
  seconds ago.
- **Azure CLI.**
  `az account get-access-token --resource https://management.azure.com --query accessToken -o tsv`

Portal tokens usually last 60–90 minutes. The panel decodes the JWT locally and shows the
audience and a countdown, so a wrong-audience or expired token is obvious before it
produces a confusing 401.

## Finding the instance

The instance field fills itself. The panel reads the resource ID from the active portal
tab's URL, and the service worker also reads it from ARM request paths while capture is
on — so refreshing the portal for a token fills the field as a side effect. If the field
already holds something different it is left alone and a **use it** link is offered
instead. **Find services** lists every APIM instance the token can see.

## Permissions and why

| Permission | Reason |
| --- | --- |
| `sidePanel` | The UI itself |
| `storage` | Settings in local storage; token and report payloads in session storage |
| `webRequest` | Optional token capture from ARM *and* Application Insights traffic (observe only) |
| `host_permissions: management.azure.com` | ARM — APIM, catalog, and the Application Insights AppId lookup |
| `host_permissions: api.applicationinsights.io` | The Troubleshoot feature's actual log query, a separate token audience from ARM |
| `host_permissions: portal.azure.*` | Required for the initiator check on captured requests, and to read the active tab's URL without the broad `tabs` permission |

Read-only: the extension issues no ARM writes. The token lives in
`chrome.storage.session` (memory only, cleared when Chrome closes) and is sent nowhere
except `management.azure.com`. There is no server component.

## Telling named values apart from variables

This is the part naive tooling gets wrong. Four different things use similar syntax:

| In the policy | What it is |
| --- | --- |
| `{{MyNamedValue}}` | A named value |
| `{{ order.customer.name }}` inside `<set-body template="liquid">` | A Liquid variable |
| `@{ return $"{{\"id\":\"{x}\"}}"; }` | C# brace escaping in an interpolated string |
| `context.Variables["x"]`, `<set-variable name="x">` | A policy variable |

`src/lib/policy-analyzer.js` walks the parsed XML rather than regexing raw text, applying
these rules in order:

1. Text inside a Liquid-templated `set-body` is walked as Liquid — except where the
   moustache exactly matches a real named value, because APIM substitutes named values
   before Liquid renders. Policy expression syntax inside a Liquid body
   (`{{context.Variables[...]}}`) is flagged specifically: Liquid cannot read context, so
   that token is emitted literally rather than evaluated. This is usually a bug.
2. Expression bodies (`@{...}`, `@(...)`) are found with a brace/paren-balanced scan that
   skips string literals, so JSON inside an expression cannot end a region early. A
   moustache inside an expression must match a real named value, or it is listed under
   **Excluded moustaches** rather than counted as a dependency.
3. Outside expressions, a moustache containing whitespace, a pipe or brackets is
   Liquid-ish syntax, not a named value name.
4. A moustache matching a variable declared by `<set-variable>` and not a named value is
   flagged as a **variable lookalike** — `{{ }}` never resolves variables, so that
   reference is a live bug.
5. Anything else shaped like a named value but not defined is reported as unresolved.

Variables are collected separately (written via `set-variable` and `*-variable-name`
attributes; read via `context.Variables[...]`, `GetValueOrDefault`, `ContainsKey`,
`TryGetValue`) and never merged into the named value list.

Run the classifier outside Chrome:

```bash
npm install linkedom
node tools/test-analyzer.mjs
```

## Resolution details worth knowing

- **Policies are fetched as `format=xml`, not `rawxml`.** APIM permits raw `<`, `>` and
  `&&` inside expression attributes, which is not well-formed XML; `rawxml` returns it
  verbatim and every parser fails. A repair pass (escaping bare `&` and `<`/`>` inside
  attribute values) and a degraded text scan back this up, so a malformed policy still
  yields dependencies instead of an error block.
- **Lookups are case-insensitive.** ARM resource names are, so a policy referencing
  `Common-Auth` against a resource named `common-auth` resolves and is annotated rather
  than reported missing.
- **Nothing is called missing without a direct GET.** If a reference is absent from the
  list response, the resolver confirms with a single memoised lookup before flagging it,
  covering stale or filtered list responses.
- **Dynamic backend ids are expanded.** A `backend-id` built at runtime —
  `@("wem-" + context.Variables["site"])`, `{{prefix}}-{{suffix}}`, a dictionary lookup,
  or a name assembled in an earlier `set-variable` — is recognised as dynamic. Every
  piece of literal evidence (expression string literals, literal runs in the id, the
  `set-variable` that built the name, named value values) is matched against the
  catalog and the union is kept; evidence matching nothing contributes nothing, so the
  catalog itself decides what was a real clue. Short clues require a name-segment
  boundary so `WA` does not match `urm-gateway`. When every `{{token}}` resolves, the id
  is substituted whole and looked up exactly. When nothing resolves it, the route is
  flagged **dynamic · review** rather than passing silently, and the target comparison
  reports it as needing a manual check.

## Comparing against a target environment

Tick **Compare against a target instance** and paste the target resource ID, or use
**Find target**. One ARM token usually reaches both instances when they share a tenant.

The target is indexed once (a single pass of list calls) and reused for every API, so
comparing forty APIs costs about what one costs. Gaps are grouped by severity:

- **Missing in target** — blocks deployment
- **Present but broken** — Key Vault refresh not `Success`, certificates expiring within 30 days
- **Present but not linked to this API** — the product exists but the API is not attached
- **Matched after name normalisation** — `dev-orders-backend` → `prod-orders-backend`
- **Present with differences** — differing backend URLs and named value values, and the
  inverse case where a URL is *identical* across environments, which usually means the
  target still points at the source's host

The **environment tokens** box holds a regex of naming fragments to ignore when matching
(`dev/test/qa/uat/stg/prod` by default). Clear it to force exact matching.

Also compared: **operations**, two ways — missing in target, only in target, and same id
with a different method or URL template (which deploys cleanly and routes wrong) — and
**API settings** (`path`, `serviceUrl`, `protocols`, `subscriptionRequired`,
`apiVersion`, `apiRevision`), with `serviceUrl` and `apiRevision` labelled as expected to
differ per environment.

If a target list call fails, those checks are skipped and reported as skipped, never as
false gaps.

## Reverse lookup

Everything else here is lazy: expand one API and it resolves that one. Reverse lookup
cannot work that way, so it is the one deliberately expensive operation.

**Build index** under the API list sweeps every API and inverts the result into a
dependency-to-APIs index. The sweep is paced by a token bucket matching ARM's own
throttling model (bucket 250, refill 25/sec for subscription reads) and deliberately
spends only a fraction of it, because it runs under your own identity and would
otherwise throttle your portal session. It reads
`x-ms-ratelimit-remaining-subscription-reads` off each response, can be stopped and
resumed, survives a token expiring mid-sweep, and persists with its age shown.

**Reverse lookup** then opens the report window on an index of backends, named values,
fragments, products, certificates, Key Vault secrets and loggers. Each entry lists the
APIs using it, split into direct and indirect:

    logstash-url — 3 APIs · 1 direct · 2 via fragment or product

A dynamic backend counts every candidate it could select at runtime. A **Needs
attention** panel lists expiring certificates and failing Key Vault refreshes with the
APIs affected.

## The report window

**Report** in the toolbar, or **Open report** on an expanded API, opens a detached window
sized to your display. It opens on the API you were looking at; the picker lists all
resolved APIs alphabetically. Three views, cycled with one button:

- **Cards** — categories packed into columns, long lists capped with a "Show all" toggle,
  one filter box searching every category at once. Print-friendly.
- **Tree** — each policy document as a branch holding only what it references directly,
  so you can see which fragment brought a named value in. Nested fragments expand in
  place with cycle guards. With a target configured every node carries its target
  verdict, and the worst status rolls up the branch: a fragment that is itself fine but
  contains a missing named value shows a muted roll-up badge and auto-expands, so you
  can see *where in the dependency chain* a gap lives before expanding anything. **Only
  gaps** prunes every clean subtree.
- **Explorer** — selectable tree on the left, detail on the right. With a target set, the
  detail splits Source | Target.

### Code-level diffs

In Explorer, selecting an API, operation, product or fragment fetches both policies and
diffs them line by line, unchanged runs collapsed, with a `+2 / −1` or `identical`
verdict. Both sides are normalised first (reparsed, re-indented, attributes sorted) so
attribute ordering and whitespace do not swamp the real change; a **raw view** toggle
turns normalisation off.

Backends, named values and certificates get a field comparison instead of a text diff.
Secret named values show `••••••` on both sides and are explicitly not compared.

Target policies are fetched only for the node you select, then cached per side, kind and
id. A slow response cannot overwrite a newer selection.

## Generating ARM templates

With a target configured, **Generate templates** emits one ARM template per resource the
target is missing, downloaded as a zip:

```
namedValues/logstash-url.json
backends/MSATS.json
fragments/CheckInboundPayloadSize.json
parameters.json
azure-pipelines-snippet.yml
README.md
```

Each file is a standard `deploymentTemplate.json#` document containing one child resource
and taking a single `ApimServiceName` parameter, so it deploys against an existing
instance with the AzureRM template deployment task or `az deployment group create`. The
included pipeline snippet loops the folder and deploys each file.

Definitions are read fresh from the source instance rather than from the report payload,
so backends carry their full `credentials`, `tls`, `proxy` and `circuitBreaker` blocks.
Dynamic backends expand to their individual candidates.

**Source values are kept verbatim**, so the generated file matches the shape you already
review and edit for the target. The one exception is a secret named value: API Management
does not return secret values on a read, so those emit `__REPLACE_WITH_SECRET__` and must
be set from your secret store or a pipeline variable.

## Exports

- **Copy list** — flat plain text, one dependency per line, with `[MISSING]`,
  `[DYNAMIC -> …]` and `[key vault vault/secret]` markers
- **Copy JSON** — structured, including `targetGaps` when a comparison has run
- **Copy gaps** — the gap report on its own
- **copy** on any group or card header — just that category's names
- **Print** — drops the chrome and nav, two columns, cards kept whole across pages

## Files

```
manifest.json
src/background.js            service worker: side panel behaviour, token and instance capture
src/sidepanel.html/.css/.js  the panel
src/report.html/.css/.js     detached report window: cards, tree and explorer views
src/lib/util.js              helpers, JWT decode, concurrency pool
src/lib/arm.js               ARM client: paging, 429 retry, caching
src/lib/apim.js              APIM endpoints, resource-ID parsing, service discovery
src/lib/policy-analyzer.js   the named value / variable / Liquid classifier
src/lib/resolver.js          catalog load, per-API resolution, scope graph
src/lib/appinsights.js       Troubleshoot: recent App Insights logs via the ARM proxy
src/lib/sweep.js             instance-wide sweep and reverse dependency index
src/lib/compare.js           target indexing and gap comparison
src/lib/diff.js              XML normalisation and line diff
src/lib/arm-templates.js     ARM template generation
src/lib/zip.js               minimal store-only ZIP writer
tools/test-analyzer.mjs      classifier tests, runnable in Node
```

## Troubleshoot (Application Insights logs)

Any API diagnostic backed by an `applicationInsights` logger shows a
**troubleshoot** link next to it, in both the side panel and the report.
Clicking it opens a panel with recent `requests`/`traces`/`exceptions` for
that Application Insights resource — a lookback window (15m–24h), a free-text
filter (defaults to the API's display name), and an "Open in portal" link for
anything that needs the full Logs experience.

Querying Application Insights needs a **second bearer token**, separate from
the ARM token used for everything else. There is no way around this: ARM has
no proxy for querying a Microsoft.Insights/components resource's own logs (it
only exists for resources that *send* diagnostic logs elsewhere), so the
actual data lives behind the dedicated Query API, which requires a token
whose audience is specifically `https://api.applicationinsights.io`:

```
POST https://api.applicationinsights.io/v1/apps/{appId}/query
```

The panel gets that token the same three ways it gets the ARM one:

- **Capture it.** With "Capture token from Azure portal traffic" ticked, if
  you open the resource's own **Logs** blade in the Azure portal at least
  once during the session, the extension picks up that request's token the
  same way it picks up ARM tokens. (This needs the
  `https://api.applicationinsights.io/*` host permission added in this
  version — reload the unpacked extension once after updating.)
- **Paste it.** The troubleshoot panel shows a paste box whenever it doesn't
  have a working token, same idea as the main "Bearer token" field.
- **Azure CLI:**
  `az account get-access-token --resource https://api.applicationinsights.io --query accessToken -o tsv`

The `AppId` used in the query URL (not the ARM resource name) is read
automatically with the normal ARM token via a plain `Components - Get` call.
A 401/403 from the query itself means the Application Insights token is
wrong/expired/wrong-audience, not an APIM permission issue — the panel shows
the paste box again in that case. See `src/lib/appinsights.js` for the full
explanation and both calls.

## Known limits

- Operation policies are one request each. An API with 200 operations means 200 calls;
  concurrency is capped at 5 with 429 backoff. Turn the toggle off for a fast first pass —
  the operation *list* is still fetched, so the target comparison stays complete.
- Only the current revision returned by the APIM list call is read.
- `{{...}}` inside a named value's own value is not followed transitively.
- Report payloads live in session storage, so a report window reopened after a browser
  restart reports as expired rather than showing stale data.
- The default ARM API version is `2022-08-01`; policy fragments need `2021-12-01-preview`
  or later, so leave it at the default or newer.
- The reverse-lookup index is a point-in-time sweep. Nothing invalidates it
  automatically — APIM offers no cheap "what changed since" across APIs — so its age is
  shown and rebuilding is manual.

## Not yet built

Discussed and deliberately deferred: orphan detection (`findOrphans` exists in
`sweep.js` but has no UI yet), a configurable rule engine for naming standards and
mandatory fragments / rate limiting, pushing generated ARM templates straight to a
DevOps repo, and a headless CI gate reusing `policy-analyzer.js` and `resolver.js`.
