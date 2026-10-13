import { readFile, writeFile } from "node:fs/promises";

export function observationRunCommand(config, bootstrap) {
  if (config?.env?.ORDER_EXECUTION_ENABLED !== "false" || !/@sha256:[a-f0-9]{64}$/.test(config.image ?? "")) throw new Error("Observer requires disabled execution and a pinned image");
  const encode = (value) => Buffer.from(value).toString("base64");
  return { commandId: "RunShellScript", script: [
    "set -eu",
    "cloud-init status --wait >/dev/null",
    "install -d -m 700 /opt/crypto-observation /etc/crypto-observation",
    "python3 - <<'PY'",
    "import base64, os",
    ...[["/etc/crypto-observation/config.json", encode(JSON.stringify(config))], ["/opt/crypto-observation/bootstrap.py", encode(bootstrap)]].map(([path, content]) => `with os.fdopen(os.open('${path}', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'wb') as stream: stream.write(base64.b64decode('${content}'))`),
    "PY",
    "python3 /opt/crypto-observation/bootstrap.py",
  ] };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const [, , deploymentPath, outputPath] = process.argv;
  const outputs = JSON.parse(await readFile(deploymentPath, "utf8")).properties.outputs;
  const bootstrap = await readFile(new URL("../infrastructure/observation/bootstrap.py", import.meta.url), "utf8");
  const command = observationRunCommand(outputs.bootstrapConfig.value, bootstrap);
  const body = { location: "eastasia", properties: { source: { script: command.script.join("\n") }, timeoutInSeconds: 600, asyncExecution: false, treatFailureAsDeploymentFailure: true, protectedParameters: [{ name: "POSTGRES_PASSWORD", value: process.env.OBSERVATION_POSTGRES_PASSWORD }, { name: "INSIGHTS_CONNECTION_STRING", value: process.env.INSIGHTS_CONNECTION_STRING }, { name: "GH_RUNNER_PAT", value: process.env.GH_RUNNER_PAT }] } };
  if (body.properties.protectedParameters.some((item) => !item.value)) throw new Error("Protected observer parameters are missing");
  await writeFile(outputPath, JSON.stringify(body), { mode: 0o600 });
}
