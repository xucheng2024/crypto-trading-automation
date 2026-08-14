import { readFile } from "node:fs/promises";
import { runReadOnlyPreflight } from "../src/entrypoints/azure/read-only-preflight.js";

if (!process.argv.includes("--real")) {
  const fixturePath = process.argv[2] ?? "fixtures/p4/preflight-offline.json";
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  console.log(JSON.stringify(await runReadOnlyPreflight({ mode: "offline", fixture })));
} else {
  if (process.env.P4_REAL_PREFLIGHT_AUTHORIZED !== "true") throw new Error("Real preflight requires P4_REAL_PREFLIGHT_AUTHORIZED=true");
  const vaultUrl = process.env.KEY_VAULT_URI;
  const instId = process.env.OKX_PREFLIGHT_INST_ID;
  if (!vaultUrl?.startsWith("https://")) throw new Error("KEY_VAULT_URI is required for real preflight");
  const [{ AzureCliCredential }, { SecretClient }, { AzureKeyVaultSecretPort }, { OkxRestClient }] = await Promise.all([
    import("@azure/identity"),
    import("@azure/keyvault-secrets"),
    import("../src/infrastructure/azure/keyvault-port.js"),
    import("../src/infrastructure/okx/rest-client.js"),
  ]);
  const keyVault = new AzureKeyVaultSecretPort({ vaultUrl, credential: new AzureCliCredential(), SecretClient });
  const credentials = await keyVault.readOkxCredentials();
  const client = new OkxRestClient({ credentials });
  console.log(JSON.stringify(await runReadOnlyPreflight({ mode: "real", client, instId, realAuthorized: true })));
}
