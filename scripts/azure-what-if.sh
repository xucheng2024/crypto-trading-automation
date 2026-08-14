#!/usr/bin/env sh
set -eu
echo 'This command intentionally does not run Azure. Review and replace placeholders, then obtain authorization.'
echo 'az deployment group what-if --resource-group <RESOURCE_GROUP> --template-file infrastructure/bicep/main.bicep --parameters infrastructure/bicep/parameters.example.json'
