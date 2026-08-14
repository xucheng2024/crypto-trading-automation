param location string
param name string
@allowed(['Basic', 'Standard', 'Premium'])
param skuName string
param tags object
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: name
  location: location
  sku: { name: skuName }
  properties: { adminUserEnabled: false }
  tags: tags
}
output loginServer string = acr.properties.loginServer
output id string = acr.id
