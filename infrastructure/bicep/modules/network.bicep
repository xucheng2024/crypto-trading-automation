param location string
param vnetName string
param natName string
param tags object
resource publicIp 'Microsoft.Network/publicIPAddresses@2023-11-01' = {
  name: '${natName}-pip'
  location: location
  sku: { name: 'Standard' }
  properties: { publicIPAllocationMethod: 'Static' }
  tags: tags
}
resource nat 'Microsoft.Network/natGateways@2023-11-01' = {
  name: natName
  location: location
  sku: { name: 'Standard' }
  properties: { publicIpAddresses: [{ id: publicIp.id }] }
  tags: tags
}
resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.42.0.0/16'] }
    subnets: [
      {
        name: 'containerapps'
        properties: {
          addressPrefix: '10.42.0.0/27'
          delegations: [{ name: 'containerapps', properties: { serviceName: 'Microsoft.App/environments' } }]
          natGateway: { id: nat.id }
        }
      }
    ]
  }
  tags: tags
}
output subnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'containerapps')
output publicIp string = publicIp.properties.ipAddress
output natId string = nat.id
