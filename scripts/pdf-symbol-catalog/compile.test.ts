import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CatalogCompileError,
  compileSymbolCatalog,
  type CatalogCompilerInput,
  type CatalogOverrides,
  type SourceManifest,
} from './compile.js';

const W3C_COMMIT = 'ed8b732d7d38112f258e74aadecbb1e409eafdd9';

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const fixtureSources = {
  derivedName: `# DerivedName-17.0.0.txt
002B ; PLUS SIGN
0041 ; LATIN CAPITAL LETTER A
007C ; VERTICAL LINE
00B0 ; DEGREE SIGN
03B1 ; GREEK SMALL LETTER ALPHA
03C6 ; GREEK SMALL LETTER PHI
03D5 ; GREEK PHI SYMBOL
1F600 ; GRINNING FACE
2202 ; PARTIAL DIFFERENTIAL
23D0 ; VERTICAL LINE EXTENSION
1D400..1D401 ; MATHEMATICAL TEST *
`,
  derivedGeneralCategory: `# DerivedGeneralCategory-17.0.0.txt
002B ; Sm
0041 ; Lu
007C ; Sm
00B0 ; So
03B1 ; Ll
03C6 ; Ll
03D5 ; Ll
1F600 ; So
2202 ; Sm
23D0 ; So
1D400..1D401 ; Lu
`,
  derivedCoreProperties: `# DerivedCoreProperties-17.0.0.txt
002B ; Math
007C ; Math
1D400..1D401 ; Math
`,
  w3cUnicode: `<?xml version="1.0"?>
<unicode unicode="17">
  <characters>
    <character id="U0002B" dec="43"><unicodedata category="Sm" mathclass="B"/><latex>+</latex><description>PLUS SIGN</description></character>
    <character id="U00041" dec="65"><unicodedata category="Lu"/><entity id="Aplain" set="test"><desc>ordinary letter</desc></entity><description>LATIN CAPITAL LETTER A</description></character>
    <character id="U0007C" dec="124"><unicodedata category="Sm" mathclass="F"/><latex>\\|</latex><description>VERTICAL LINE</description></character>
    <character id="U000B0" dec="176"><unicodedata category="So"/><latex>^\\circ</latex><description>DEGREE SIGN</description></character>
    <character id="U003B1" dec="945" mode="math" type="alphabetic"><unicodedata category="Lu" mathclass="A"/><latex>\\alpha</latex><entity id="alpha" set="isogrk"><desc>small alpha, Greek</desc></entity><description>GREEK SMALL LETTER ALPHA</description></character>
    <character id="U003C6" dec="966" mode="math" type="alphabetic"><unicodedata category="Ll" mathclass="A"/><latex>\\varphi</latex><description>GREEK SMALL LETTER PHI</description></character>
    <character id="U003D5" dec="981" mode="math" type="alphabetic"><unicodedata category="Ll" mathclass="A"/><latex>\\phi</latex><description>GREEK PHI SYMBOL</description></character>
    <character id="U01F600" dec="128512"><unicodedata category="So"/><entity id="smile" set="html5"><desc>grinning face</desc></entity><description>GRINNING FACE</description></character>
    <character id="U02202" dec="8706"><unicodedata category="Sm"/><latex>\\partial</latex><description>PARTIAL DIFFERENTIAL</description></character>
    <character id="U023D0" dec="9168"><unicodedata category="So" mathclass="G"/><description>VERTICAL LINE EXTENSION</description></character>
    <character id="U1D400" dec="119808" mode="math"><unicodedata category="Lu"/><mathlatex set="unicode-math">\\mbfA</mathlatex><description>MATHEMATICAL BOLD CAPITAL A</description></character>
    <character id="U02242-00338" dec="8770 824"><latex>\\NotEqualTilde</latex><description>NOT TILDE EQUAL</description></character>
  </characters>
</unicode>`,
} as const;

const emptyOverrides: CatalogOverrides = {
  schemaVersion: 1,
  aliasGroups: [],
};

const manifestFor = (
  sources: Readonly<Record<keyof typeof fixtureSources, string>>,
): SourceManifest => ({
  schemaVersion: 1,
  unicodeVersion: '17.0.0',
  w3cCommit: W3C_COMMIT,
  sources: {
    derivedName: { version: '17.0.0', sha256: sha256(sources.derivedName) },
    derivedGeneralCategory: {
      version: '17.0.0',
      sha256: sha256(sources.derivedGeneralCategory),
    },
    derivedCoreProperties: {
      version: '17.0.0',
      sha256: sha256(sources.derivedCoreProperties),
    },
    w3cUnicode: { version: W3C_COMMIT, sha256: sha256(sources.w3cUnicode) },
  },
});

const fixtureInput = (options: {
  readonly sources?: Readonly<Record<keyof typeof fixtureSources, string>>;
  readonly manifest?: SourceManifest;
  readonly overrides?: CatalogOverrides;
} = {}): CatalogCompilerInput => {
  const sources = options.sources ?? fixtureSources;
  return {
    manifest: options.manifest ?? manifestFor(sources),
    sources,
    overrides: options.overrides ?? emptyOverrides,
  };
};

