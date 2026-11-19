import { defineRule, type ESTree } from "@oxlint/plugins";

function isExportedConst(statement: ESTree.Node): boolean {
  return (
    statement.type === "ExportNamedDeclaration" &&
    statement.declaration?.type === "VariableDeclaration" &&
    statement.declaration.kind === "const"
  );
}

export const padExportedConstsRule = defineRule({
  meta: {
    type: "layout",
    fixable: "whitespace",
    messages: {
      blankLine: "Add a blank line between consecutive top-level `export const` declarations.",
    },
  },
  create(context) {
    const { sourceCode } = context;
    const newline = sourceCode.text.match(/\r\n|[\n\r\u2028\u2029]/u)?.[0] ?? "\n";

    return {
      Program(program) {
        for (const [index, statement] of program.body.entries()) {
          const previous = program.body[index - 1];
          if (previous === undefined || !isExportedConst(previous) || !isExportedConst(statement)) {
            continue;
          }

          const comments = sourceCode.getCommentsBefore(statement);
          let previousEndLine = previous.loc.end.line;
          let firstNewLine: number | undefined;
          const hasBlankLine = [...comments, statement].some((next) => {
            const gap = next.loc.start.line - previousEndLine;
            if (gap === 1) firstNewLine ??= next.loc.start.line;
            previousEndLine = next.loc.end.line;
            return gap > 1;
          });
          if (hasBlankLine) continue;

          context.report({
            node: statement,
            messageId: "blankLine",
            fix(fixer) {
              if (firstNewLine === undefined) {
                const previousEnd = comments.at(-1)?.end ?? previous.end;
                return fixer.replaceTextRange([previousEnd, statement.start], newline.repeat(2));
              }
              const start = sourceCode.getIndexFromLoc({ line: firstNewLine, column: 0 });
              return fixer.insertTextBeforeRange([start, start], newline);
            },
          });
        }
      },
    };
  },
});
