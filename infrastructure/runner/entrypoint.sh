#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_RUNNER_PAT:?GITHUB_RUNNER_PAT is required}"

api="https://api.github.com/repos/${GITHUB_REPOSITORY}"
repository_url="https://github.com/${GITHUB_REPOSITORY}"
registration_token="$(curl --fail --silent --show-error --request POST \
  --header 'Accept: application/vnd.github+json' \
  --header "Authorization: Bearer ${GITHUB_RUNNER_PAT}" \
  --header 'X-GitHub-Api-Version: 2022-11-28' \
  "${api}/actions/runners/registration-token" | jq -er '.token')"

unset GITHUB_RUNNER_PAT
rm -f .runner .credentials .credentials_rsaparams
rm -rf _work
mkdir -p _work

./config.sh --unattended --ephemeral --disableupdate \
  --url "$repository_url" \
  --token "$registration_token" \
  --name "crypto-remote-${HOSTNAME}" \
  --labels "crypto-remote-migration" \
  --work "_work"

unset registration_token
exec ./run.sh
