function normalizedWord(word: string): string {
  return word.normalize('NFC').toLocaleLowerCase();
}

function morphologyKeys(word: string): ReadonlySet<string> {
  const value = normalizedWord(word);
  const keys = new Set<string>([value]);
  const add = (candidate: string) => {
    if (candidate.length >= 4) keys.add(candidate);
  };

  const rules: readonly [RegExp, (match: RegExpMatchArray) => string][] = [
    [/^(.*)abilities$/u, (match) => `${match[1]}abil`],
    [/^(.*)ability$/u, (match) => `${match[1]}abil`],
    [/^(.*)able$/u, (match) => `${match[1]}abil`],
    [/^(.*)ibilities$/u, (match) => `${match[1]}ibil`],
    [/^(.*)ibility$/u, (match) => `${match[1]}ibil`],
    [/^(.*)izes$/u, (match) => `${match[1]}`],
    [/^(.*)ized$/u, (match) => `${match[1]}`],
    [/^(.*)izing$/u, (match) => `${match[1]}`],
    [/^(.*)ization$/u, (match) => `${match[1]}`],
    [/^(.*)ities$/u, (match) => `${match[1]}`],
    [/^(.*)ity$/u, (match) => `${match[1]}`],
    [/^(.*)ies$/u, (match) => `${match[1]}y`],
    [/^(.*)ing$/u, (match) => `${match[1]}`],
    [/^(.*)ed$/u, (match) => `${match[1]}`],
    [/^(.*)es$/u, (match) => `${match[1]}`],
    [/^(.*)s$/u, (match) => `${match[1]}`],
  ];

  for (const [pattern, transform] of rules) {
    const match = value.match(pattern);
    if (match) add(transform(match));
  }
  return keys;
}

function sharesMorphology(left: string, right: string): boolean {
  const leftKeys = morphologyKeys(left);
  const rightKeys = morphologyKeys(right);
  for (const key of leftKeys) {
    if (rightKeys.has(key)) return true;
  }
  return false;
}

export function findRelatedWordForms(
  query: string,
  documentWords: readonly string[],
): string[] {
  const exact = normalizedWord(query);
  return [...new Set(documentWords.map(normalizedWord))]
    .filter((candidate) => candidate !== exact && sharesMorphology(exact, candidate))
    .sort((left, right) => left.localeCompare(right));
}

export function relatedPhraseQueries(
  query: string,
  documentWords: readonly string[],
  limit = 64,
): string[] {
  const words = query.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [];
  const options = words.map((word) => [
    normalizedWord(word),
    ...findRelatedWordForms(word, documentWords),
  ]);
  const original = words.map(normalizedWord).join(' ');
  const results: string[] = [];

  const visit = (index: number, chosen: string[]) => {
    if (results.length >= limit) return;
    if (index === options.length) {
      const candidate = chosen.join(' ');
      if (candidate !== original) results.push(candidate);
      return;
    }
    for (const option of options[index] ?? []) {
      visit(index + 1, [...chosen, option]);
      if (results.length >= limit) break;
    }
  };
  visit(0, []);
  return [...new Set(results)];
}
