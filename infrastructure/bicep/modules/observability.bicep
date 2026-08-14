param location string
param workspaceName string
param appInsightsName string
param appInsightsDailyCapGb int
param tags object
resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = { name: workspaceName; location: location; properties: { sku: { name: 'PerGB2018' }; retentionInDays: 30 }; tags: tags }
resource ai 'Microsoft.Insights/components@2020-02-02' = { name: appInsightsName; location: location; kind: 'web'; properties: { Application_Type: 'web'; WorkspaceResourceId: law.id; DailyDataCap: appInsightsDailyCapGb }; tags: tags }
output customerId string = law.properties.customerId
output workspaceId string = law.id
@secure()
output sharedKey string = listKeys(law.id, law.apiVersion).primarySharedKey
