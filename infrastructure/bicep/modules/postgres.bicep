param location string
param name string
param skuName string
param allowedNatIp string
param tags object
param entraAdministratorObjectId string
param entraAdministratorPrincipalName string
@allowed(['User', 'Group', 'ServicePrincipal'])
param entraAdministratorPrincipalType string
param tenantId string
param databaseName string
resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: name
  location: location
  sku: { name: skuName, tier: 'GeneralPurpose' }
  properties: {
    version: '16'
    authConfig: { activeDirectoryAuth: 'Enabled', passwordAuth: 'Disabled', tenantId: tenantId }
    storage: { storageSizeGB: 128, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'ZoneRedundant' }
    network: { publicNetworkAccess: 'Enabled' }
  }
  tags: tags
}
resource administrator 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: server
  name: entraAdministratorObjectId
  properties: {
    principalName: entraAdministratorPrincipalName
    principalType: entraAdministratorPrincipalType
    tenantId: tenantId
  }
}
resource firewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: server
  name: 'nat-egress-only'
  properties: { startIpAddress: allowedNatIp, endIpAddress: allowedNatIp }
}
resource tls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'require_secure_transport'
  properties: { value: 'on', source: 'user-override' }
}
resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: databaseName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}
output fqdn string = server.properties.fullyQualifiedDomainName
output id string = server.id
