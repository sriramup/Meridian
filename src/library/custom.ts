// Framework primitives (escape hatches): built in by the library core so the agent can make things
// the catalog doesn't have. Filled in below.

let done = false;
export function registerBuiltins(): void {
  if (done) return;
  done = true;
}
