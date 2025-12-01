import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import EncryptedBlockComponent from '../EncryptedBlockComponent'

export default Node.create({
  name: 'encryptedBlock',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      ciphertext: {
        default: '',
      },
      createdBy: {
        default: null,
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'encrypted-block',
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['encrypted-block', mergeAttributes(HTMLAttributes)]
  },

  addNodeView() {
    return ReactNodeViewRenderer(EncryptedBlockComponent)
  },
})
