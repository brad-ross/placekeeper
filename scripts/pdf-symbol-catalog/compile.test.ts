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
0020 ; SPACE
002B ; PLUS SIGN
0041 ; LATIN CAPITAL LETTER A
007C ; VERTICAL LINE
00B0 ; DEGREE SIGN
00B5 ; MICRO SIGN
025B ; LATIN SMALL LETTER OPEN E
03B1 ; GREEK SMALL LETTER ALPHA
03A9 ; GREEK CAPITAL LETTER OMEGA
03B2 ; GREEK SMALL LETTER BETA
03B5 ; GREEK SMALL LETTER EPSILON
03BC ; GREEK SMALL LETTER MU
03C2 ; GREEK SMALL LETTER FINAL SIGMA
03C3 ; GREEK SMALL LETTER SIGMA
03C6 ; GREEK SMALL LETTER PHI
03D0 ; GREEK BETA SYMBOL
03D5 ; GREEK PHI SYMBOL
03F5 ; GREEK LUNATE EPSILON SYMBOL
1F600 ; GRINNING FACE
2126 ; OHM SIGN
2202 ; PARTIAL DIFFERENTIAL
23D0 ; VERTICAL LINE EXTENSION
1D400..1D401 ; MATHEMATICAL TEST *
1D6C2 ; MATHEMATICAL BOLD SMALL ALPHA
1D6C3 ; MATHEMATICAL BOLD SMALL BETA
1D6D3 ; MATHEMATICAL BOLD SMALL FINAL SIGMA
1D6D4 ; MATHEMATICAL BOLD SMALL SIGMA
1D6DC ; MATHEMATICAL BOLD EPSILON SYMBOL
`,
  derivedGeneralCategory: `# DerivedGeneralCategory-17.0.0.txt
0020 ; Zs
002B ; Sm
0041 ; Lu
007C ; Sm
00B0 ; So
00B5 ; Ll
025B ; Ll
03B1 ; Ll
03A9 ; Lu
03B2 ; Ll
03B5 ; Ll
03BC ; Ll
03C2 ; Ll
03C3 ; Ll
03C6 ; Ll
03D0 ; Ll
03D5 ; Ll
03F5 ; Ll
1F600 ; So
2126 ; Lu
2202 ; Sm
23D0 ; So
1D400..1D401 ; Lu
1D6C2..1D6C3 ; Ll
1D6D3..1D6D4 ; Ll
1D6DC ; Ll
`,
  derivedCoreProperties: `# DerivedCoreProperties-17.0.0.txt
002B ; Math
007C ; Math
00B5 ; Math
025B ; Math
03B1..03B2 ; Math
03A9 ; Math
03B5 ; Math
03BC ; Math
03C2..03C3 ; Math
03C6 ; Math
03D0 ; Math
03D5 ; Math
03F5 ; Math
1D400..1D401 ; Math
1D6C2..1D6C3 ; Math
1D6D3..1D6D4 ; Math
1D6DC ; Math
2126 ; Math
`,
  w3cUnicode: `<?xml version="1.0"?>
