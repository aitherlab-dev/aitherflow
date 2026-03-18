import { memo, useRef, useEffect, useCallback } from "react";
import { EditorView, lineNumbers, highlightActiveLineGutter, drawSelection, keymap, highlightActiveLine } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
import { foldGutter, indentOnInput, bracketMatching } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { xml } from "@codemirror/lang-xml";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { createTheme } from "./codemirrorTheme";
import type { Extension } from "@codemirror/state";

interface CodeEditorProps {
  content: string;
  language: string | null;
  readOnly?: boolean;
  onChange?: (content: string) => void;
  onSave?: () => void;
}

function getLanguageExtension(lang: string | null): Extension[] {
  switch (lang) {
    case "typescript":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "jsx":
      return [javascript({ jsx: true })];
    case "javascript":
      return [javascript()];
    case "rust":
      return [rust()];
    case "json":
      return [json()];
    case "markdown":
      return [markdown()];
    case "css":
      return [css()];
    case "xml":
    case "html":
      return [xml()];
    case "python":
      return [python()];
    case "sql":
      return [sql()];
    case "yaml":
    case "toml":
    case "ini":
      return [yaml()];
    default:
      return [];
  }
}

export const CodeEditor = memo(function CodeEditor({
  content,
  language,
  readOnly = false,
  onChange,
  onSave,
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const suppressRef = useRef(false);
  const themeCompartmentRef = useRef(new Compartment());
  const contentRef = useRef(content);

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  contentRef.current = content;

  const createEditor = useCallback(() => {
    if (!containerRef.current) return;

    // Destroy previous instance
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    const themeCompartment = themeCompartmentRef.current;

    const saveKeymap = keymap.of([
      {
        key: "Ctrl-s",
        run: () => {
          onSaveRef.current?.();
          return true;
        },
      },
    ]);

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && !suppressRef.current) {
        onChangeRef.current?.(update.state.doc.toString());
      }
    });

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      foldGutter(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      EditorView.lineWrapping,
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      saveKeymap,
      updateListener,
      EditorState.readOnly.of(readOnly),
      ...getLanguageExtension(language),
      themeCompartment.of(createTheme()),
    ];

    const state = EditorState.create({
      doc: contentRef.current,
      extensions,
    });

    viewRef.current = new EditorView({
      state,
      parent: containerRef.current,
    });
  }, [language, readOnly]);

  // Create editor on mount, recreate on language/readOnly change
  useEffect(() => {
    createEditor();
    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, [createEditor]);

  // Watch for theme changes (data-theme attribute on <html>)
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: themeCompartmentRef.current.reconfigure(createTheme()),
      });
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => observer.disconnect();
  }, []);

  // Update content when prop changes externally
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (currentDoc === content) return;

    suppressRef.current = true;
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: content,
      },
    });
    suppressRef.current = false;
  }, [content]);

  return <div ref={containerRef} className="fv-code-editor" />;
});
