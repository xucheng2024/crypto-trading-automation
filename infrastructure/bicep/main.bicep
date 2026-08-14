targetScope = 'resourceGroup'

@description('All production revisions must be supplied as immutable @sha256: digests.')
param imageDigest string
param location string = 'eastasia'
param prefix string = 'trading'
param tags object = {}
@allowed(['Consumption', 'Dedicated'])
param workloadProfileType string = 'Consumption'
param postgresSku string = 'Standard_D2ds_v4'
param monthlyBudgetUsd int = 250
param budgetStartDate string
param budgetContactEmails array
param budgetThresholdPercent int = 80
@minValue(1)
param appInsightsDailyCapGb int = 1
param entraAdministratorObjectId string
param entraAdministratorPrincipalName string
param entraAdministratorPrincipalType string
param tenantId string = subscription().tenantId
param postgresDatabase string = 'trading'
param okxAccountId string = 'default'
param okxInstruments string
param managedFillStartMs string
param strategyConfigJson string

var names = {
  env: '${prefix}-cae'
  vnet: '${prefix}-vnet'
  nat: '${prefix}-nat'
  acr: '${prefix}acr'
  kv: '${prefix}-kv'
  pg: '${prefix}-pg'
  law: '${prefix}-law'
  ai: '${prefix}-ai'
}
var engineImage = imageDigest

module network 'modules/network.bicep' = {
  name: 'network'
  params: { location: location, vnetName: names.vnet, natName: names.nat, tags: tags }
}
module observability 'modules/observability.bicep' = {
  name: 'observability'
  params: {
    location: location
    workspaceName: names.law
    appInsightsName: names.ai
    appInsightsDailyCapGb: appInsightsDailyCapGb
    tags: tags
  }
}
module registry 'modules/registry.bicep' = {
  name: 'registry'
  params: { location: location, name: '${toLower(replace(prefix, '-', ''))}acr', tags: tags }
}
module vault 'modules/keyvault.bicep' = { name: 'vault', params: { location: location, name: names.kv, tags: tags } }
module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    location: location
    name: names.pg
    skuName: postgresSku
    allowedNatIp: network.outputs.publicIp
    entraAdministratorObjectId: entraAdministratorObjectId
    entraAdministratorPrincipalName: entraAdministratorPrincipalName
    entraAdministratorPrincipalType: entraAdministratorPrincipalType
    tenantId: tenantId
    databaseName: postgresDatabase
    tags: tags
  }
}
var enginePrincipalName = '${names.env}-engine'
var maintenancePrincipalName = '${names.env}-maintenance'
var enginePostgresUrl = 'postgresql://${uriComponent(enginePrincipalName)}@${postgres.outputs.fqdn}:5432/${postgresDatabase}'
var maintenancePostgresUrl = 'postgresql://${uriComponent(maintenancePrincipalName)}@${postgres.outputs.fqdn}:5432/${postgresDatabase}'
module apps 'modules/apps.bicep' = {
  name: 'apps'
  params: {
    location: location
    environmentName: names.env
    infrastructureSubnetId: network.outputs.subnetId
    image: engineImage
    registryServer: registry.outputs.loginServer
    logAnalyticsCustomerId: observability.outputs.customerId
    logAnalyticsSharedKey: observability.outputs.sharedKey
    workloadProfileType: workloadProfileType
    acrId: registry.outputs.id
    keyVaultId: vault.outputs.id
    keyVaultUri: 'https://${vault.outputs.name}${environment().suffixes.keyvaultDns}'
    enginePostgresUrl: enginePostgresUrl
    maintenancePostgresUrl: maintenancePostgresUrl
    okxAccountId: okxAccountId
    okxInstruments: okxInstruments
    managedFillStartMs: managedFillStartMs
    strategyConfigJson: strategyConfigJson
    tags: tags
  }
}
module alerts 'modules/alerts.bicep' = {
  name: 'alerts'
  params: {
    location: location
    prefix: prefix
    workspaceId: observability.outputs.workspaceId
    engineId: apps.outputs.engineId
    postgresId: postgres.outputs.id
    jobId: apps.outputs.jobId
    natId: network.outputs.natId
    keyVaultId: vault.outputs.id
    acrId: registry.outputs.id
    contactEmails: budgetContactEmails
    appInsightsDailyCapMb: appInsightsDailyCapGb * 1024
    tags: tags
  }
}

resource budget 'Microsoft.Consumption/budgets@2023-05-01' = {
  name: '${prefix}-monthly-budget'
  properties: {
    category: 'Cost'
    amount: monthlyBudgetUsd
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate }
    notifications: {
      budget: {
        enabled: true
        operator: 'GreaterThan'
        threshold: budgetThresholdPercent
        contactEmails: budgetContactEmails
      }
    }
  }
}

output engineImageDigest string = engineImage
output natPublicIp string = network.outputs.publicIp
output keyVaultName string = vault.outputs.name
output postgresFqdn string = postgres.outputs.fqdn
output enginePrincipalId string = apps.outputs.enginePrincipalId
output maintenancePrincipalId string = apps.outputs.maintenancePrincipalId
output enginePrincipalName string = apps.outputs.enginePrincipalName
output maintenancePrincipalName string = apps.outputs.maintenancePrincipalName
