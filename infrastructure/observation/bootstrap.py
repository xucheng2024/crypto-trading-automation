"""Start a public-market observer; no exchange credentials are available."""

import json
import os
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path


def read_json(url, *, data=None, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers or {}), timeout=30) as response:
        return json.load(response)


def configure(config):
    if config["env"].get("ORDER_EXECUTION_ENABLED") != "false" or "@sha256:" not in config["image"]:
        raise ValueError("Observer requires disabled execution and a pinned image")
    query = urllib.parse.urlencode({"api-version": "2018-02-01", "resource": "https://management.azure.com/", "client_id": config["clientId"]})
    token = read_json("http://169.254.169.254/metadata/identity/oauth2/token?" + query, headers={"Metadata": "true"})["access_token"]
    exchange = urllib.parse.urlencode({"grant_type": "access_token", "service": config["registry"], "tenant": config["tenantId"], "access_token": token}).encode()
    refresh = read_json("https://" + config["registry"] + "/oauth2/exchange", data=exchange, headers={"Content-Type": "application/x-www-form-urlencoded"})["refresh_token"]
    env = {**config["env"], "OBSERVATION_POSTGRES_PASSWORD": os.environ["POSTGRES_PASSWORD"], "APPLICATIONINSIGHTS_CONNECTION_STRING": os.environ["INSIGHTS_CONNECTION_STRING"]}
    path = Path("/etc/crypto-observation/runtime.env")
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as stream:
        for key, value in env.items():
            if "\n" in str(value) or "\r" in str(value):
                raise ValueError("Multiline environment value is forbidden")
            stream.write(key + "=" + str(value) + "\n")
    subprocess.run(["docker", "login", config["registry"], "--username", "00000000-0000-0000-0000-000000000000", "--password-stdin"], input=refresh, text=True, check=True, capture_output=True)
    try:
        subprocess.run(["docker", "pull", config["image"]], check=True, capture_output=True)
        subprocess.run(["docker", "pull", config["runnerImage"]], check=True, capture_output=True)
    finally:
        subprocess.run(["docker", "logout", config["registry"]], check=True, capture_output=True)
    exists = subprocess.run(["docker", "inspect", "crypto-observation"], check=False, capture_output=True)
    if exists.returncode == 0:
        subprocess.run(["docker", "stop", "--time", "30", "crypto-observation"], check=True, capture_output=True)
        subprocess.run(["docker", "rm", "crypto-observation"], check=True, capture_output=True)
    subprocess.run(["docker", "run", "--detach", "--name", "crypto-observation", "--restart", "unless-stopped", "--network", "host", "--memory", "512m", "--cpus", "0.5", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--log-opt", "max-size=5m", "--log-opt", "max-file=2", "--env-file", str(path), "--entrypoint", "node", config["image"], "src/entrypoints/azure/market-observer.js"], check=True, capture_output=True)
    runner = subprocess.run(["docker", "inspect", "crypto-migration-runner"], check=False, capture_output=True)
    if runner.returncode == 0:
        if json.loads(runner.stdout)[0]["State"]["Running"]:
            raise RuntimeError("Migration runner is still busy")
        subprocess.run(["docker", "rm", "crypto-migration-runner"], check=True, capture_output=True)
    runner_path = Path("/etc/crypto-observation/runner.env")
    with os.fdopen(os.open(runner_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as stream:
        stream.write("GITHUB_REPOSITORY=" + config["githubRepository"] + "\n")
        stream.write("GITHUB_RUNNER_PAT=" + os.environ["GH_RUNNER_PAT"] + "\n")
    # Dormant between releases: migrations keep the existing VNet/NAT and label.
    subprocess.run(["docker", "create", "--name", "crypto-migration-runner", "--network", "host", "--env-file", str(runner_path), "--log-opt", "max-size=5m", "--log-opt", "max-file=2", config["runnerImage"]], check=True, capture_output=True)


def main():
    config = json.loads(Path("/etc/crypto-observation/config.json").read_text())
    for attempt in range(3):
        try:
            configure(config)
            print("Public-market observer started; no exchange credentials or order transport")
            return
        except (OSError, subprocess.CalledProcessError):
            if attempt == 2:
                raise RuntimeError("Observer bootstrap failed") from None
            time.sleep(15)


if __name__ == "__main__":
    main()
