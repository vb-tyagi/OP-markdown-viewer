// Entry point for the vendored editor bundle. Everything the app needs from ProseMirror and
// markdown-it is re-exported here and bundled into public/vendor/editor-bundle.js by
// scripts/build-editor.mjs. The bundle is committed; the app has no runtime dependencies.
export { Schema, Node, Mark, Fragment, Slice, DOMParser, DOMSerializer } from 'prosemirror-model';
export { EditorState, Plugin, PluginKey, Selection, TextSelection, NodeSelection, AllSelection } from 'prosemirror-state';
export { EditorView } from 'prosemirror-view';
export {
  baseKeymap, toggleMark, setBlockType, wrapIn, lift, chainCommands, exitCode,
  joinUp, joinDown, selectParentNode, createParagraphNear, liftEmptyBlock, splitBlock, newlineInCode, deleteSelection, joinBackward, selectNodeBackward,
} from 'prosemirror-commands';
export { history, undo, redo, undoDepth, redoDepth } from 'prosemirror-history';
export { keymap } from 'prosemirror-keymap';
export { inputRules, wrappingInputRule, textblockTypeInputRule, InputRule, undoInputRule } from 'prosemirror-inputrules';
export { wrapInList, splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
export {
  schema as markdownSchema, MarkdownParser, MarkdownSerializer, MarkdownSerializerState,
  defaultMarkdownParser, defaultMarkdownSerializer,
} from 'prosemirror-markdown';
export { default as markdownit } from 'markdown-it';