describe('PDF symbol catalog compiler', () => {
  it('parses singleton, range, and astral UCD records under Unicode authority', () => {
    const compiled = compileSymbolCatalog(fixtureInput());

    expect(compiled.records.find(({ codePoint }) => codePoint === 0x1d400)).toMatchObject({
      glyph: '𝐀',
      name: 'MATHEMATICAL TEST 1D400',
      category: 'Lu',
      admission: ['unicode-math', 'w3c-mode', 'w3c-direct-tex'],
    });
    expect(compiled.records.find(({ codePoint }) => codePoint === 0x1d401)).toMatchObject({
      glyph: '𝐁',
      name: 'MATHEMATICAL TEST 1D401',
      category: 'Lu',
      admission: ['unicode-math'],
    });
  });

  it('admits systematic math evidence while excluding category/entity-only prose and emoji', () => {
    const compiled = compileSymbolCatalog(fixtureInput());
    const admitted = compiled.records.map(({ codePoint }) => codePoint);

    expect(admitted).toContain(0x002b);
    expect(admitted).toContain(0x03b1);
    expect(admitted).toContain(0x2202);
    expect(admitted).toContain(0x23d0);
    expect(admitted).not.toContain(0x0041);
    expect(admitted).not.toContain(0x00b0);
    expect(admitted).not.toContain(0x1f600);
    expect(compiled.records.find(({ codePoint }) => codePoint === 0x23d0)?.commands).toEqual([]);
    expect(compiled.records.find(({ codePoint }) => codePoint === 0x03b1)?.category).toBe('Ll');
    expect(compiled.report.crossSourceDisagreements).toContainEqual({
      codePoint: 0x03b1,
      field: 'category',
      unicode: 'Ll',
      w3c: 'Lu',
    });
  });

  it('accepts only whole direct TeX tokens and reports rejected compound expressions', () => {
    const compiled = compileSymbolCatalog(fixtureInput());

    expect(compiled.records.find(({ codePoint }) => codePoint === 0x03b1)?.commands)
      .toEqual([{ token: '\\alpha', field: 'latex', set: null }]);
    expect(compiled.records.find(({ codePoint }) => codePoint === 0x007c)?.commands)
      .toEqual([{ token: '\\|', field: 'latex', set: null }]);
    expect(compiled.report.rejectedTex).toContainEqual({
      codePoint: 0x00b0,
      field: 'latex',
      value: '^\\circ',
      reason: 'not-a-direct-control-token',
    });
  });

  it('reports W3C multi-scalar records without assigning their metadata', () => {
    const compiled = compileSymbolCatalog(fixtureInput());

    expect(compiled.report.excludedMultiScalar).toEqual([
      { id: 'U02242-00338', scalars: [0x2242, 0x0338] },
    ]);
    expect(compiled.records.some(({ entities }) => entities.includes('NotEqualTilde'))).toBe(false);
  });

  it('preserves an audited one-to-many phi command group', () => {
    const compiled = compileSymbolCatalog(fixtureInput({
      overrides: {
        schemaVersion: 1,
        aliasGroups: [{
          namespace: 'command',
          alias: '\\phi',
          codePoints: ['03C6', '03D5'],
          rationale: 'Preserve the established generic phi input across Unicode phi variants.',
          upstream: 'W3C assigns \\varphi and \\phi to distinct variants.',
        }],
      },
    }));

    expect(compiled.records.filter(({ commands }) => commands.some(({ token }) => token === '\\phi'))
      .map(({ codePoint }) => codePoint)).toEqual([0x03c6, 0x03d5]);
    expect(compiled.report.auditedAliasGroups).toHaveLength(1);
  });

  it('rejects an unaudited one-to-many alias collision', () => {
    const collidingXml = fixtureSources.w3cUnicode.replace(
      '<latex>\\varphi</latex>',
      '<latex>\\phi</latex>',
    );
    const sources = { ...fixtureSources, w3cUnicode: collidingXml };

    expect(() => compileSymbolCatalog(fixtureInput({ sources })))
      .toThrowError(/undocumented command alias collision.*\\phi.*U\+03C6.*U\+03D5/i);
  });

  it.each([
    ['checksum mismatch', (input: CatalogCompilerInput) => ({
      ...input,
      manifest: {
        ...input.manifest,
        sources: {
          ...input.manifest.sources,
          derivedName: { version: '17.0.0', sha256: '0'.repeat(64) },
        },
      },
    }), /checksum mismatch/i],
    ['Unicode version mismatch', (input: CatalogCompilerInput) => {
      const sources = {
        ...input.sources,
        derivedName: input.sources.derivedName.replace('17.0.0', '16.0.0'),
      };
      return { ...input, sources, manifest: manifestFor(sources) };
    }, /Unicode version mismatch/i],
    ['malformed W3C ID', (input: CatalogCompilerInput) => {
      const w3cUnicode = input.sources.w3cUnicode.replace('id="U003B1"', 'id="03B1"');
      const sources = { ...input.sources, w3cUnicode };
      return { ...input, sources, manifest: manifestFor(sources) };
    }, /malformed W3C character ID/i],
    ['W3C decimal mismatch', (input: CatalogCompilerInput) => {
      const w3cUnicode = input.sources.w3cUnicode.replace('id="U003B1" dec="945"', 'id="U003B1" dec="946"');
      const sources = { ...input.sources, w3cUnicode };
      return { ...input, sources, manifest: manifestFor(sources) };
    }, /decimal value.*does not match/i],
    ['surrogate scalar', (input: CatalogCompilerInput) => {
      const derivedName = `${input.sources.derivedName}D800 ; SURROGATE TEST\n`;
      const sources = { ...input.sources, derivedName };
      return { ...input, sources, manifest: manifestFor(sources) };
    }, /invalid Unicode scalar.*D800/i],
    ['out-of-range scalar', (input: CatalogCompilerInput) => {
      const w3cUnicode = input.sources.w3cUnicode.replace(
        'id="U003B1" dec="945"',
        'id="U110000" dec="1114112"',
      );
      const sources = { ...input.sources, w3cUnicode };
      return { ...input, sources, manifest: manifestFor(sources) };
    }, /invalid Unicode scalar.*110000/i],
    ['duplicate Unicode record', (input: CatalogCompilerInput) => {
      const derivedName = `${input.sources.derivedName}03B1 ; DUPLICATE ALPHA\n`;
      const sources = { ...input.sources, derivedName };
      return { ...input, sources, manifest: manifestFor(sources) };
    }, /duplicate.*DerivedName.*U\+03B1/i],
  ])('rejects %s deterministically', (_label, mutate, expected) => {
    expect(() => compileSymbolCatalog(mutate(fixtureInput()))).toThrowError(expected);
  });

  it('rejects duplicate W3C records and incompatible XML schema', () => {
    const duplicateRecord = '<character id="U003B1" dec="945" mode="math"><unicodedata category="Ll"/></character>';
    const duplicateXml = fixtureSources.w3cUnicode.replace(
      '</characters>',
      `${duplicateRecord}</characters>`,
    );
    const duplicateSources = { ...fixtureSources, w3cUnicode: duplicateXml };
    expect(() => compileSymbolCatalog(fixtureInput({ sources: duplicateSources })))
      .toThrowError(/duplicate W3C record.*U\+03B1/i);

    const schemaXml = fixtureSources.w3cUnicode
      .replace('<characters>', '<unsupported>')
      .replace('</characters>', '</unsupported>');
    const schemaSources = { ...fixtureSources, w3cUnicode: schemaXml };
    expect(() => compileSymbolCatalog(fixtureInput({ sources: schemaSources })))
      .toThrowError(/schema mismatch.*missing charlist/i);
  });

  it('rejects DTD and entity declarations before XML parsing', () => {
    const w3cUnicode = fixtureSources.w3cUnicode.replace(
      '<unicode unicode="17">',
      '<!DOCTYPE unicode [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><unicode unicode="17">',
    );
    const sources = { ...fixtureSources, w3cUnicode };

    expect(() => compileSymbolCatalog(fixtureInput({ sources })))
      .toThrowError(/DTD and entity declarations are forbidden/i);
  });

  it('rejects stale overrides and literal ASCII redirects', () => {
    expect(() => compileSymbolCatalog(fixtureInput({
      overrides: {
        schemaVersion: 1,
        aliasGroups: [{
          namespace: 'name',
          alias: 'missing symbol',
          codePoints: ['03B1', '10FFFF'],
          rationale: 'Fixture for stale data.',
          upstream: 'No corresponding upstream record.',
        }],
      },
    }))).toThrowError(/stale override.*U\+10FFFF/i);

    expect(() => compileSymbolCatalog(fixtureInput({
      overrides: {
        schemaVersion: 1,
        aliasGroups: [{
          namespace: 'literal' as 'command',
          alias: '-',
          codePoints: ['002B'],
          rationale: 'Forbidden literal redirect.',
          upstream: 'Not applicable.',
        }],
      },
    }))).toThrowError(/literal aliases are forbidden/i);
  });

  it('does not mutate compiler inputs or write partial outputs when validation fails', () => {
    const input = fixtureInput();
    const before = JSON.stringify(input);
    const broken = {
      ...input,
      manifest: {
        ...input.manifest,
        sources: {
          ...input.manifest.sources,
          w3cUnicode: { version: W3C_COMMIT, sha256: 'f'.repeat(64) },
        },
      },
    };

    expect(() => compileSymbolCatalog(broken)).toThrow(CatalogCompileError);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('returns byte-order-stable in-memory data for identical inputs', () => {
    const input = fixtureInput();

    expect(JSON.stringify(compileSymbolCatalog(input)))
      .toBe(JSON.stringify(compileSymbolCatalog(input)));
  });
});
