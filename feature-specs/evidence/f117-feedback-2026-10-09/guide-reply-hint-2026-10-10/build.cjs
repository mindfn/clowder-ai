const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
const esbuild = require(path.join(root, 'node_modules/esbuild'));
const out = '/tmp/f117-guide-preview';
const cats = [
  ['a', 'A', true],
  ['b', 'B', false],
  ['c', 'C', true],
  ['d', 'D', true],
].map(([id, displayName, guideReply]) => ({
  id,
  displayName,
  mentionPatterns: [],
  clientId: 'codex',
  carrier: 'codex_app_server',
  defaultModel: 'test',
  avatar: '',
  color: { primary: '#3f8552', secondary: '#f7f2ea' },
  roleDescription: '',
  personality: '',
  messageDeliveryCapabilities: { guideReply },
}));
fs.writeFileSync(
  path.join(out, 'entry.tsx'),
  `import React from 'react'; import {createRoot} from 'react-dom/client'; import {ChatInput} from '${root}/packages/web/src/components/ChatInput'; import {useChatStore} from '${root}/packages/web/src/stores/chatStore';
const variant = new URLSearchParams(location.search).get('case')||'mixed';
const ids = variant==='none'?['b']:variant==='idle'?[]:['a','b','c'];
window.fetch=async()=>new Response(JSON.stringify({productDefault:'next_work',global:null,thread:variant==='next'?'next_work':'continue_current',effective:variant==='next'?'next_work':'continue_current',source:'thread'}),{status:200});
useChatStore.setState({currentThreadId:'preview',targetCats:ids,hasActiveInvocation:ids.length>0,activeInvocations:Object.fromEntries(ids.map(id=>['inv-'+id,{catId:id,mode:'execute'}])),catInvocations:{}});
createRoot(document.getElementById('root')!).render(<ChatInput threadId="preview" onSend={()=>true}/>);
setTimeout(()=>{ const ta=document.querySelector('textarea')!; document.getElementById('receipt')!.textContent=JSON.stringify({variant,placeholder:ta.placeholder,banner:!!document.querySelector('[data-testid="active-invocation-banner"]'),stop:!!document.querySelector('[aria-label="Stop generation"]')}); },1000);`,
);
const plugin = {
  name: 'fixture-data',
  setup(build) {
    build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'fixture' }));
    build.onResolve({ filter: /^@\/hooks\/useCatData$/ }, () => ({ path: 'cats', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
      contents:
        args.path === 'navigation'
          ? `export const useRouter=()=>({push(){}}); export const usePathname=()=>'/'; export const useSearchParams=()=>new URLSearchParams();`
          : `const cats=${JSON.stringify(cats)}; export const useCatData=()=>({cats,isLoading:false,hasFetched:true,getCatById:id=>cats.find(c=>c.id===id),getCatsByBreed:()=>new Map(),refresh:async()=>cats}); export const formatCatName=cat=>cat.displayName; export const getCachedCats=()=>cats;`,
      loader: 'js',
    }));
  },
};
esbuild.build({
  entryPoints: [path.join(out, 'entry.tsx')],
  outfile: path.join(out, 'bundle.js'),
  bundle: true,
  platform: 'browser',
  jsx: 'automatic',
  absWorkingDir: root,
  tsconfig: path.join(root, 'packages/web/tsconfig.json'),
  nodePaths: [path.join(root, 'packages/web/node_modules'), path.join(root, 'node_modules')],
  define: { 'process.env': '{}', 'process.env.NODE_ENV': '"test"', 'process.env.NEXT_PUBLIC_API_URL': '""' },
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
  plugins: [plugin],
});
