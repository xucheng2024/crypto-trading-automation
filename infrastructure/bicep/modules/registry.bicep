param location string
param name string
param tags object
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = { name: name; location: location; sku: { name: 'Premium' }; properties: { adminUserEnabled: false }; tags: tags }
output loginServer string = acr.properties.loginServer
output id string = acr.id
