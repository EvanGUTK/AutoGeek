import ts from 'typescript';

/** Modules whose import gives a test access to the disk or to other processes. */
const IO_MODULES: ReadonlySet<string> = new Set(['fs', 'fs/promises', 'child_process']);
const IMPORT_META_LOCATION = new Set(['dirname', 'filename', 'url']);

const moduleName = (specifier: string): string => specifier.replace(/^node:/, '');

function ioModuleFinding(specifier: string): string | undefined {
  return IO_MODULES.has(moduleName(specifier)) ? `imports ${specifier}` : undefined;
}

/**
 * Finds what in a test file's source could read files outside its own package (or run a program
 * that can): imports of fs and child_process (also re-exports, dynamic imports and require),
 * dynamic imports whose specifier is not a plain string (it could be anything), and the ways to
 * locate the checkout: import.meta.dirname / filename / url, __dirname, __filename and
 * process.cwd(). Such a test reads state that is not in the package's turbo hash, so a cached
 * result can be stale (review K2). Works on the AST, so comments and strings do not count.
 * Returns human-readable findings; an empty list means nothing was found.
 */
export function findOutsideReads(source: string): string[] {
  const file = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  const findings: string[] = [];
  const stack: ts.Node[] = [file];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    ts.forEachChild(node, (child) => {
      stack.push(child);
    });
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const finding = ioModuleFinding(node.moduleSpecifier.text);
      if (finding !== undefined) {
        findings.push(finding);
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const [argument] = node.arguments;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        if (argument !== undefined && ts.isStringLiteralLike(argument)) {
          const finding = ioModuleFinding(argument.text);
          if (finding !== undefined) {
            findings.push(`dynamically ${finding}`);
          }
        } else {
          findings.push('dynamic import() with a computed specifier');
        }
      } else if (ts.isIdentifier(callee) && callee.text === 'require') {
        findings.push('calls require()');
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'process' &&
        callee.name.text === 'cwd'
      ) {
        findings.push('calls process.cwd()');
      }
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      IMPORT_META_LOCATION.has(node.name.text)
    ) {
      findings.push(`uses import.meta.${node.name.text}`);
    } else if (ts.isIdentifier(node) && (node.text === '__dirname' || node.text === '__filename')) {
      findings.push(`uses ${node.text}`);
    }
  }
  return findings;
}
