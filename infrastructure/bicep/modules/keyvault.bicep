param location string
param name string
param tags object
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    accessPolicies: []
  }
  tags: tags
}
output name string = kv.name
output id string = kv.id
