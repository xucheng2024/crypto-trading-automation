param location string
param prefix string
param workspaceId string
param engineId string
param postgresId string
param jobId string
param natId string
param keyVaultId string
param acrId string
param contactEmails array
param appInsightsDailyCapMb int
param tags object
resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${prefix}-ops'
  location: 'global'
  properties: {
    groupShortName: 'tradeops'
    enabled: true
    emailReceivers: [
      for (email, i) in contactEmails: { name: 'ops${i}', emailAddress: email, useCommonAlertSchema: true }
    ]
  }
  tags: tags
}
resource engineRestart 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-engine-restart'
  location: 'global'
  properties: {
    severity: 2
    enabled: true
    scopes: [engineId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'RestartCount'
          metricName: 'RestartCount'
          metricNamespace: 'Microsoft.App/containerApps'
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroup.id }]
  }
  tags: tags
}
// Candidate metric names need Azure compile/validate, 70 is an absolute count, never 70%.
resource postgresConnections 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-postgres-connections-70'
  location: 'global'
  properties: {
    severity: 2
    enabled: true
    scopes: [postgresId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'active-connections-candidate'
          metricName: 'active_connections'
          metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
          operator: 'GreaterThanOrEqual'
          threshold: 70
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroup.id }]
  }
  tags: union(tags, { verification: 'PENDING_AZURE_COMPILE_VALIDATE' })
}
// Resource metric alerts intentionally remain separate from application logs.
resource postgresStorage70 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-postgres-storage-70'
  location: 'global'
  properties: {
    severity: 2
    enabled: true
    scopes: [postgresId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'storage_percent'
          metricName: 'storage_percent'
          metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
          operator: 'GreaterThan'
          threshold: 70
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroup.id }]
  }
  tags: tags
}
resource postgresStorage85 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-postgres-storage-85-backup-ha'
  location: 'global'
  properties: {
    severity: 1
    enabled: true
    scopes: [postgresId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'storage_percent'
          metricName: 'storage_percent'
          metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
          operator: 'GreaterThan'
          threshold: 85
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroup.id }]
  }
  tags: tags
}
resource jobFailure 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-maintenance-job-failure'
  location: 'global'
  properties: {
    severity: 2
    enabled: true
    scopes: [jobId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'JobsFailed'
          metricName: 'Executions'
          metricNamespace: 'Microsoft.App/jobs'
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
          dimensions: [
            { name: 'state', operator: 'Include', values: ['Failed'] }
          ]
        }
      ]
    }
    actions: [{ actionGroupId: actionGroup.id }]
  }
  tags: tags
}
// Diagnostic/activity queries are used instead of fabricated NAT/ACR counters.
resource natFailure 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${prefix}-nat-anomaly'
  location: location
  properties: {
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    scopes: [workspaceId]
    criteria: {
      allOf: [
        {
          query: 'AzureActivity | where ResourceId =~ "${natId}" | where ActivityStatusValue !~ "Success"'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
    severity: 2
  }
  tags: union(tags, { verification: 'PENDING_AZURE_COMPILE_VALIDATE' })
}
resource vaultFailure 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${prefix}-keyvault-anomaly'
  location: location
  properties: {
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    scopes: [workspaceId]
    criteria: {
      allOf: [
        {
          query: 'AzureDiagnostics | where ResourceId =~ "${keyVaultId}" | where ResultType !in ("Success", "Succeeded") or OperationName has "SecretNearExpiry"'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
    severity: 2
  }
  tags: union(tags, { verification: 'PENDING_AZURE_COMPILE_VALIDATE' })
}
resource acrFailure 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${prefix}-acr-anomaly'
  location: location
  properties: {
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    scopes: [workspaceId]
    criteria: {
      allOf: [
        {
          query: 'AzureActivity | where ResourceId =~ "${acrId}" | where ActivityStatusValue !~ "Success" and OperationNameValue has "pull"'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
    severity: 2
  }
  tags: union(tags, { verification: 'PENDING_AZURE_COMPILE_VALIDATE' })
}
resource appInsightsCap70 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${prefix}-appinsights-ingestion-70'
  location: location
  properties: {
    enabled: true
    evaluationFrequency: 'PT1H'
    windowSize: 'P1D'
    scopes: [workspaceId]
    criteria: {
      allOf: [
        {
          query: 'Usage | where IsBillable == true | summarize usedMB=sum(Quantity) | where usedMB >= ${appInsightsDailyCapMb * 70 / 100}'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
    severity: 2
  }
  tags: union(tags, { verification: 'PENDING_AZURE_COMPILE_VALIDATE' })
}
resource appInsightsCap90 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${prefix}-appinsights-ingestion-90'
  location: location
  properties: {
    enabled: true
    evaluationFrequency: 'PT1H'
    windowSize: 'P1D'
    scopes: [workspaceId]
    criteria: {
      allOf: [
        {
          query: 'Usage | where IsBillable == true | summarize usedMB=sum(Quantity) | where usedMB >= ${appInsightsDailyCapMb * 90 / 100}'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
    severity: 1
  }
  tags: union(tags, { verification: 'PENDING_AZURE_COMPILE_VALIDATE' })
}
// Application health derives from the one-minute runtime snapshot, not a one-off trace.
resource readyFalseSustained 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${prefix}-ready-false-sustained'
  location: location
  properties: {
    enabled: true
    evaluationFrequency: 'PT1M'
    windowSize: 'PT3M'
    scopes: [workspaceId]
    criteria: {
      allOf: [
        {
          query: 'AppTraces | where Message == "metric_snapshot RUNTIME_METRICS" | extend ready=toint(tostring(Properties.ready)) | summarize samples=count(), unready=countif(ready == 0) | where samples >= 2 and unready >= 2'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
    severity: 1
  }
  tags: tags
}
resource telemetryHeartbeatMissing 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${prefix}-telemetry-heartbeat-missing'
  location: location
  properties: {
    enabled: true
    evaluationFrequency: 'PT1M'
    windowSize: 'PT3M'
    scopes: [workspaceId]
    criteria: {
      allOf: [
        {
          query: 'AppTraces | where Message == "metric_snapshot RUNTIME_METRICS" | summarize samples=count() | where samples == 0'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
    severity: 1
  }
  tags: tags
}
resource marketDecisionTelemetryStalled 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${prefix}-market-decision-telemetry-stalled'
  location: location
  properties: {
    enabled: true
    evaluationFrequency: 'PT1M'
    windowSize: 'PT3M'
    scopes: [workspaceId]
    criteria: {
      allOf: [
        {
          query: 'AppTraces | where Message == "metric_snapshot RUNTIME_METRICS" | extend marketMissing=toint(tostring(Properties.market_missing_instruments)), decisionMissing=toint(tostring(Properties.decision_missing_instruments)), marketAge=tolong(tostring(Properties.market_oldest_age_ms)), decisionAge=tolong(tostring(Properties.decision_oldest_age_ms)) | summarize samples=countif(marketMissing > 0 or decisionMissing > 0 or marketAge > 120000 or decisionAge > 120000) | where samples >= 2'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
    severity: 1
  }
  tags: tags
}
resource strategyReadyMissing 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${prefix}-strategy-ready-missing'
  location: location
  properties: {
    enabled: true
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    scopes: [workspaceId]
    criteria: {
      allOf: [
        {
          query: 'AppTraces | where Message == "metric_snapshot RUNTIME_METRICS" | extend strategyReady=toint(tostring(Properties.strategy_ready)) | summarize samples=count(), unready=countif(strategyReady == 0) | where samples >= 3 and unready >= 3'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
    severity: 2
  }
  tags: tags
}
resource sellProtectionMissing 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${prefix}-sell-protection-missing'
  location: location
  properties: {
    enabled: true
    evaluationFrequency: 'PT1M'
    windowSize: 'PT2M'
    scopes: [workspaceId]
    criteria: {
      allOf: [
        {
          query: 'AppTraces | where Message == "metric_snapshot RUNTIME_METRICS" | extend anchorDue=toint(tostring(Properties.anchor_due_unprotected_current)) | summarize samples=countif(anchorDue > 0) | where samples >= 1'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
    severity: 1
  }
  tags: tags
}
resource ownerRecovering 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${prefix}-owner-recovering'
  location: location
  properties: {
    enabled: true
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    scopes: [workspaceId]
    criteria: {
      allOf: [
        {
          query: 'AppTraces | where Message has_any ("OWNER_LOST", "RECOVERING")'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
    severity: 1
  }
  tags: tags
}
resource unknownOrders 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${prefix}-unknown-orders'
  location: location
  properties: {
    enabled: true
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    scopes: [workspaceId]
    criteria: {
      allOf: [
        {
          query: 'AppTraces | where Message has "UNKNOWN_ORDER"'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
    severity: 1
  }
  tags: tags
}
resource riskHalt 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${prefix}-risk-halt'
  location: location
  properties: {
    enabled: true
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    scopes: [workspaceId]
    criteria: {
      allOf: [
        {
          query: 'AppTraces | where Message has "BUY_RISK_HALT"'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
    severity: 1
  }
  tags: tags
}
resource exitBacklog 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${prefix}-exit-backlog'
  location: location
  properties: {
    enabled: true
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    scopes: [workspaceId]
    criteria: {
      allOf: [
        {
          query: 'AppTraces | where Message has "EXIT_BACKLOG"'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
    severity: 2
  }
  tags: tags
}
resource pendingSellWatermark 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${prefix}-pending-sell-watermark'
  location: location
  properties: {
    enabled: true
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    scopes: [workspaceId]
    criteria: {
      allOf: [
        {
          query: 'AppTraces | where Message has_any ("WATERMARK_STALLED", "PENDING_SELL")'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
    severity: 2
  }
  tags: tags
}
