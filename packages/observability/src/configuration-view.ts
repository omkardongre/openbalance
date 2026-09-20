/**
 * Narrows a process environment to a service's own configuration namespace.
 *
 * A managed runtime always injects variables of its own — `K_SERVICE`, `K_REVISION`, `PORT`,
 * `NODE_ENV`, and whatever the base image sets — so a schema applied strictly to the whole
 * environment rejects every start on such a platform. Loosening the schema instead would give up a
 * property worth keeping: within a service's own namespace an unrecognised name is a typo, and a
 * misspelled policy limit is not applied, leaving the real limit silently at its default. That is
 * exactly the class of mistake that must not reach a money path.
 *
 * So the platform's variables are ignored and ours are checked: a key matching one of the service's
 * prefixes but not declared by its schema is a hard failure.
 */
export function configurationView(
  environment: Record<string, string | undefined>,
  declared: Iterable<string>,
  prefixes: readonly string[],
  service: string,
): Record<string, string> {
  const known = new Set(declared);
  const view: Record<string, string> = {};
  const unexpected: string[] = [];
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (known.has(key)) {
      view[key] = value;
      continue;
    }
    if (prefixes.some((prefix) => key.startsWith(prefix))) unexpected.push(key);
  }
  if (unexpected.length > 0)
    throw new Error(
      `Unrecognized ${service} configuration: ${unexpected.sort().join(", ")}. ` +
        "A misspelled name is ignored rather than applied, so it is rejected here.",
    );
  return view;
}
