targetScope = 'resourceGroup'

param location string = 'eastasia'
@minLength(3)
param prefix string
param imageDigest string
param runnerImageDigest string
param githubRepository string
@secure()
param postgresPassword string
param sshPublicKey string
param adminUsername string = 'observer'
param tags object = { purpose: 'strategy-observation' }

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' existing = { name: '${prefix}-vnet' }
resource nat 'Microsoft.Network/natGateways@2023-11-01' existing = { name: '${prefix}-nat' }
resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = { name: '${prefix}-law' }
resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' existing = { name: '${prefix}-ops' }
resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = { name: '${prefix}acr' }
resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: '${prefix}-cae-acr-pull' }

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: '${prefix}-observe-nsg'
  location: location
  tags: tags
  properties: {
    securityRules: [
      { name: 'status-http', properties: { priority: 100, protocol: 'Tcp', access: 'Allow', direction: 'Inbound', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: '8080' } }
      { name: 'market-api', properties: { priority: 105, protocol: 'Tcp', access: 'Allow', direction: 'Inbound', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: '8081' } }
      { name: 'deny-ssh', properties: { priority: 110, protocol: '*', access: 'Deny', direction: 'Inbound', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: '22' } }
    ]
  }
}
resource subnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' = {
  parent: vnet
  name: 'observation'
  properties: { addressPrefix: '10.42.1.0/27', natGateway: { id: nat.id }, networkSecurityGroup: { id: nsg.id } }
}
resource publicIp 'Microsoft.Network/publicIPAddresses@2023-11-01' = {
  name: '${prefix}-observe-pip'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
    dnsSettings: { domainNameLabel: '${prefix}-observe-${uniqueString(resourceGroup().id)}' }
  }
}
var frontendId = resourceId('Microsoft.Network/loadBalancers/frontendIPConfigurations', '${prefix}-observe-lb', 'status')
var backendId = resourceId('Microsoft.Network/loadBalancers/backendAddressPools', '${prefix}-observe-lb', 'observer')
var probeId = resourceId('Microsoft.Network/loadBalancers/probes', '${prefix}-observe-lb', 'live')
resource balancer 'Microsoft.Network/loadBalancers@2023-11-01' = {
  name: '${prefix}-observe-lb'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    frontendIPConfigurations: [{ name: 'status', properties: { publicIPAddress: { id: publicIp.id } } }]
    backendAddressPools: [{ name: 'observer' }]
    probes: [{ name: 'live', properties: { protocol: 'Http', port: 8080, requestPath: '/health/live', intervalInSeconds: 15, numberOfProbes: 2 } }]
    loadBalancingRules: [{ name: 'status-http', properties: { frontendIPConfiguration: { id: frontendId }, backendAddressPool: { id: backendId }, probe: { id: probeId }, protocol: 'Tcp', frontendPort: 80, backendPort: 8080, disableOutboundSnat: true, enableFloatingIP: false, idleTimeoutInMinutes: 4 } }]
  }
}
resource nic 'Microsoft.Network/networkInterfaces@2023-11-01' = {
  name: '${prefix}-observe-nic'
  location: location
  tags: tags
  properties: { ipConfigurations: [{ name: 'private', properties: { subnet: { id: subnet.id }, privateIPAllocationMethod: 'Dynamic', loadBalancerBackendAddressPools: [{ id: backendId }, { id: apiBackendId }] } }] }
  dependsOn: [balancer, apiBalancer]
}
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-observe-pg'
  location: location
  tags: tags
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: 'observeradmin'
    administratorLoginPassword: postgresPassword
    authConfig: { activeDirectoryAuth: 'Disabled', passwordAuth: 'Enabled' }
    storage: { storageSizeGB: 128, autoGrow: 'Disabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
  }
}
resource firewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'nat-egress-only'
  properties: { startIpAddress: natIp.properties.ipAddress, endIpAddress: natIp.properties.ipAddress }
}
resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'observation'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}
resource natIp 'Microsoft.Network/publicIPAddresses@2023-11-01' existing = { name: '${prefix}-nat-pip' }
resource apiIp 'Microsoft.Network/publicIPAddresses@2023-11-01' = {
  name: '${prefix}-observe-api-pip'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
    dnsSettings: { domainNameLabel: '${prefix}-observe-api-${uniqueString(resourceGroup().id)}' }
  }
}
var apiFrontendId = resourceId('Microsoft.Network/loadBalancers/frontendIPConfigurations', '${prefix}-observe-api-lb', 'api')
var apiBackendId = resourceId('Microsoft.Network/loadBalancers/backendAddressPools', '${prefix}-observe-api-lb', 'observer')
var apiProbeId = resourceId('Microsoft.Network/loadBalancers/probes', '${prefix}-observe-api-lb', 'live')
resource apiBalancer 'Microsoft.Network/loadBalancers@2023-11-01' = {
  name: '${prefix}-observe-api-lb'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    frontendIPConfigurations: [{ name: 'api', properties: { publicIPAddress: { id: apiIp.id } } }]
    backendAddressPools: [{ name: 'observer' }]
    probes: [{ name: 'live', properties: { protocol: 'Http', port: 8081, requestPath: '/health/live', intervalInSeconds: 15, numberOfProbes: 2 } }]
    loadBalancingRules: [{ name: 'market-api', properties: { frontendIPConfiguration: { id: apiFrontendId }, backendAddressPool: { id: apiBackendId }, probe: { id: apiProbeId }, protocol: 'Tcp', frontendPort: 80, backendPort: 8081, disableOutboundSnat: true, enableFloatingIP: false, idleTimeoutInMinutes: 4 } }]
  }
}
var runtimeConfig = {
  image: imageDigest
  registry: registry.properties.loginServer
  runnerImage: runnerImageDigest
  githubRepository: githubRepository
  clientId: pullIdentity.properties.clientId
  tenantId: tenant().tenantId
  env: {
    ORDER_EXECUTION_ENABLED: 'false'
    OBSERVATION_POSTGRES_HOST: postgres.properties.fullyQualifiedDomainName
    MARKET_API_URL: 'http://${apiIp.properties.dnsSettings.fqdn}'
  }
}
var cloudInit = loadTextContent('../observation/cloud-init.yml')
resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: '${prefix}-observe-vm'
  location: location
  tags: union(tags, { runnerImage: runnerImageDigest })
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${pullIdentity.id}': {} } }
  properties: {
    hardwareProfile: { vmSize: 'Standard_B2ls_v2' }
    storageProfile: {
      imageReference: { publisher: 'Canonical', offer: 'ubuntu-24_04-lts', sku: 'server', version: 'latest' }
      osDisk: { createOption: 'FromImage', diskSizeGB: 32, managedDisk: { storageAccountType: 'StandardSSD_LRS' } }
    }
    osProfile: {
      computerName: '${prefix}-observe'
      adminUsername: adminUsername
      customData: base64(cloudInit)
      linuxConfiguration: { disablePasswordAuthentication: true, ssh: { publicKeys: [{ path: '/home/${adminUsername}/.ssh/authorized_keys', keyData: sshPublicKey }] } }
    }
    networkProfile: { networkInterfaces: [{ id: nic.id }] }
    diagnosticsProfile: { bootDiagnostics: { enabled: true } }
    securityProfile: { securityType: 'TrustedLaunch', uefiSettings: { secureBootEnabled: true, vTpmEnabled: true } }
  }
}

