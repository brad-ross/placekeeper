/** Unmodified arXiv:2312.07520v3; attribution is included in the static notices. */
export async function createDemoDocument(): Promise<Uint8Array> {
  const response = await fetch(new URL('./assets/counterfactual-matrix-means.pdf', import.meta.url));
  if (!response.ok) throw new Error('The demo document could not load.');
  return new Uint8Array(await response.arrayBuffer());
}
