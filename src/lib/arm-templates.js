/**
 * ARM template generation.
 *
 * One template per resource, deployable against an existing API Management
 * instance from an Azure DevOps ARM template deployment task. Source values are
 * carried through verbatim: environment-specific values are expected to be
 * edited before the target deployment, and keeping them makes the diff between
 * environments obvious rather than hiding it behind placeholders.
 *
 * The one exception is a secret named value, whose value APIM does not return
 * on a normal read. Those emit a placeholder unless the value was explicitly
 * revealed.
 */

const SCHEMA = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#';

export const SECRET_PLACEHOLDER = '__REPLACE_WITH_SECRET__';
export const SERVICE_PARAM = 'ApimServiceName';

/** ARM child resource names are "service/child" and must be built with concat. */
const childName = (child) => `[concat(parameters('${SERVICE_PARAM}'), '/${child}')]`;

/** Safe for a filename on Windows and Linux, and stable across runs. */
export function safeFileName(name) {
  return String(name)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function template(resources, extraParams = {}) {
  return {
    $schema: SCHEMA,
    contentVersion: '1.0.0.0',
    parameters: {
      [SERVICE_PARAM]: {
        type: 'string',
        metadata: { description: 'Name of the target API Management instance.' }
      },
      ...extraParams
    },
    resources
  };
}

/**
 * @param {object} nv  a named value as returned by the report payload or ARM
 * @param {object} options
 * @param {string} options.apiVersion
 * @param {string|null} options.revealedValue  value fetched via listValue, if any
 */
export function buildNamedValueTemplate(nv, options = {}) {
  const apiVersion = options.apiVersion || '2022-08-01';
  const props = nv.properties || nv;
  const displayName = props.displayName || nv.token || nv.name;
  const resourceName = nv.name || nv.id || safeFileName(displayName);

  const properties = {
    displayName,
    tags: props.tags || nv.tags || []
  };

  const keyVault = props.keyVault || nv.keyVault;
  if (keyVault?.secretIdentifier) {
    properties.keyVault = { secretIdentifier: keyVault.secretIdentifier };
    if (keyVault.identityClientId) {
      properties.keyVault.identityClientId = keyVault.identityClientId;
    }
    properties.secret = true;
  } else if (props.secret || nv.secret) {
    properties.secret = true;
    properties.value = options.revealedValue ?? SECRET_PLACEHOLDER;
  } else {
    properties.secret = false;
    properties.value = props.value ?? nv.value ?? '';
  }

  return template([
    {
      type: 'Microsoft.ApiManagement/service/namedValues',
      apiVersion,
      name: childName(resourceName),
      properties
    }
  ]);
}

export function buildBackendTemplate(backend, options = {}) {
  const apiVersion = options.apiVersion || '2022-08-01';
  const props = backend.properties || backend;
  const resourceName = backend.name || backend.id;

  const properties = {
    // A backend must carry a url and protocol; the rest are emitted only when
    // the source defines them, so the template stays close to the original.
    url: props.url || '',
    protocol: props.protocol || 'http'
  };
  if (props.title) properties.title = props.title;
  if (props.description) properties.description = props.description;
  if (props.resourceId) properties.resourceId = props.resourceId;
  if (props.credentials) properties.credentials = props.credentials;
  if (props.tls) properties.tls = props.tls;
  if (props.proxy) properties.proxy = props.proxy;
  if (props.pool) properties.pool = props.pool;
  if (props.circuitBreaker) properties.circuitBreaker = props.circuitBreaker;

  return template([
    {
      type: 'Microsoft.ApiManagement/service/backends',
      apiVersion,
      name: childName(resourceName),
      properties
    }
  ]);
}

export function buildFragmentTemplate(fragment, xml, options = {}) {
  const apiVersion = options.apiVersion || '2022-08-01';
  const resourceName = fragment.name || fragment.id;
  return template([
    {
      type: 'Microsoft.ApiManagement/service/policyFragments',
      apiVersion,
      name: childName(resourceName),
      properties: {
        description: fragment.description || fragment.properties?.description || '',
        format: 'rawxml',
        value: xml || ''
      }
    }
  ]);
}

/**
 * An Azure DevOps parameters file, so the same template can be deployed to any
 * instance without editing the template itself.
 */
export function buildParametersFile(serviceName) {
  return {
    $schema:
      'https://schema.management.azure.com/schemas/2015-01-01/deploymentParameters.json#',
    contentVersion: '1.0.0.0',
    parameters: {
      [SERVICE_PARAM]: { value: serviceName || '' }
    }
  };
}

/** A ready-to-paste pipeline stage that deploys every template in the folder. */
export function buildPipelineSnippet(folder = 'apim-templates') {
  return `# Deploys every template produced by APIM Dependency Explorer.
# Each file is an independent ARM deployment against an existing APIM instance.
parameters:
  - name: apimServiceName
    type: string
  - name: azureSubscription
    type: string
  - name: resourceGroup
    type: string

steps:
  - task: AzureCLI@2
    displayName: Deploy APIM dependencies
    inputs:
      azureSubscription: \${{ parameters.azureSubscription }}
      scriptType: bash
      scriptLocation: inlineScript
      inlineScript: |
        set -euo pipefail
        shopt -s nullglob
        for template in $(BUILD_SOURCESDIRECTORY)/${folder}/*/*.json; do
          case "$template" in *.parameters.json) continue;; esac
          echo "Deploying $template"
          az deployment group create \\
            --resource-group \${{ parameters.resourceGroup }} \\
            --template-file "$template" \\
            --parameters ${SERVICE_PARAM}=\${{ parameters.apimServiceName }} \\
            --name "apim-$(basename "\${template%.json}")-$(date +%s)"
        done
`;
}

const README = (context) => `# APIM dependency templates

Generated by APIM Dependency Explorer on ${new Date().toISOString()}.

Source instance: ${context.source || 'unknown'}
Target instance: ${context.target || 'not set'}
API: ${context.api || 'n/a'}

## Layout

    namedValues/   one ARM template per named value
    backends/      one ARM template per backend
    fragments/     one ARM template per policy fragment
    azure-pipelines-snippet.yml
    parameters.json

Each template takes a single \`${SERVICE_PARAM}\` parameter and deploys one child
resource against an API Management instance that already exists.

## Before deploying

Values are copied from the source instance as-is. Review each file and set the
values that differ per environment — URLs, hostnames, environment names, Key
Vault URIs.

Secret named values are emitted as \`${SECRET_PLACEHOLDER}\`, because API
Management does not return secret values on a read. Set them from your secret
store or a pipeline variable rather than committing them.

## Deploying one file

    az deployment group create \\
      --resource-group <rg> \\
      --template-file namedValues/<file>.json \\
      --parameters ${SERVICE_PARAM}=<apim-name>
`;

/**
 * Assembles the full file set. Callers pass already-fetched resources so this
 * stays synchronous and testable.
 *
 * @returns {Array<{name: string, text: string}>}
 */
export function buildTemplateBundle({
  namedValues = [],
  backends = [],
  fragments = [],
  apiVersion = '2022-08-01',
  context = {}
} = {}) {
  const files = [];
  const json = (value) => JSON.stringify(value, null, 2) + '\n';

  for (const nv of namedValues) {
    const name = nv.name || nv.id || nv.token;
    files.push({
      name: `namedValues/${safeFileName(name)}.json`,
      text: json(buildNamedValueTemplate(nv, { apiVersion, revealedValue: nv.revealedValue }))
    });
  }

  for (const backend of backends) {
    const name = backend.name || backend.id;
    files.push({
      name: `backends/${safeFileName(name)}.json`,
      text: json(buildBackendTemplate(backend, { apiVersion }))
    });
  }

  for (const fragment of fragments) {
    const name = fragment.name || fragment.id;
    files.push({
      name: `fragments/${safeFileName(name)}.json`,
      text: json(buildFragmentTemplate(fragment, fragment.xml, { apiVersion }))
    });
  }

  if (!files.length) return files;

  files.push({ name: 'parameters.json', text: json(buildParametersFile(context.target)) });
  files.push({ name: 'azure-pipelines-snippet.yml', text: buildPipelineSnippet() });
  files.push({ name: 'README.md', text: README(context) });
  return files;
}
