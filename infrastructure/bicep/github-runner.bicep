targetScope = 'resourceGroup'

param location string
param runnerName string
param environmentId string
param registryId string
param registryServer string
@description('Immutable ACR image reference ending in @sha256:<digest>.')
param runnerImage string
param githubRepository string
@secure()
param githubRunnerPat string
param tags object = {}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: last(split(registryId, '/'))
}

resource runner 'Microsoft.App/containerApps@2024-03-01' = {
  name: runnerName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{ server: registryServer, identity: 'system' }]
      secrets: [{ name: 'github-runner-pat', value: githubRunnerPat }]
    }
    template: {
      scale: { minReplicas: 1, maxReplicas: 1 }
      containers: [
        {
          name: 'github-runner'
          image: runnerImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'GITHUB_REPOSITORY', value: githubRepository }
            { name: 'GITHUB_RUNNER_PAT', secretRef: 'github-runner-pat' }
          ]
        }
      ]
    }
  }
  tags: tags
}

var acrPullRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
resource runnerAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registryId, runner.id, acrPullRole)
  scope: acr
  properties: {
    principalId: runner.identity.principalId
    roleDefinitionId: acrPullRole
    principalType: 'ServicePrincipal'
  }
}

output runnerId string = runner.id
output runnerPrincipalId string = runner.identity.principalId