<unicode unicode="17">
  <characters>
    <character id="U00020" dec="32" mode="text"><unicodedata category="Zs" mathclass="S"/><latex>\\space</latex><description>SPACE</description></character>
    <character id="U0002B" dec="43"><unicodedata category="Sm" mathclass="B"/><latex>+</latex><description>PLUS SIGN</description></character>
    <character id="U00041" dec="65" mode="mixed"><unicodedata category="Lu"/><entity id="Aplain" set="test"><desc>ordinary letter</desc></entity><description>LATIN CAPITAL LETTER A</description></character>
    <character id="U0025B" dec="603" mode="math"><unicodedata category="Ll"/><latex>\\varepsilon</latex><description>LATIN SMALL LETTER OPEN E</description></character>
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
  unicodeData: `00B5;MICRO SIGN;Ll;0;L;<compat> 03BC;;;;N;;;039C;;039C
002D;HYPHEN-MINUS;Pd;0;ES;;;;;N;;;;;
025B;LATIN SMALL LETTER OPEN E;Ll;0;L;;;;;N;LATIN SMALL LETTER EPSILON;;0190;;0190
03B1;GREEK SMALL LETTER ALPHA;Ll;0;L;;;;;N;;;0391;;0391
03A9;GREEK CAPITAL LETTER OMEGA;Lu;0;L;;;;;N;;;;03C9;
03B2;GREEK SMALL LETTER BETA;Ll;0;L;;;;;N;;;0392;;0392
03B5;GREEK SMALL LETTER EPSILON;Ll;0;L;;;;;N;;;0395;;0395
03BC;GREEK SMALL LETTER MU;Ll;0;L;;;;;N;;;039C;;039C
03C2;GREEK SMALL LETTER FINAL SIGMA;Ll;0;L;;;;;N;;;03A3;;03A3
03C3;GREEK SMALL LETTER SIGMA;Ll;0;L;;;;;N;;;03A3;;03A3
03C6;GREEK SMALL LETTER PHI;Ll;0;L;;;;;N;;;03A6;;03A6
03D0;GREEK BETA SYMBOL;Ll;0;L;<compat> 03B2;;;;N;GREEK SMALL LETTER CURLED BETA;;0392;;0392
03D5;GREEK PHI SYMBOL;Ll;0;L;<compat> 03C6;;;;N;GREEK SMALL LETTER SCRIPT PHI;;03A6;;03A6
03F5;GREEK LUNATE EPSILON SYMBOL;Ll;0;L;<compat> 03B5;;;;N;;;0395;;0395
1D400;MATHEMATICAL BOLD CAPITAL A;Lu;0;L;<font> 0041;;;;N;;;;;
1D6C2;MATHEMATICAL BOLD SMALL ALPHA;Ll;0;L;<font> 03B1;;;;N;;;;;
1D6C3;MATHEMATICAL BOLD SMALL BETA;Ll;0;L;<font> 03B2;;;;N;;;;;
1D6D3;MATHEMATICAL BOLD SMALL FINAL SIGMA;Ll;0;L;<font> 03C2;;;;N;;;;;
1D6D4;MATHEMATICAL BOLD SMALL SIGMA;Ll;0;L;<font> 03C3;;;;N;;;;;
1D6DC;MATHEMATICAL BOLD EPSILON SYMBOL;Ll;0;L;<font> 03F5;;;;N;;;;;
2126;OHM SIGN;Lu;0;L;03A9;;;;N;OHM;;;03C9;
2212;MINUS SIGN;Sm;0;ES;<compat> 002D;;;;N;;;;;
2460;CIRCLED DIGIT ONE;No;0;ON;<circle> 0031;;;;N;;;;;
`,
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
    unicodeData: { version: '17.0.0', sha256: sha256(sources.unicodeData) },
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

  it('admits systematic math evidence while excluding mixed-mode prose and emoji', () => {
    const compiled = compileSymbolCatalog(fixtureInput());
    const admitted = compiled.records.map(({ codePoint }) => codePoint);

    expect(admitted).toContain(0x002b);
    expect(admitted).toContain(0x03b1);
    expect(admitted).toContain(0x2202);
    expect(admitted).toContain(0x23d0);
    expect(admitted).not.toContain(0x0020);
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
          action: 'allow',
          expectedUpstreamCodePoints: ['03D5'],
          rationale: 'Preserve the established generic phi input across Unicode phi variants.',
          upstream: 'W3C assigns \\varphi and \\phi to distinct variants.',
        }],
      },
    }));

    expect(compiled.records.filter(({ commands }) => commands.some(({ token }) => token === '\\phi'))
      .map(({ codePoint }) => codePoint)).toEqual([0x03c6, 0x03d5]);
    expect(compiled.report.auditedAliasGroups).toHaveLength(1);
  });

  it('builds deterministic semantic families only from approved UnicodeData decompositions', () => {
    const compiled = compileSymbolCatalog(fixtureInput());

    expect(compiled.equivalenceFamilies).toContainEqual({
      rootCodePoint: 0x03b2,
      queryCodePoints: [0x03b2, 0x03d0],
      memberCodePoints: [0x03b2, 0x03d0, 0x1d6c3],
    });
    expect(compiled.equivalenceFamilies).toContainEqual({
      rootCodePoint: 0x03b5,
      queryCodePoints: [0x03b5, 0x03f5],
      memberCodePoints: [0x03b5, 0x03f5, 0x1d6dc],
    });
    expect(compiled.equivalenceFamilies).toContainEqual({
      rootCodePoint: 0x03bc,
      queryCodePoints: [0x00b5, 0x03bc],
      memberCodePoints: [0x00b5, 0x03bc],
    });
    expect(compiled.equivalenceFamilies).toContainEqual({
      rootCodePoint: 0x03c2,
      queryCodePoints: [0x03c2],
      memberCodePoints: [0x03c2, 0x1d6d3],
    });
    expect(compiled.equivalenceFamilies).toContainEqual({
      rootCodePoint: 0x03c3,
      queryCodePoints: [0x03c3],
      memberCodePoints: [0x03c3, 0x1d6d4],
    });
    expect(compiled.equivalenceFamilies).toContainEqual({
      rootCodePoint: 0x03a9,
      queryCodePoints: [0x03a9, 0x2126],
      memberCodePoints: [0x03a9, 0x2126],
    });
    expect(compiled.equivalenceFamilies.some(({ memberCodePoints }) => (
      memberCodePoints.includes(0x002d) || memberCodePoints.includes(0x2212)
    ))).toBe(false);
    expect(compiled.report.equivalenceEdges).toEqual(
      [...compiled.report.equivalenceEdges].sort((left, right) => (
        left.sourceCodePoint - right.sourceCodePoint
          || left.targetCodePoint - right.targetCodePoint
      )),
    );
  });

  it('audits a command redirect from an erroneous upstream scalar to its intended target', () => {
    const compiled = compileSymbolCatalog(fixtureInput({
      overrides: {
        schemaVersion: 1,
        aliasGroups: [{
          namespace: 'command',
          alias: '\\varepsilon',
          codePoints: ['025B', '03F5'],
          action: 'redirect',
          expectedUpstreamCodePoints: ['025B'],
          canonicalCodePoint: '03F5',
          rationale: 'Correct the upstream TeX command binding without changing the IPA scalar.',
          upstream: 'W3C assigns \\varepsilon to U+025B rather than Greek U+03F5.',
        }],
      },
    }));

    expect(compiled.records.find(({ codePoint }) => codePoint === 0x025b)?.commands)
      .not.toContainEqual(expect.objectContaining({ token: '\\varepsilon' }));
    expect(compiled.records.find(({ codePoint }) => codePoint === 0x03f5)?.commands)
      .toContainEqual({ token: '\\varepsilon', field: 'override', set: null });
    expect(compiled.equivalenceFamilies.find(({ memberCodePoints }) => (
      memberCodePoints.includes(0x03f5)
    ))?.queryCodePoints).toEqual([0x03b5, 0x03f5]);
  });

  it('rejects malformed, duplicate, and unexpected approved-domain UnicodeData mappings', () => {
    const malformed = { ...fixtureSources, unicodeData: fixtureSources.unicodeData.replace(
      '00B5;MICRO SIGN;Ll;0;L;<compat> 03BC;;;;N;;;039C;;039C',
      '00B5;MICRO SIGN;Ll;0;L;<compat> 03BC;;;;N;;;039C;',
    ) };
    expect(() => compileSymbolCatalog(fixtureInput({ sources: malformed })))
      .toThrowError(/UnicodeData.*15 fields/i);

    const duplicate = {
      ...fixtureSources,
      unicodeData: `${fixtureSources.unicodeData}03B2;DUPLICATE;Ll;0;L;;;;;N;;;;;\n`,
    };
    expect(() => compileSymbolCatalog(fixtureInput({ sources: duplicate })))
      .toThrowError(/duplicate UnicodeData.*U\+03B2/i);

    const unexpected = { ...fixtureSources, unicodeData: fixtureSources.unicodeData.replace(
      '03D0;GREEK BETA SYMBOL;Ll;0;L;<compat> 03B2',
      '03D0;GREEK BETA SYMBOL;Ll;0;L;<compat> 03B5',
    ) };
    expect(() => compileSymbolCatalog(fixtureInput({ sources: unexpected })))
      .toThrowError(/unexpected compatibility mapping.*U\+03D0.*U\+03B5/i);
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

  it('audits allow, prefer, and drop collision decisions without broad exceptions', () => {
    const collidingXml = fixtureSources.w3cUnicode
      .replace('<latex>\\varphi</latex>', '<latex>\\phi</latex>')
      .replace('<latex>\\alpha</latex>', '<latex>\\partial</latex>')
      .replace('<character id="U0007C"', '<character id="U1D401" dec="119809"><latex>\\u</latex></character><character id="U0007C"')
      .replace(
        '<character id="U02202" dec="8706"><unicodedata category="Sm"/><latex>\\partial</latex>',
        '<character id="U02202" dec="8706"><unicodedata category="Sm"/><latex>\\partial</latex><varlatex>\\u</varlatex>',
      );
    const sources = { ...fixtureSources, w3cUnicode: collidingXml };
    const compiled = compileSymbolCatalog(fixtureInput({
      sources,
      overrides: {
        schemaVersion: 1,
        aliasGroups: [
          { namespace: 'command', alias: '\\phi', codePoints: ['03C6', '03D5'], action: 'allow', expectedUpstreamCodePoints: ['03C6', '03D5'], rationale: 'Fixture variants.', upstream: 'Fixture collision.' },
          { namespace: 'command', alias: '\\partial', codePoints: ['03B1', '2202'], action: 'prefer', canonicalCodePoint: '2202', rationale: 'Fixture canonical relation.', upstream: 'Fixture collision.' },
          { namespace: 'command', alias: '\\u', codePoints: ['2202', '1D401'], action: 'drop', rationale: 'Fixture unsafe accent.', upstream: 'Fixture collision.' },
        ],
      },
    }));

    expect(compiled.records.filter(({ commands }) => commands.some(({ token }) => token === '\\phi'))
      .map(({ codePoint }) => codePoint)).toEqual([0x03c6, 0x03d5]);
    expect(compiled.records.filter(({ commands }) => commands.some(({ token }) => token === '\\partial'))
      .map(({ codePoint }) => codePoint)).toEqual([0x2202]);
    expect(compiled.records.some(({ commands }) => commands.some(({ token }) => token === '\\u')))
      .toBe(false);
  });

  it('rejects stale prefer and drop decisions when the upstream collision changes', () => {
    expect(() => compileSymbolCatalog(fixtureInput({
      overrides: {
        schemaVersion: 1,
        aliasGroups: [{
          namespace: 'command', alias: '\\partial', codePoints: ['03B1', '2202'], action: 'drop',
          rationale: 'Fixture stale decision.', upstream: 'Fixture has no collision.',
        }],
      },
    }))).toThrowError(/stale drop override.*upstream collision no longer matches/i);
  });

  it('adds one-scalar compatibility aliases without weakening standards admission', () => {
    const compiled = compileSymbolCatalog(fixtureInput({
      overrides: {
        schemaVersion: 1,
        aliasGroups: [{
          namespace: 'name',
          alias: 'addition',
          codePoints: ['002B'],
          action: 'allow',
          expectedUpstreamCodePoints: [],
          rationale: 'Fixture compatibility alias.',
          upstream: 'Fixture has no upstream alias.',
        }],
      },
    }));

    expect(compiled.records.find(({ codePoint }) => codePoint === 0x002b)?.nameAliases)
      .toContain('addition');
  });

  it('rejects allow decisions when any expected upstream mapping changes', () => {
    expect(() => compileSymbolCatalog(fixtureInput({
      overrides: {
        schemaVersion: 1,
        aliasGroups: [{
          namespace: 'command',
          alias: '\\phi',
          codePoints: ['03C6', '03D5'],
          action: 'allow',
          expectedUpstreamCodePoints: ['03C6', '03D5'],
          rationale: 'Fixture stale allow decision.',
          upstream: 'Fixture expects two upstream mappings.',
        }],
      },
    }))).toThrowError(/stale allow override.*expectedUpstreamCodePoints/i);
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
          action: 'allow',
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
          action: 'allow',
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
