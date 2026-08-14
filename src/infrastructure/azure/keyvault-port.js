// The production composition may inject an Azure SDK-backed implementation.
// Domain/application code receives only this narrow port; maintenance never does.
export class KeyVaultSecretPort {
  constructor({ getSecret } = {}) { if (typeof getSecret !== 'function') throw new TypeError('getSecret port required'); this.getSecret = getSecret; }
  async readOkxCredentials(names) { return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await this.getSecret(name)]))); }
}

// This is the only production credential source.  It deliberately has no
// environment-value fallback: environment configuration may name a secret,
// but never contain its value.
export class AzureKeyVaultSecretPort extends KeyVaultSecretPort {
  constructor({ vaultUrl, credential, SecretClient, logger = () => {} } = {}) {
    if (!vaultUrl || !String(vaultUrl).startsWith("https://")) throw new Error("KEY_VAULT_URI is required");
    if (!credential) throw new TypeError("TokenCredential is required");
    if (typeof SecretClient !== "function") throw new TypeError("Azure Key Vault SecretClient is required");
    const client = new SecretClient(vaultUrl, credential);
    super({ getSecret: async (name) => {
      try {
        const result = await client.getSecret(name);
        if (typeof result?.value !== "string" || result.value.length === 0) throw new Error(`KEY_VAULT_SECRET_EMPTY:${name}`);
        return result.value;
      } catch (error) {
        // Names are non-sensitive; values and SDK error detail are not emitted.
        logger({ reason: "KEY_VAULT_SECRET_UNAVAILABLE", secretName: name });
        throw new Error(`KEY_VAULT_SECRET_UNAVAILABLE:${name}`);
      }
    } });
    this.client = client;
  }
  async readOkxCredentials(names) {
    const selected = { apiKey: names?.apiKey ?? "okx-api-key", secretKey: names?.secretKey ?? "okx-secret-key", passphrase: names?.passphrase ?? "okx-passphrase" };
    const values = await Promise.all(Object.entries(selected).map(async ([key, name]) => [key, await this.getSecret(name)]));
    return Object.freeze(Object.fromEntries(values));
  }
}

export async function createManagedIdentityKeyVaultPort(options = {}) {
  const { ManagedIdentityCredential } = await import("@azure/identity");
  const { SecretClient } = await import("@azure/keyvault-secrets");
  return new AzureKeyVaultSecretPort({ ...options, credential: options.credential ?? new ManagedIdentityCredential(), SecretClient });
}
