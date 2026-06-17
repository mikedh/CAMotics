// Bundled example G-code. Parcel resolves each `new URL(..., import.meta.url)`
// to a served/hashed asset URL so the files ship with the build.

export interface ExampleDef {
  file: string;
  label: string;
  url: string;
}

export const DEFAULT_EXAMPLE = 'scorpion.nc';

export const EXAMPLES: ExampleDef[] = [
  { file: 'scorpion.nc', label: 'Scorpion', url: new URL('../examples/scorpion.nc', import.meta.url).href },
  { file: 'slant_test.nc', label: 'Slant test (tiny)', url: new URL('../examples/slant_test.nc', import.meta.url).href },
  { file: 'heart.ngc', label: 'Heart', url: new URL('../examples/heart.ngc', import.meta.url).href },
  { file: 'genes-encoder.ngc', label: 'Genes encoder', url: new URL('../examples/genes-encoder.ngc', import.meta.url).href },
  { file: 'compass_text.ngc', label: 'Compass text', url: new URL('../examples/compass_text.ngc', import.meta.url).href },
  { file: 'vcarve.ngc', label: 'V-carve (large)', url: new URL('../examples/vcarve.ngc', import.meta.url).href },
];

export async function fetchExample(file: string): Promise<string> {
  const ex = EXAMPLES.find((e) => e.file === file);
  if (!ex) throw new Error(`unknown example ${file}`);
  const resp = await fetch(ex.url);
  if (!resp.ok) throw new Error(`could not load ${file}`);
  return resp.text();
}
