// Release gate: keep disabled until the exact backend policies and byte APIs have
// passed live ownership tests. Only a publishable key may ever be wired here.
export const cloudConfig = Object.freeze({
  authEnabled: false,
  enabled: false,
  policiesVerified: false,
  projectUrl: "",
  publishableKey: "",
});
