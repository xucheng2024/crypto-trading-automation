FROM ubuntu:24.04

ARG RUNNER_VERSION
ARG RUNNER_SHA256

RUN test -n "$RUNNER_VERSION" && test -n "$RUNNER_SHA256" \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ca-certificates curl git gnupg jq lsb-release tar \
  && install -d -m 0755 /etc/apt/keyrings \
  && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg \
  && chmod a+r /etc/apt/keyrings/microsoft.gpg \
  && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ $(lsb_release -cs) main" > /etc/apt/sources.list.d/azure-cli.list \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends azure-cli gh \
  && useradd --create-home --shell /bin/bash runner \
  && install -d -o runner -g runner /home/runner/actions-runner \
  && curl -fsSL -o /tmp/actions-runner.tgz "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
  && echo "${RUNNER_SHA256}  /tmp/actions-runner.tgz" | sha256sum --check --strict \
  && tar -xzf /tmp/actions-runner.tgz -C /home/runner/actions-runner \
  && /home/runner/actions-runner/bin/installdependencies.sh \
  && chown -R runner:runner /home/runner/actions-runner \
  && rm -rf /var/lib/apt/lists/* /tmp/actions-runner.tgz

COPY --chown=runner:runner entrypoint.sh /home/runner/entrypoint.sh
RUN chmod 0755 /home/runner/entrypoint.sh

USER runner
WORKDIR /home/runner/actions-runner
ENTRYPOINT ["/home/runner/entrypoint.sh"]
