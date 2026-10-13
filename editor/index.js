// Source for public/vendor/editor.js (build with `npm run build:editor`).
// Exposes window.NocEditor.create(element, options) -> editor handle.

import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { indentUnit, StreamLanguage } from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { oneDark } from '@codemirror/theme-one-dark';
import { setDiagnostics, lintGutter } from '@codemirror/lint';

function languageFor(lang) {
  return lang === 'bash' ? StreamLanguage.define(shell) : python();
}

function create(parent, { doc = '', language = 'python', readOnly = false, onChange, onSave } = {}) {
  const lang = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        basicSetup,
        lintGutter(),
        oneDark,
        indentUnit.of(language === 'bash' ? '  ' : '    '),
        lang.of(languageFor(language)),
        EditorState.readOnly.of(readOnly),
        keymap.of([
          indentWithTab,
          { key: 'Mod-s', preventDefault: true, run: () => (onSave && onSave(), true) },
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && onChange) onChange(u.state.doc.toString());
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px' },
          '.cm-scroller': { fontFamily: '"JetBrains Mono", ui-monospace, monospace', lineHeight: '1.6' },
        }),
      ],
    }),
  });

  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
    focus: () => view.focus(),
    // Mark a 1-based line as an error (or clear with null).
    setError(line, message) {
      if (!line || line > view.state.doc.lines) {
        view.dispatch(setDiagnostics(view.state, []));
        return;
      }
      const l = view.state.doc.line(line);
      view.dispatch(setDiagnostics(view.state, [{ from: l.from, to: l.to, severity: 'error', message }]));
      view.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
    },
  };
}

window.NocEditor = { create };
