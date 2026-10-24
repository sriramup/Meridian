// The catalog: every primitive definition registers here (owned by the catalog author; the
// framework calls registerCatalog() once before the library is used).

let done = false;

export function registerCatalog(): void {
  if (done) return;
  done = true;
}
