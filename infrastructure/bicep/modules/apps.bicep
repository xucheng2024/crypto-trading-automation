param location string
param environmentName string
param infrastructureSubnetId string
param image string
param registryServer string
param logAnalyticsCustomerId string
@secure()
param logAnalyticsSharedKey string
@secure()
param applicationInsightsConnectionString string
param workloadProfileType string
param acrId string
param keyVaultId string
param keyVaultUri string
param enginePostgresUrl string
param maintenancePostgresUrl string
param okxAccountId string
param okxInstruments string
param managedFillStartMs string
param strategyConfigJson string
param tags object

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    vnetConfiguration: { infrastructureSubnetId: infrastructureSubnetId }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logAnalyticsCustomerId, sharedKey: logAnalyticsSharedKey }
    }
    workloadProfiles: [{ name: workloadProfileType, workloadProfileType: workloadProfileType }]
  }
  tags: tags
}
resource engine 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${environmentName}-engine'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    managedEnvironmentId: env.id
    workloadProfileName: workloadProfileType
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{ server: registryServer, identity: 'system' }]
      ingress: { external: false, targetPort: 8080 }
    }
    template: {
      scale: { minReplicas: 1, maxReplicas: 1 }
      containers: [
        {
          name: 'trading-engine'
          image: image
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'TRADING_MODE', value: 'OFF' }
            { name: 'KEY_VAULT_URI', value: keyVaultUri }
            { name: 'POSTGRES_URL', value: enginePostgresUrl }
            { name: 'OKX_ACCOUNT_ID', value: okxAccountId }
            { name: 'OKX_INSTRUMENTS', value: okxInstruments }
            { name: 'MANAGED_FILL_START_MS', value: managedFillStartMs }
            { name: 'STRATEGY_CONFIG_JSON', value: strategyConfigJson }
            { name: 'PORT', value: '8080' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: applicationInsightsConnectionString }
            { name: 'DEPLOYMENT_ENVIRONMENT', value: 'p5' }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/health/live', port: 8080 }, initialDelaySeconds: 10 }
            { type: 'Readiness', httpGet: { path: '/health/ready', port: 8080 }, initialDelaySeconds: 10 }
          ]
        }
      ]
    }
  }
  tags: tags
}
resource maintenance 'Microsoft.App/jobs@2024-03-01' = {
  name: '${environmentName}-maintenance'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    environmentId: env.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 1800
      scheduleTriggerConfig: { cronExpression: '5 0 * * *', parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: registryServer, identity: 'system' }]
    }
    template: {
      containers: [
        {
          name: 'maintenance'
          image: image
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          command: ['node', 'scripts/run-maintenance.mjs']
          env: [
            { name: 'TRADING_MODE', value: 'OFF' }
            { name: 'POSTGRES_URL', value: maintenancePostgresUrl }
            { name: 'MAINTENANCE_ADAPTER_MODULE', value: 'file:///app/src/entrypoints/azure/maintenance-adapter.js' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: applicationInsightsConnectionString }
            { name: 'DEPLOYMENT_ENVIRONMENT', value: 'p5' }
          ]
        }
      ]
    }
  }
  tags: tags
}

// AcrPull, maintenance deliberately receives no Key Vault role.
var acrPullRole = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var keyVaultSecretsUserRole = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)
var monitoringReaderRole = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '43d0d8ad-25c7-4b0b-bb1b-2d04b1817e7d'
)
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: last(split(acrId, '/'))
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: last(split(keyVaultId, '/'))
}
resource engineAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acrId, engine.id, acrPullRole)
  scope: acr
  properties: {
    principalId: engine.identity.principalId
    roleDefinitionId: acrPullRole
    principalType: 'ServicePrincipal'
  }
}
resource maintenanceAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acrId, maintenance.id, acrPullRole)
  scope: acr
  properties: {
    principalId: maintenance.identity.principalId
    roleDefinitionId: acrPullRole
    principalType: 'ServicePrincipal'
  }
}
resource engineVaultRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVaultId, engine.id, keyVaultSecretsUserRole)
  scope: vault
  properties: {
    principalId: engine.identity.principalId
    roleDefinitionId: keyVaultSecretsUserRole
    principalType: 'ServicePrincipal'
  }
}
resource maintenanceMonitoringReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(env.id, maintenance.id, monitoringReaderRole)
  scope: env
  properties: {
    principalId: maintenance.identity.principalId
    roleDefinitionId: monitoringReaderRole
    principalType: 'ServicePrincipal'
  }
}
output engineId string = engine.id
output jobId string = maintenance.id
output enginePrincipalId string = engine.identity.principalId
output maintenancePrincipalId string = maintenance.identity.principalId
output enginePrincipalName string = engine.name
output maintenancePrincipalName string = maintenance.name
