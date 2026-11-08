import {
  EditorSelection,
  EditorState,
  type Extension,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { vi } from 'vitest';

export class StateBackedEditorView {
  state: EditorState;
  private readonly updateListeners: Array<(update: ViewUpdate) => void> = [];
  private readonly history: Array<{ startState: EditorState; transaction: Transaction }> = [];
  readonly dispatch = vi.fn((spec: TransactionSpec) => {
    this.apply(spec, true);
  });

  constructor(
    documentText: string,
    options: { extensions?: Extension; selectionHead?: number } = {},
  ) {
    this.state = EditorState.create({
      doc: documentText,
      extensions: options.extensions ?? [],
      selection: EditorSelection.cursor(options.selectionHead ?? 0),
    });
    this.updateListeners.push(...this.state.facet(EditorView.updateListener));
  }

  undo(): boolean {
    const previous = this.history.pop();
    if (previous === undefined) return false;
    const transaction = this.state.update({
      changes: previous.transaction.changes.invert(previous.startState.doc),
      selection: previous.startState.selection,
    });
    this.state = transaction.state;
    this.notify(transaction, previous.startState);
    return true;
  }

  private apply(spec: TransactionSpec, record: boolean): void {
    const startState = this.state;
    const transaction = startState.update(spec);
    this.state = transaction.state;
    if (record && transaction.docChanged) this.history.push({ startState, transaction });
    this.notify(transaction, startState);
  }

  private notify(transaction: Transaction, startState: EditorState): void {
    const update = {
      changes: transaction.changes,
      docChanged: transaction.docChanged,
      startState,
      transactions: [transaction],
      view: this,
    } as unknown as ViewUpdate;
    for (const listener of this.updateListeners) listener(update);
  }
}
