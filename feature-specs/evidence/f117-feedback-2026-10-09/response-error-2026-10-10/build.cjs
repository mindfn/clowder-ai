const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
const esbuild = require(path.join(root, 'node_modules/esbuild'));
const out = '/tmp/f117-error-preview';
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
