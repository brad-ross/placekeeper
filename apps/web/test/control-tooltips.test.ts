import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const CONTROL_ELEMENTS = new Set(['button', 'input', 'select', 'textarea']);

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return extname(entry.name) === '.tsx' ? [path] : [];
  });
}

describe('control tooltip contract', () => {
  it('gives every native button and editable control explicit hover text', () => {
    const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));
    const missing: string[] = [];

    for (const path of sourceFiles(sourceRoot)) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const visit = (node: ts.Node) => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const element = node.tagName.getText(source);
          const hasTitle = node.attributes.properties.some((attribute) => (
            ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'title'
          ));
          if (CONTROL_ELEMENTS.has(element) && !hasTitle) {
            const position = source.getLineAndCharacterOfPosition(node.getStart(source));
            missing.push(`${path}:${position.line + 1} <${element}>`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(missing).toEqual([]);
  });
});