// Eleven one-minute health rules cost $33/month (at least $1.064/day in a 31-day month).
var observationAlerts = [
  { name: 'heartbeat', expression: '' }
  { name: 'market-stale', expression: 'tolong(Properties.market_age_ms) > 120000' }
  { name: 'symbols-missing', expression: 'toint(Properties.market_missing_symbols) > 0' }
  { name: 'payload-invalid', expression: 'toint(Properties.invalid_rows) > 0' }
  { name: 'database-unavailable', expression: 'toint(Properties.database_ok) == 0' }
  { name: 'database-latency', expression: 'tolong(Properties.database_latency_ms) > 2000' }
  { name: 'market-api-errors', expression: 'toint(Properties.api_read_errors) > 0' }
  { name: 'cpu-high', expression: 'todouble(Properties.cpu_load_pct) > 80' }
  { name: 'memory-high', expression: 'todouble(Properties.memory_used_pct) > 85' }
  { name: 'disk-high', expression: 'todouble(Properties.disk_used_pct) > 85' }
  { name: 'retention-errors', expression: 'toint(Properties.retention_errors) > 0' }
]
var traceQuery = 'AppTraces | where tostring(Properties.environment) == "milestone-observation" | where Message == "metric_snapshot RUNTIME_METRICS"'
resource alerts 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = [for alert in observationAlerts: {
  name: '${prefix}-observe-${alert.name}'
  location: location
  tags: tags
  properties: {
    enabled: true
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    scopes: [workspace.id]
    severity: 1
    criteria: { allOf: [{ query: alert.name == 'heartbeat' ? '${traceQuery} | summarize heartbeats=count() | where heartbeats == 0' : '${traceQuery} | where ${alert.expression}', timeAggregation: 'Count', operator: 'GreaterThan', threshold: 0, failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 } }] }
    actions: { actionGroups: [actionGroup.id] }
  }
}]

output vmName string = vm.name
output statusUrl string = 'http://${publicIp.properties.dnsSettings.fqdn}/'
output bootstrapConfig object = runtimeConfig

output postgresHost string = postgres.properties.fullyQualifiedDomainName
output apiUrl string = 'http://${apiIp.properties.dnsSettings.fqdn}/'
