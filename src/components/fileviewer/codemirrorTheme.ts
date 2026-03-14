import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

export function createTheme(): Extension[] {
  const bg = cssVar("--bg");
  const fg = cssVar("--fg");
  const fgMuted = cssVar("--fg-muted");
  const fgDim = cssVar("--fg-dim");
  const bgHover = cssVar("--bg-hover");
  const selectionBg = cssVar("--selection-bg");

  const red = cssVar("--red");
  const green = cssVar("--green");
  const blue = cssVar("--blue");
  const yellow = cssVar("--yellow");
  const purple = cssVar("--purple");
  const aqua = cssVar("--aqua");
  const gray = cssVar("--gray");

  const theme = EditorView.theme({
    "&": {
      backgroundColor: bg,
      color: fg,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      fontSize: "13px",
      lineHeight: "1.5",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-content": {
      caretColor: fg,
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: fg,
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: selectionBg + " !important",
        color: "inherit",
      },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: fgDim,
      border: "none",
      fontSize: "12px",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      textAlign: "right",
    },
    ".cm-activeLine": {
      backgroundColor: bgHover + "80",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
    },
    ".cm-scroller": {
      scrollbarWidth: "thin",
    },
  });

  const highlighting = HighlightStyle.define([
    { tag: tags.keyword, color: red },
    { tag: tags.controlKeyword, color: red },
    { tag: tags.operatorKeyword, color: red },
    { tag: tags.definitionKeyword, color: red },
    { tag: tags.moduleKeyword, color: red },

    { tag: tags.string, color: green },
    { tag: tags.special(tags.string), color: green },

    { tag: tags.number, color: purple },
    { tag: tags.bool, color: purple },
    { tag: tags.null, color: purple },

    { tag: tags.comment, color: gray, fontStyle: "italic" },
    { tag: tags.lineComment, color: gray, fontStyle: "italic" },
    { tag: tags.blockComment, color: gray, fontStyle: "italic" },
    { tag: tags.docComment, color: gray, fontStyle: "italic" },

    { tag: tags.function(tags.definition(tags.variableName)), color: green },
    { tag: tags.function(tags.variableName), color: green },

    { tag: tags.typeName, color: yellow },
    { tag: tags.className, color: yellow },
    { tag: tags.standard(tags.typeName), color: yellow },

    { tag: tags.variableName, color: blue },
    { tag: tags.propertyName, color: blue },
    { tag: tags.definition(tags.propertyName), color: blue },

    { tag: tags.meta, color: aqua },
    { tag: tags.processingInstruction, color: aqua },

    { tag: tags.operator, color: aqua },
    { tag: tags.regexp, color: aqua },

    { tag: tags.punctuation, color: fgMuted },
    { tag: tags.paren, color: fgMuted },
    { tag: tags.brace, color: fgMuted },
    { tag: tags.squareBracket, color: fgMuted },

    { tag: tags.heading, color: green, fontWeight: "bold" },
    { tag: tags.link, color: blue, textDecoration: "underline" },
    { tag: tags.url, color: blue, textDecoration: "underline" },
  ]);

  return [theme, syntaxHighlighting(highlighting)];
}
