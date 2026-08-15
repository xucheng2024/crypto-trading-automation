targetScope = 'resourceGroup'

param location string
param runnerName string
param environmentId string
param registryIdentityId string
param registryServer string
@description('Immutable ACR image reference ending in @sha256:<digest>.')
param runnerImage string
param githubRepository string
@secure()
param githubRunnerPat string
param tags object = {}

resource runner 'Microsoft.App/containerApps@2024-03-01' = {
  name: runnerName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${registryIdentityId}': {} }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{ server: registryServer, identity: registryIdentityId }]
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

output runnerId string = runner.id
