
import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';

const jsonContent = {"type":"doc","content":[{"type":"paragraph","attrs":{"textAlign":null},"content":[{"type":"text","text":"Hello world"}]}]};

try {
  console.log('Testing TiptapTransformer...');
  const doc = TiptapTransformer.toYdoc(jsonContent, 'default');
  console.log('toYdoc success');
  
  const update = Y.encodeStateAsUpdate(doc);
  console.log('encodeStateAsUpdate success, length:', update.length);

  const doc2 = new Y.Doc();
  Y.applyUpdate(doc2, update);
  const json2 = TiptapTransformer.fromYdoc(doc2, 'default');
  console.log('Round trip JSON:', JSON.stringify(json2));

} catch (e) {
  console.error('Error:', e);
}
